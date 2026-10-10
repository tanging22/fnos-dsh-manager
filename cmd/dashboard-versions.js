/**
 * Version management: list what npm offers, install a chosen version into
 * `${DATA_DIR}/versions/<version>`, and pin one as `current`.
 *
 * Version selection is the whole point of this panel, so installs are explicit
 * and never prune what another version might still need.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareVersions,
  existsSync as fileExists,
  joinUrl,
  npmBin,
  npmEnv as npmEnvShared,
  runWithTimeout,
} from './dashboard-utils.js'
import {
  DATA_DIR,
  DSH_PACKAGE,
  NODE_MODULES_DSH,
  VERSIONS_DIR,
  invalidateVersionsCache,
  listInstalledVersions,
  loadConfig,
  versionDir,
  versionDirSizes,
  writePinnedVersion,
  readPinnedVersion,
  clearPinnedVersion,
  activeDshVersion,
} from './dashboard-config.js'

const CACHE_PATH = join(DATA_DIR, 'versions-cache.json')
const CACHE_TTL_MS = 30 * 60 * 1000

/** npm registry configured in the panel. */
function registry() {
  return (loadConfig().install?.npmRegistry || 'https://registry.npmjs.org').replace(/\/+$/, '')
}

/** Extra args so an operator can point installs at a mirror or a proxy. */
function npmEnv() {
  return npmEnvShared(loadConfig().install?.proxy)
}

function npmArgs(subcommand, args = []) {
  // `--loglevel error` silences everything during a normal install, which also
  // means the live progress log stays empty. Use `http` so npm streams "fetching
  // package X" lines that the UI can show, without dumping the full debug tree.
  const base = [subcommand, '--registry', registry(), '--no-audit', '--no-fund', '--loglevel', 'http', '--foreground-scripts', '--progress', 'false']
  return [...base, ...args]
}
/** Ask the registry for every published version, newest first. */
export async function fetchAvailableVersions({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return { ...cached, cached: true }
    } catch { /* fall through to network */ }
  }

  // Scoped packages keep their slash: the registry path is /@scope/name, and
  // encodeURIComponent would turn both separators into escapes npm won't match.
  const packagePath = DSH_PACKAGE.startsWith('@')
    ? `${DSH_PACKAGE.slice(0, DSH_PACKAGE.indexOf('/'))}/${encodeURIComponent(DSH_PACKAGE.slice(DSH_PACKAGE.indexOf('/') + 1))}`
    : encodeURIComponent(DSH_PACKAGE)
  const url = joinUrl(registry(), `/${packagePath}`)
  const result = await runWithTimeout(process.execPath, [
    '-e',
    `
    const url = process.argv[1];
    fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(doc => {
        const versions = Object.keys(doc.versions || {});
        const latest = doc['dist-tags']?.latest;
        process.stdout.write(JSON.stringify({ versions, latest }));
      })
      .catch(e => { process.stderr.write(e.message); process.exit(1); });
    `,
    url,
  ], 25000, { env: await npmEnv() })

  if (result.code !== 0) {
    return { versions: [], latest: null, error: (result.stderr || 'registry-unreachable').trim().slice(0, 400) }
  }

  let parsed = { versions: [], latest: null }
  try { parsed = JSON.parse(result.stdout) } catch { return { versions: [], latest: null, error: 'bad-registry-payload' } }

  const versions = [...(parsed.versions ?? [])].sort(compareVersions).reverse()
  const payload = { versions, latest: parsed.latest ?? versions[0] ?? null, fetchedAt: Date.now() }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {}
  return { ...payload, cached: false }
}

/**
 * Install one exact version into its own directory.
 * A `package.json` is written so npm resolves into that directory rather than
 * walking up and finding an unrelated lockfile.
 */
export async function installVersion(version, { onProgress } = {}) {
  if (!version) return { ok: false, error: 'missing-version' }
  const safe = String(version).replace(/[^\w.+-]/g, '_')
  const dir = versionDir(safe)
  if (!dir) return { ok: false, error: 'bad-version' }

  mkdirSync(dir, { recursive: true })
  const packagePath = join(dir, 'package.json')
  if (!fileExists(packagePath)) {
    writeFileSync(packagePath, `${JSON.stringify({
      name: 'dsh-console-version',
      private: true,
      version: '1.0.0',
      dependencies: { [DSH_PACKAGE]: version },
    }, null, 2)}\n`, 'utf8')
  } else {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [DSH_PACKAGE]: version }
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    } catch { /* keep whatever is there; npm will report the real problem */ }
  }

  onProgress?.({ phase: 'installing', version })
  // Stream npm's output so the UI can show live progress instead of a spinner.
  let log = ''
  const result = await runWithTimeout(npmBin(), npmArgs('install', ['--prefix', dir]), 20 * 60 * 1000, {
    env: await npmEnv(),
    cwd: dir,
    onData: (chunk) => {
      log = (log + chunk).slice(-2000)
      onProgress?.({ phase: 'installing', version, log })
    },
  })

  const bin = join(dir, NODE_MODULES_DSH, 'lib/bin.js')
  if (result.code !== 0 || !fileExists(bin)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    return {
      ok: false,
      error: 'install-failed',
      detail: (result.stderr || result.stdout || '').trim().slice(-2000),
    }
  }

  // Peer-dependency audit: npm 7+ installs peers automatically, but an old
  // npm, a partial mirror, or an interrupted install can silently skip some.
  // dsh's boot() silently no-ops (exit 0, zero output) when the cordis loader
  // peer is missing, so a version that looks installed can still never start.
  // Verify all non-optional peers; repair by installing exactly what's absent.
  const audit = await verifyPeerDependencies(dir, { onProgress })
  if (!audit.ok) {
    onProgress?.({ phase: 'repairing-peers', version, missing: audit.missing })
    const repair = await runWithTimeout(npmBin(), npmArgs('install', [
      '--prefix', dir,
      ...audit.missing.map((entry) => `${entry.name}@${entry.range}`),
    ]), 20 * 60 * 1000, { env: await npmEnv() })
    const recheck = await verifyPeerDependencies(dir, { onProgress })
    if (!recheck.ok) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      return {
        ok: false,
        error: 'peer-dependencies-incomplete',
        detail: `missing: ${recheck.missing.map((m) => `${m.name}@${m.range} (from ${m.from})`).join(', ')}; repair output: ${(repair.stderr || repair.stdout || '').trim().slice(-800)}`,
      }
    }
    onProgress?.({ phase: 'installing', version, log: `peer 依赖补装完成 (${audit.missing.length} 个)` })
  }

  await pruneVersions()
  // The tree exists now, so the memoised listing is stale in both directions.
  invalidateVersionsCache()
  return { ok: true, version: readInstalledVersion(dir) ?? safe, dir }
}

/**
 * Walk the whole installed tree and verify every non-optional peerDependency
 * is present. `peerDependenciesMeta[name].optional === true` entries (bufferutil
 * etc.) are exempt, matching npm's own semantics.
 */
async function verifyPeerDependencies(dir, { onProgress } = {}) {
  const nm = join(dir, 'node_modules')
  const seen = new Set()
  const missing = []
  const queue = [join(dir, NODE_MODULES_DSH)]
  while (queue.length) {
    const pkgDir = queue.shift()
    const pkgJson = join(pkgDir, 'package.json')
    if (!fileExists(pkgJson) || seen.has(pkgDir)) continue
    seen.add(pkgDir)
    let pkg
    try { pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) } catch { continue }
    const peers = pkg.peerDependencies ?? {}
    const meta = pkg.peerDependenciesMeta ?? {}
    for (const [name, range] of Object.entries(peers)) {
      if (meta[name]?.optional) continue
      const peerDir = join(nm, ...name.split('/'))
      if (!fileExists(join(peerDir, 'package.json'))) missing.push({ from: pkg.name, name, range })
      else queue.push(peerDir)
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const depDir = join(nm, ...name.split('/'))
      if (fileExists(join(depDir, 'package.json'))) queue.push(depDir)
    }
  }
  return { ok: missing.length === 0, missing, scanned: seen.size }
}

function readInstalledVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, NODE_MODULES_DSH, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/** Point `current` at an already-installed version. */
export function switchVersion(version) {
  const installed = listInstalledVersions()
  const match = installed.find((entry) => entry.version === version)
  if (!match) return { ok: false, error: 'not-installed' }
  writePinnedVersion(match.version)
  return { ok: true, version: match.version, dir: match.dir, restartRequired: true }
}

export function currentVersion() {
  const pinned = readPinnedVersion()
  const installed = listInstalledVersions()
  if (pinned && installed.some((entry) => entry.version === pinned)) return pinned
  return installed[0]?.version ?? null
}

/**
 * Delete one installed dsh version.
 *
 * Refuses the version dsh is currently running from: removing the tree out from
 * under a live process leaves the panel pointing at a directory that no longer
 * exists, and the next start fails with a missing `bin.js` instead of a clear
 * error. Switch away first.
 *
 * Also refuses to empty the list — with nothing installed the panel cannot
 * start dsh at all, and there would be no way back from the UI.
 */
export function removeVersion(version) {
  const installed = listInstalledVersions()
  const match = installed.find((entry) => entry.version === version)
  if (!match) return { ok: false, error: 'not-installed' }
  if (installed.length <= 1) return { ok: false, error: 'last-version' }

  const active = activeDshVersion()
  if (active && active === match.version) {
    return { ok: false, error: 'in-use', version, hint: 'switch to another version first' }
  }

  try {
    rmSync(match.dir, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
  invalidateVersionsCache()

  // A pinned version that no longer exists would be reported as "active" by
  // currentVersion() forever, so drop the pin with it.
  if (readPinnedVersion() === match.version) clearPinnedVersion()
  return { ok: true, version: match.version }
}

/** Remove old versions, keeping the configured count plus whatever is current. */
export async function pruneVersions() {
  const keep = Math.max(1, Number(loadConfig().versions?.keep ?? 3))
  const pinned = readPinnedVersion()
  const installed = listInstalledVersions()
  const keepSet = new Set(installed.slice(0, keep).map((entry) => entry.version))
  if (pinned) keepSet.add(pinned)
  const removed = []
  for (const entry of installed) {
    if (keepSet.has(entry.version)) continue
    try {
      rmSync(entry.dir, { recursive: true, force: true })
      removed.push(entry.version)
    } catch { /* locked or missing; leave it */ }
  }
  if (removed.length) invalidateVersionsCache()
  return removed
}

/** Everything the Versions tab renders in one call. */
export async function versionState({ force = false } = {}) {
  const installed = listInstalledVersions()
  const remote = await fetchAvailableVersions({ force })
  const pinned = readPinnedVersion()
  // Tree sizes are computed here, for this request only — the hot paths
  // (/api/status, /api/logs) deliberately do not pay for them.
  const sizes = versionDirSizes()
  return {
    current: currentVersion(),
    pinned,
    installed: installed.map((entry) => ({
      ...entry,
      sizeBytes: sizes[entry.version] ?? null,
      current: entry.version === pinned,
    })),
    available: (remote.versions ?? []).slice(0, 40),
    latest: remote.latest ?? null,
    fetchedAt: remote.fetchedAt ?? null,
    cached: Boolean(remote.cached),
    error: remote.error ?? null,
    keep: loadConfig().versions?.keep ?? 3,
    registry: registry(),
  }
}

export { CACHE_PATH }
