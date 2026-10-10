/**
 * Plugin management for the supervised dsh profile.
 *
 * dsh has no `dsh plugin` CLI; plugin lifecycle lives in the host's
 * plugin-manager service, which edits two files and runs pnpm:
 *   - the profile `package.json` (`dsh.profile.bundles` array + `dependencies`)
 *   - the profile `cordis.patch.yml` (a YAML array of `{id, disabled}` entries)
 *
 * This panel is *not* the dsh host, so it cannot reload a live profile. What it
 * can do — and all the operator needs — is edit those same files on disk and
 * restart dsh to apply them. `npm` is used instead of pnpm because the panel
 * already proves npm works on the box (version installs use it) and the profile
 * uses `nodeLinker: hoisted`, which both package managers honor.
 *
 * Profile layout (see app-boot/src/profile.ts):
 *   profileDir = `${activeDshHome()}/profiles/web`
 *   package.json: { name, private, dependencies: {}, dsh: { profile: { bundles: [] } } }
 *   cordis.patch.yml: a YAML sequence; each element is a map with `id`, optional
 *     `name`, `disabled`, `insert`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { activeDshHome, npmBin, npmEnv as npmEnvShared, runWithTimeout } from './dashboard-utils.js'
import { loadConfig, DSH_PACKAGE } from './dashboard-config.js'

/** Default market plugin (the dsh-market plugin manager). */
export const MARKET_PACKAGE = 'dshmarket'

/** The profile this panel manages plugins for. */
export function profileDir() {
  return join(activeDshHome(), 'profiles', 'web')
}

export function profilePackagePath() {
  return join(profileDir(), 'package.json')
}

export function profilePatchPath() {
  return join(profileDir(), 'cordis.patch.yml')
}

/** The name npm knows a scoped package by (e.g. `dshmarket`). */
function shortName(pkg) {
  const name = String(pkg || '')
  const slash = name.lastIndexOf('/')
  return slash >= 0 ? name.slice(slash + 1) : name
}

/** Directory npm hoists the package to. */
function installedDir(pkg) {
  return join(profileDir(), 'node_modules', pkg)
}

// ---------------------------------------------------------------------------
// Registry inspection (same `node -e fetch` pattern as dashboard-versions.js)
// ---------------------------------------------------------------------------

function registry() {
  return (loadConfig().install?.npmRegistry || 'https://registry.npmjs.org').replace(/\/+$/, '')
}

function npmEnv() {
  return npmEnvShared(loadConfig().install?.proxy)
}

/** Resolve a package spec to its name + latest version via the registry. */
export async function inspectPackage(spec) {
  const specName = String(spec || '').trim()
  if (!specName) return { ok: false, error: 'missing-package' }

  // A scoped package keeps its slash in the registry path.
  const packagePath = specName.startsWith('@')
    ? `${specName.slice(0, specName.indexOf('/'))}/${encodeURIComponent(specName.slice(specName.indexOf('/') + 1))}`
    : encodeURIComponent(specName)

  const url = `${registry()}/${packagePath}`
  const result = await runWithTimeout(process.execPath, [
    '-e',
    `
    const url = process.argv[1];
    fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(doc => process.stdout.write(JSON.stringify({
        name: doc.name,
        latest: doc['dist-tags'] && doc['dist-tags'].latest,
        versions: Object.keys(doc.versions || {}),
        description: doc.description || ''
      })))
      .catch(e => { process.stderr.write(e.message); process.exit(1); });
    `,
    url,
  ], 25000, { env: await npmEnv() })

  if (result.code !== 0) {
    return { ok: false, error: 'registry-unreachable', detail: (result.stderr || '').trim().slice(0, 400) }
  }
  try {
    const info = JSON.parse(result.stdout)
    return { ok: true, name: info.name, latest: info.latest, versions: info.versions ?? [], description: info.description }
  } catch {
    return { ok: false, error: 'bad-registry-payload' }
  }
}

// ---------------------------------------------------------------------------
// Profile manifest read/write
// ---------------------------------------------------------------------------

function readProfilePackage() {
  try {
    return JSON.parse(readFileSync(profilePackagePath(), 'utf8'))
  } catch {
    return { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  }
}

function writeProfilePackage(pkg) {
  mkdirSync(dirname(profilePackagePath()), { recursive: true })
  writeFileSync(profilePackagePath(), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function readBundles(pkg) {
  return pkg?.dsh?.profile?.bundles ?? []
}

function writeBundles(pkg, bundles) {
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = bundles
  writeProfilePackage(pkg)
}

/** Is this bundle currently selected (active) in the profile? */
function bundleEnabled(pkg, name) {
  return readBundles(pkg).includes(name)
}

/** Is the package physically installed under the profile's node_modules? */
function bundleInstalled(name) {
  return existsSync(join(installedDir(name), 'package.json'))
}

/** Read the installed package's own manifest (for version + description). */
function installedManifest(name) {
  try {
    return JSON.parse(readFileSync(join(installedDir(name), 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// cordis.patch.yml editing (line-level, mirrors writePluginEnabled semantics)
// ---------------------------------------------------------------------------

/**
 * Read the patch file as an array of YAML maps. Entries are line groups:
 * each `- id: <x>` (or `-` then `id:` on the next line) starts one entry.
 */
function readPatchEntries() {
  const entries = []
  let text = ''
  try {
    text = readFileSync(profilePatchPath(), 'utf8')
  } catch {
    return { entries, text: '' }
  }
  const lines = text.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const start = /^-\s*id:\s*(\S+)/.exec(line)
    if (start) {
      if (current) entries.push(current)
      current = { id: start[1], lines: [line] }
      continue
    }
    if (/^-\s*$/.test(line.trim())) {
      // A bare `-` may open a map whose `id:` follows on the next line.
      if (current) entries.push(current)
      current = { id: null, lines: [line] }
      continue
    }
    if (current) {
      current.lines.push(line)
      const idLine = /^\s*id:\s*(\S+)/.exec(line)
      if (idLine && current.id === null) current.id = idLine[1]
    }
  }
  if (current) entries.push(current)
  return { entries, text }
}

function renderPatchEntries(entries, text) {
  // Preserve any header comment (lines before the first entry / `[]`).
  const headerLines = []
  const body = text.split(/\r?\n/)
  for (const line of body) {
    const trimmed = line.trim()
    if (/^-\s*id:/.test(trimmed) || trimmed === '-' || trimmed === '[]') break
    headerLines.push(line)
  }
  const rendered = entries.flatMap((entry) => entry.lines)
  const header = headerLines.join('\n')
  const bodyText = rendered.join('\n')
  if (!header.trim()) return `${bodyText}\n`
  return `${header}\n${bodyText}\n`
}

/**
 * Set a plugin entry's `disabled` state. `id` is the composition entry id (the
 * loader row id), `name` the module name. Mirrors
 * `writePluginEnabled(patch.ts)` but keeps the edit line-level and dependency-free.
 */
export function setPluginEnabled(id, name, enabled) {
  const { entries, text } = readPatchEntries()
  // Find the last matching override: an entry with this id, no `insert`, and a
  // matching (or absent) `name`.
  let target = null
  for (const entry of entries) {
    if (!entry.id || entry.id !== id) continue
    if (entry.lines.some((line) => /^\s*insert:/.test(line))) continue
    const nameLine = entry.lines.find((line) => /^\s*name:/.test(line))
    const entryName = nameLine ? /^\s*name:\s*(\S+)/.exec(nameLine)?.[1] : null
    if (entryName && entryName !== name) continue
    target = entry
  }

  if (target) {
    // Toggle the `disabled:` line in place, or add one.
    const idx = target.lines.findIndex((line) => /^\s*disabled:/.test(line))
    if (idx >= 0) {
      target.lines[idx] = `  disabled: ${enabled ? 'false' : 'true'}`
    } else {
      // Insert after the last field of the entry.
      let insertAt = target.lines.length
      for (let i = target.lines.length - 1; i >= 0; i -= 1) {
        if (!/^\s*$/.test(target.lines[i])) { insertAt = i + 1; break }
      }
      target.lines.splice(insertAt, 0, `  disabled: ${enabled ? 'false' : 'true'}`)
    }
  } else if (!enabled) {
    // No override yet and disabling: append a new entry.
    entries.push({ id, lines: [`- id: ${id}`, `  disabled: true`] })
  }
  // Enabling a plugin with no existing override = nothing to write.

  const out = renderPatchEntries(entries, text)
  mkdirSync(dirname(profilePatchPath()), { recursive: true })
  writeFileSync(profilePatchPath(), out, 'utf8')
  return { ok: true, changed: Boolean(target) || !enabled }
}

// ---------------------------------------------------------------------------
// Bundle install / remove
// ---------------------------------------------------------------------------

function npmArgs(subcommand, args = []) {
  // Same as versions: `http` level streams "fetching package X" lines for the
  // live progress log instead of staying silent until the install completes.
  return [subcommand, '--registry', registry(), '--no-audit', '--no-fund', '--loglevel', 'http', '--foreground-scripts', '--progress', 'false', ...args]
}

/** Install a bundle into the profile and select it. */
export async function installBundle(spec, { onProgress } = {}) {
  const name = String(spec || '').trim()
  if (!name) return { ok: false, error: 'missing-package' }

  // Registry inspection: normalize `name@version` and validate the package exists.
  const inspect = await inspectPackage(name)
  if (!inspect.ok) return inspect
  const installSpec = name.includes('@') && !name.startsWith('@') ? name : `${inspect.name}@${inspect.latest}`

  const dir = profileDir()
  mkdirSync(dir, { recursive: true })

  const pkg = readProfilePackage()
  if (bundleInstalled(inspect.name)) {
    // Reinstall = upgrade to the requested version.
    onProgress?.({ phase: 'upgrading', name: inspect.name })
  } else {
    onProgress?.({ phase: 'installing', name: inspect.name })
  }

  let log = ''
  const result = await runWithTimeout(npmBin(), npmArgs('install', ['--prefix', dir, installSpec]), 20 * 60 * 1000, {
    env: await npmEnv(),
    cwd: dir,
    onData: (chunk) => {
      log = (log + chunk).slice(-2000)
      onProgress?.({ phase: 'installing', name: inspect.name, log })
    },
  })

  if (result.code !== 0 || !bundleInstalled(inspect.name)) {
    return {
      ok: false,
      error: 'install-failed',
      detail: (result.stderr || result.stdout || '').trim().slice(-2000),
    }
  }

  // Add to dependencies + bundles so dsh selects it on next start.
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dependencies[inspect.name] = `^${inspect.latest}`
  const bundles = readBundles(pkg)
  if (!bundles.includes(inspect.name)) bundles.push(inspect.name)
  writeBundles(pkg, bundles)

  return { ok: true, name: inspect.name, version: inspect.latest, restartRequired: true }
}

/** Remove a bundle: deselect, then uninstall the package. */
export async function removeBundle(name) {
  const pkg = readProfilePackage()
  const bundles = readBundles(pkg).filter((entry) => entry !== name)
  writeBundles(pkg, bundles)

  const dir = profileDir()
  const result = await runWithTimeout(npmBin(), npmArgs('remove', ['--prefix', dir, name]), 10 * 60 * 1000, {
    env: await npmEnv(),
    cwd: dir,
  })
  if (result.code !== 0) {
    return { ok: false, error: 'remove-failed', detail: (result.stderr || '').trim().slice(-2000) }
  }
  // npm may leave a stray dir; clean it defensively.
  try { rmSync(installedDir(name), { recursive: true, force: true }) } catch {}
  return { ok: true, name, restartRequired: true }
}

/** Toggle a bundle's selection (enable/disable) without touching the install. */
export function setBundleEnabled(name, enabled) {
  const pkg = readProfilePackage()
  const bundles = readBundles(pkg)
  const has = bundles.includes(name)
  if (enabled && !has) bundles.push(name)
  if (!enabled && has) {
    const idx = bundles.indexOf(name)
    bundles.splice(idx, 1)
  }
  writeBundles(pkg, bundles)
  return { ok: true, name, enabled, restartRequired: true }
}

// ---------------------------------------------------------------------------
// Read plugin rows from the patch file (what dsh would report as listPlugins)
// ---------------------------------------------------------------------------

/** The enabled/disabled state of a plugin entry, as the patch file records it. */
function patchDisabledState(id) {
  const { entries } = readPatchEntries()
  for (const entry of entries) {
    if (entry.id !== id) continue
    const line = entry.lines.find((l) => /^\s*disabled:/.test(l))
    if (line) return /true/.test(line)
  }
  return false
}

/** Everything the Plugins tab renders in one call. */
export function pluginState() {
  const pkg = readProfilePackage()
  const bundles = readBundles(pkg)
  const dependencies = Object.keys(pkg?.dependencies ?? {})

  // Installed bundles = the union of selected names and declared dependencies.
  const names = [...new Set([...bundles, ...dependencies])]
  const rows = names.map((name) => {
    const manifest = installedManifest(name)
    const installed = dependencies.includes(name) || bundleInstalled(name)
    const enabled = bundles.includes(name)
    return {
      name,
      shortName: shortName(name),
      version: manifest?.version ?? null,
      description: manifest?.description ?? '',
      installed,
      enabled,
      isMarket: name === MARKET_PACKAGE || shortName(name) === MARKET_PACKAGE,
      removable: installed && name !== DSH_PACKAGE,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // Plugin rows recorded in the patch file (explicit enable/disable entries).
  const { entries } = readPatchEntries()
  const pluginRows = entries
    .filter((entry) => entry.id && !entry.lines.some((line) => /^\s*insert:/.test(line)))
    .map((entry) => {
      const nameLine = entry.lines.find((line) => /^\s*name:/.test(line))
      return {
        id: entry.id,
        name: nameLine ? /^\s*name:\s*(\S+)/.exec(nameLine)?.[1] ?? '' : '',
        disabled: entry.lines.some((line) => /^\s*disabled:\s*true/.test(line)),
      }
    })

  return {
    profileDir: profileDir(),
    bundles: rows,
    pluginRows,
    market: {
      package: MARKET_PACKAGE,
      installed: names.some((name) => shortName(name) === MARKET_PACKAGE),
      enabled: bundles.some((name) => shortName(name) === MARKET_PACKAGE),
    },
    restartRequiredHint: 'Changes apply after dsh is restarted.',
  }
}

export { patchDisabledState }
