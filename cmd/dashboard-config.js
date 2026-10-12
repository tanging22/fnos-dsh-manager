/**
 * Panel configuration and deployment-shape resolution.
 *
 * The panel must behave sanely in three deployments:
 *  - **managed**: an existing `dsh` suite is installed at `/var/apps/dsh`; the
 *    panel supervises it and never moves its data.
 *  - **standalone**: no suite exists; the panel owns `${DATA_DIR}/dsh_home` and
 *    runs whichever dsh version the user picked from `${DATA_DIR}/versions`.
 *  - **portable**: an extracted tree (CI smoke test, local dev). Same layout as
 *    standalone, rooted wherever `DATA_DIR` points.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  APP_DIR,
  APP_NAME,
  CONSOLE_APP_DIR,
  CONSOLE_PORT,
  DATA_DIR,
  DSH_HOME,
  DSH_PORT,
  MANIFEST,
  activeDshHome,
  bestNodeBin,
  readManifest,
} from './dashboard-utils.js'

export const CONFIG_PATH = join(DATA_DIR, 'console-config.json')

/**
 * dsh 的 home 相关路径。
 *
 * v1.0.38 把这些路径从模块加载期的常量 `DSH_HOME` 改成全部跟随
 * `activeDshHome()`，与 dsh 启动参数（HOME/DSH_HOME/USERPROFILE 三件套都指向
 * activeDshHome()）同源，修掉了"自愈修 A 目录、dsh 读 B 目录"的不一致。
 *
 * 但那只在 `workspace.active` 缺失或指向默认 home 时与旧版等价。一旦用户切换
 * 过 dsh 版本，`workspace.active` 指向版本目录下的 home，而凭据 / 受信主机 /
 * proxy.conf 是历史版本写在**默认 home** 里的 —— 1.0.38 的面板会去一个空目录里
 * 找它们，用户看到的就是"升级后配置全丢、连不上"。
 *
 * v1.0.39 兜底（对每个文件独立判定，不猜目录）：
 *   active home 有该文件 → 用它（dsh 实际读取的位置，1.0.38 的正确行为）；
 *   只有默认 home 有     → 用它（1.0.37 及之前的行为，"之前是好的"）；
 *   两边都没有           → active home（写入目标 = dsh 读取的位置）。
 * 于是任何"文件只存在于一个 home"的场景，行为都是两个旧版本的并集，不会比
 * 任何一版更差；两边都有时以 active 为准（那才是 dsh 会读的那份）。
 */
function homePath(file) {
  const active = join(activeDshHome(), file)
  if (existsSync(active) || !existsSync(join(DSH_HOME, file))) return active
  return join(DSH_HOME, file)
}

export function credentialsPath() {
  return homePath('.credentials.yaml')
}

export function envPath() {
  return homePath('.env')
}

export function proxyConfPath() {
  return homePath('proxy.conf')
}

export function trustedConfPath() {
  return homePath('trusted_hosts.conf')
}
export const VERSIONS_DIR = join(DATA_DIR, 'versions')
export const CONSOLE_LOG = join(DATA_DIR, 'console.log')

/** Upstream npm package this panel installs and switches between. */
export const DSH_PACKAGE = process.env.DSH_PACKAGE || '@deepseek-ai/dsh'

export const DEFAULTS = {
  mode: 'auto',
  // `lanBind: ''` means *auto*: pick the first non-internal IPv4 at each start.
  // A concrete literal IP pins it to one NIC. dsh >= 0.2.1-alpha.2 refuses
  // wildcards (0.0.0.0 / ::), so loopback is never written as a wildcard.
  lanBind: '',
  install: {
    npmRegistry: process.env.DSH_NPM_REGISTRY || 'https://registry.npmjs.org',
    proxy: '',
  },
  proxy: {
    enabled: true,
    upstreamPort: 0, // resolved at runtime from the managed instance
    host: '0.0.0.0',
    port: 0, // 0 = DSH_PORT + 1
    pathPrefix: '',
  },
  access: {
    trustProxyHeaders: true,
  },
  versions: {
    keep: 3,
  },
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(typeof base?.[key] === 'object' && base?.[key] !== null ? base[key] : {}, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

let configCache = null

/**
 * Parse JSON that may carry `//` / `/* *\/` comments and trailing commas.
 *
 * The installer used to write a commented `console-config.json`. That file is
 * not valid JSON, and `loadConfig()` caught the parse error and fell back to
 * DEFAULTS — so every setting the user chose at install time (LAN binding, npm
 * proxy) silently vanished with nothing in the log. Rather than keep
 * forbidding comments at the writer, accept them here too: a hand-edited config
 * with a comment is a normal thing for an operator to leave behind, and losing
 * their settings to it is worse than tolerating the syntax.
 *
 * Strings are respected while stripping, so a `//` inside a value (a URL, a
 * note) is never mistaken for a comment.
 */
function parseConfigJson(text) {
  try {
    return JSON.parse(text)
  } catch { /* fall through to the lenient parser */ }

  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1 }
      else if (ch === '\n') out += ch // keep line numbers stable for error msgs
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue }
    out += ch
  }

  // Trailing commas (`"a": 1,}`) are the other near-miss people leave behind.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

export function loadConfig() {
  if (configCache) return configCache
  let parsed = {}
  let parseError = ''
  try {
    if (existsSync(CONFIG_PATH)) parsed = parseConfigJson(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    // Unrecoverable (not JSON at all). Record it so the Diagnostics tab can
    // surface the reason instead of the user wondering why settings "reset".
    parseError = error?.message ?? String(error)
    parsed = {}
  }
  configCache = deepMerge(DEFAULTS, parsed)
  // Keep the last failure reachable for runDiagnostics() without re-parsing.
  configCache.__parseError = parseError
  if (parseError) {
    console.warn(`[fnos-dsh-manager] ${CONFIG_PATH} is unreadable (${parseError}); using defaults`)
  }
  return configCache
}

export function saveConfig(next) {
  // Strip the in-memory bookkeeping key before it can reach disk, otherwise
  // every save would bake a `__parseError` field into the user's config.
  const { __parseError, ...clean } = next ?? {}
  const merged = deepMerge(DEFAULTS, clean)
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    // Write `merged`, never `configCache`: the latter carries the bookkeeping key.
    writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch {}
  // Keep the in-memory view in sync with disk, minus the field we just dropped.
  configCache = merged
  configCache.__parseError = ''
  return configCache
}

/**
 * The dsh suite directory we supervise, or `null` when none is installed.
 * fnOS installs to `/var/apps/<app>`, and the real code lives one hop further
 * in (`target/server`) on some deployments, so both are probed.
 */
export function managedAppDir() {
  const candidates = [
    `/var/apps/${APP_NAME}`,
    '/var/apps/deepseek-harness',
    process.env.MANAGED_APP_DIR || '',
  ].filter(Boolean)
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    if (existsSync(join(dir, 'cmd', 'main'))) return dir
    if (existsSync(join(dir, 'target', 'server'))) return dir
  }
  return null
}

/** Resolve `mode: auto` into `managed` or `standalone`. */
export function effectiveMode(config = loadConfig()) {
  if (config.mode === 'managed' || config.mode === 'standalone') return config.mode
  return managedAppDir() ? 'managed' : 'standalone'
}

/** Directory holding a dsh install: the suite's tree, or a downloaded version. */
export function dshRoot() {
  if (effectiveMode() === 'managed') {
    const app = managedAppDir()
    if (!app) return null
    for (const rel of ['target/server', 'server', '.']) {
      const dir = join(app, rel)
      if (existsSync(join(dir, NODE_MODULES_DSH))) return dir
    }
    return null
  }
  const pinned = readPinnedVersion()
  if (pinned) {
    const dir = versionDir(pinned)
    if (dir && existsSync(join(dir, NODE_MODULES_DSH))) return dir
  }
  return currentVersionDir()
}

export function versionDir(version) {
  if (!version) return null
  return join(VERSIONS_DIR, String(version).replace(/[^\w.+-]/g, '_'))
}

/** Path to a dsh package inside an install root, used by every probe below. */
export const NODE_MODULES_DSH = join('node_modules', '@deepseek-ai', 'dsh')

/**
 * Cached view of `${VERSIONS_DIR}`, keyed by the directory listing itself.
 *
 * `listInstalledVersions()` used to be a pure function of the filesystem, but
 * it is called from `/api/status`, `/api/versions`, `/api/logs` and the
 * settings view — every one of them walked every version tree and, worse,
 * measured each tree with a full recursive `dirSize()`. On a real dsh install
 * (tens of thousands of files) that is hundreds of milliseconds of *synchronous*
 * work per request, which blocks the event loop and with it the watchdog, the
 * WebSocket pushes and every other in-flight request.
 *
 * Two changes:
 *  1. the listing is memoised against `${VERSIONS_DIR}`'s own mtime+size, so a
 *     repeat call (the common case: several endpoints in one page load) is a
 *     single `readdirSync`;
 *  2. `sizeBytes` is no longer computed here. It is a display-only number, so it
 *     is computed on demand by {@link versionDirSizes} and left out of the hot
 *     path entirely.
 */
let versionsCache = null
let versionsCacheStamp = ''

/** Cheap fingerprint of VERSIONS_DIR: mtime + entry count. */
function versionsStamp() {
  try {
    const st = statSync(VERSIONS_DIR)
    // mtime alone is not enough on filesystems with coarse timestamps, so the
    // entry count comes along as a second discriminator.
    return `${st.mtimeMs}:${st.size}:${readdirSync(VERSIONS_DIR).length}`
  } catch {
    return 'absent'
  }
}

export function listInstalledVersions({ withSize = false } = {}) {
  const stamp = versionsStamp()
  if (versionsCache && stamp === versionsCacheStamp) return versionsCache

  if (!existsSync(VERSIONS_DIR)) {
    versionsCache = []
    versionsCacheStamp = stamp
    return versionsCache
  }

  const out = []
  for (const entry of readdirSync(VERSIONS_DIR)) {
    const dir = join(VERSIONS_DIR, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch { continue }
    const bin = join(dir, NODE_MODULES_DSH, 'lib/bin.js')
    out.push({
      version: versionOfDir(dir),
      dir,
      bin: existsSync(bin) ? bin : null,
      installedAt: (() => {
        try { return statSync(dir).mtime.toISOString() } catch { return null }
      })(),
      sizeBytes: withSize ? dirSize(dir) : null,
    })
  }
  versionsCache = out.sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)))
  versionsCacheStamp = stamp
  return versionsCache
}

/**
 * Drop the memoised listing. Called after anything that changes the versions
 * directory (install / switch / remove / prune) so the next read is fresh.
 */
export function invalidateVersionsCache() {
  versionsCache = null
  versionsCacheStamp = ''
}

/** Per-version tree sizes, computed only when a view actually renders them. */
export function versionDirSizes() {
  const out = {}
  for (const entry of listInstalledVersions()) {
    out[entry.version] = entry.sizeBytes ?? dirSize(entry.dir)
  }
  return out
}

function versionOfDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, NODE_MODULES_DSH, 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return basename(dir)
  }
}

/**
 * Total bytes under `dir`, reported in KB to match `df`-style figures.
 *
 * Uses `Dirent`s from `readdirSync(withFileTypes)` instead of a `statSync` per
 * entry: the dirent already says whether an entry is a directory, so the common
 * case needs no syscall at all. Only files get stat'ed, and a deeper walk is
 * only done for real directories (the old code also recursed into symlinked
 * dirs, which on a NAS can point back at the parent and never terminate).
 */
function dirSize(dir) {
  let totalKb = 0
  const walk = (current, depth) => {
    if (depth > 8) return
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      // Symlinks report their own tiny size; following them would double-count
      // (or loop) for a package tree that links shared stores.
      if (entry.isSymbolicLink()) continue
      try {
        const st = statSync(full)
        if (st.isFile()) totalKb += Math.ceil(st.size / 1024)
      } catch {}
    }
  }
  walk(dir, 0)
  return totalKb * 1024
}

export function pinnedPath() {
  return join(VERSIONS_DIR, 'current')
}

export function readPinnedVersion() {
  try {
    const raw = readFileSync(pinnedPath(), 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

export function writePinnedVersion(version) {
  mkdirSync(VERSIONS_DIR, { recursive: true })
  writeFileSync(pinnedPath(), `${version}\n`, 'utf8')
}

/**
 * Forget the pinned version.
 *
 * Used when the pinned version is deleted: `readPinnedVersion()` would keep
 * reporting it as active for a directory that no longer exists, and the panel
 * would try to spawn a `bin.js` that is gone.
 */
export function clearPinnedVersion() {
  try {
    rmSync(pinnedPath(), { force: true })
  } catch { /* missing or read-only; nothing to clear */ }
}

export function currentVersionDir() {
  const pinned = readPinnedVersion()
  return pinned ? versionDir(pinned) : null
}

/**
 * The dsh binary: the suite's launcher, or `node <bin.js>` from a version dir.
 * @returns {{bin:string,args:string[]}|null}
 */
export function dshLaunch() {
  if (effectiveMode() === 'managed') {
    const app = managedAppDir()
    if (app) {
      for (const cand of [
        `/var/apps/${APP_NAME}/bin/dsh`,
        join(app, 'bin/dsh'),
        '/usr/local/bin/dsh',
        '/usr/bin/dsh',
      ]) {
        if (existsSync(cand)) return { bin: cand, args: [] }
      }
    }
    // Some suites ship no launcher shim; node can start the CLI directly.
  }
  const root = dshRoot()
  if (!root) return null
  const bin = join(root, NODE_MODULES_DSH, 'lib/bin.js')
  // Run dsh under the newest node the box offers, not the panel's own node:
  // dsh's engines floor rises over releases, and an older node makes the CLI
  // exit silently (no log, no error) — exactly the "已停止无法启动" symptom.
  if (existsSync(bin)) return { bin: bestNodeBin(), args: [bin] }
  return null
}

/**
 * Compare two dsh version strings, semver-style. Returns -1 / 0 / 1.
 *
 * Plain numeric comparison on the release triple, then prerelease handling:
 * a version *with* a prerelease sorts BELOW the same release without one, and
 * two prereleases compare identifier-by-identifier (numeric identifiers sort
 * below alphanumeric ones, which is what makes `alpha.N` < `rc.N` < release).
 *
 * Needed for the version list and switching: dsh releases ship prereleases
 * (alpha/rc) alongside releases, and a plain string compare would sort
 * `0.2.1-rc.1` ABOVE `0.2.1`, making the newest build look like an upgrade to
 * an older one.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value ?? '').trim().replace(/^v/, '')
    const [release = '', pre = ''] = text.split('-')
    const triple = release.split('.').map((part) => (Number.isFinite(Number(part)) ? Number(part) : 0))
    while (triple.length < 3) triple.push(0)
    return { triple, pre: pre ? pre.split('.') : null }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.triple[i] !== right.triple[i]) return left.triple[i] < right.triple[i] ? -1 : 1
  }
  if (!left.pre && !right.pre) return 0
  // A release beats its own prereleases.
  if (!left.pre) return 1
  if (!right.pre) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1
    } else if (ln !== rn) {
      // Numeric identifiers sort below alphanumeric ones.
      return ln ? -1 : 1
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}

/** Version of the dsh install the panel is actually about to launch. */
export function activeDshVersion() {
  const root = dshRoot()
  if (!root) return null
  return versionOfDir(root)
}

/** IPv4 port the managed dsh instance is expected to be serving. */
export function managedPort() {
  const envPort = Number(process.env.DSH_PORT || process.env.MANAGED_SERVICE_PORT)
  if (Number.isFinite(envPort) && envPort > 0) return envPort
  return DSH_PORT
}

/**
 * Log files offered in the Logs tab. Only files inside the data dir are
 * exposed, and the newest few win, so the list stays short on a busy NAS.
 */
export function logFiles() {
  const dirs = [DATA_DIR, join(DATA_DIR, 'logs')]
  // dsh writes its own startup diagnostics to `${DSH_HOME}/logs/startup-*.log`
  // and only falls back to stderr when that write fails (see
  // `reportStartupFailure` in dsh-app-boot). A crash like the disjoint
  // `webserver.host` schema therefore lands in a directory this tab never
  // listed — which is why the operator saw "dsh 无日志输出" while dsh was in
  // fact dying loudly. Surface it here so the next failure is legible.
  dirs.push(join(activeDshHome(), 'logs'))
  for (const entry of listInstalledVersions()) {
    if (entry.dir) dirs.push(join(entry.dir, 'logs'))
  }
  if (effectiveMode() === 'managed') {
    const app = managedAppDir()
    if (app) dirs.push(join(app, 'var'), join(app, 'logs'))
  }
  const out = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(log|txt|out|err)$/i.test(entry.name)) continue
      const full = join(dir, entry.name)
      if (seen.has(full)) continue
      seen.add(full)
      let st
      try { st = statSync(full) } catch { continue }
      out.push({
        name: entry.name,
        path: full,
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      })
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 40)
}

/** `key: value` reader for the tiny YAML dsh writes itself. */
export function readKeyValueFile(path) {
  const out = {}
  try {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/.exec(line.trim())
      if (!match) continue
      out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}

/**
 * LAN reachability.
 *
 * `dsh web` takes no `--host` at all (the panel never passes one), so LAN
 * reachability comes from overriding the `webserver` node in the profile's
 * patch file. Four details matter and all four are load bearing:
 *
 *  - **`0.0.0.0` is dead.** dsh 0.2.1-alpha.2 added a schema guard that rejects
 *    any wildcard address outright (binding every interface would expose RCE to
 *    the network). `host` must be a *concrete* literal IPv4/IPv6 of a local NIC.
 *  - **dsh binds exactly one address.** Binding the LAN IP means loopback stops
 *    answering, which would cut off this panel's own proxy — so whatever host
 *    lands here must also be what proxyToDsh() dials. See webserverHost().
 *  - **The YAML indentation is fixed by the grammar.** In a sequence item, the
 *    mapping's keys must line up with the first key after `- id:`; shipping
 *    4/8 spaces produced `bad indentation of a mapping entry (2:11)` and killed
 *    every start. The block is therefore rewritten whole, never patched in place.
 *  - `port` must be a bare *number*; quoting it fails schema validation.
 */
export function webserverPatchPath() {
  return join(activeDshHome(), 'profiles/web/cordis.patch.yml')
}

export function readWebserverPatch() {
  try {
    return readFileSync(webserverPatchPath(), 'utf8')
  } catch {
    return null
  }
}

/**
 * The `host` under an existing `- id: webserver` block, or `null`.
 *
 * Parsed line-by-line rather than with one multiline regex: the block extends
 * to the next `- ` item or EOF, which a non-greedy `[\s\S]*?` with an `^- id:`
 * lookahead gets wrong once `$`/`^` interaction is involved (it matched nothing
 * on this very file, silently downgrading every caller to loopback).
 */
export function patchHostOf(text) {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^-\s*id:\s*webserver\s*$/.test(line))
  if (start < 0) return null
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) break
    const value = /^\s+host:\s*(\S+)\s*$/.exec(lines[i])
    if (value) return value[1].replace(/^["']|["']$/g, '')
  }
  return null
}

/**
 * The address dsh actually listens on, i.e. what anything dialling it must use.
 *
 * dsh 永远只绑定自己的回环默认值：它各版本 `webserver.host` 的 schema 互不相交
 * （<=0.2.1-alpha.1 只收 "127.0.0.1"|"0.0.0.0"，>=0.2.1-alpha.2 只收具体 IP
 * 字面量并直接拒通配），向它的 profile 写任何 LAN 覆盖都会在换版本时变成必须
 * 手工迁移的遗留物。所以面板不再写这个覆盖，局域网一律走面板自己的反代入口
 * （:28001 的 `/p/` 与 :28000 直连口）。
 *
 * 这里只读**历史版本可能留下**的 patch 文件：若那份遗留覆盖仍在，dsh 就是按
 * 它启动的，必须照它去拨，否则会出现"面板拨回环、dsh 却绑在 LAN IP 上"的
 * dsh-unreachable。没有 patch 就是没有覆盖，回环即正确答案。
 */
export function webserverHost() {
  const written = patchHostOf(readWebserverPatch())
  if (written) return written
  return '127.0.0.1'
}

/**
 * Remove the LAN override so dsh falls back to its own loopback default.
 *
 * The file is DELETED when the webserver block was all it held, rather than
 * rewritten to an empty string: dsh's `parsePatchList` demands a top-level YAML
 * array, and a leftover whitespace-only file fails that check with
 * `must be a top-level YAML array` — killing startup just as dead as the
 * malformed patch this code exists to clean up. A missing file is fine: dsh
 * skips the overlay entirely and binds loopback.
 */
export function clearWebserverPatch() {
  const path = webserverPatchPath()
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (/^- id:\s*webserver\s*$/.test(line)) { skipping = true; continue }
    if (skipping && (/^\s*-\s/.test(line) || /^-\s/.test(line))) skipping = false
    if (skipping) continue
    kept.push(line)
  }
  const body = kept.join('\n').replace(/\s+$/, '')
  if (!body) {
    rmSync(path, { force: true })
    return null
  }
  const text = `${body}\n`
  writeFileSync(path, text, 'utf8')
  return text
}

/**
 * Apply the current `lanBind` setting to disk. Called before every start.
 *
 * Returns the host the patch now points at so the caller can log it; nothing
 * dials dsh on a hard-coded loopback any more (see webserverHost()).
 */
export function applyLanBinding() {
  // **不再向 dsh 的 profile 注入 webserver 覆盖。**
  //
  // 旧实现会在每次启动前把 `- id: webserver` 块整体重写一遍（host+port），
  // 那有三个问题：dsh 的 `webserver.host` schema 在各版本之间是不相交的
  // （<=0.2.1-alpha.1 只收 "127.0.0.1"|"0.0.0.0"，>=0.2.1-alpha.2 只收具体
  // IP 字面量且直接拒通配），换版本时这个覆盖就成了必须手工迁移的遗留物；
  // 而且它锁死了端口，跟 dsh 自己的默认值打架。
  //
  // 现在 dsh 原封不动：永远只听 `127.0.0.1:3080`（原生默认，只信任本机），
  // 局域网访问一律走面板自己的反代入口（:28001 的 `/p/`，以及 :28000 的
  // 直连口）。切换 dsh 版本因此不需要任何配置迁移。
  //
  // 只做清理：把历史版本可能写下的 webserver 块删掉。
  try {
    clearWebserverPatch()
    return { ok: true, lan: false, host: '127.0.0.1' }
  } catch (error) {
    return { ok: false, lan: false, error: error?.message ?? String(error) }
  }
}

export function proxyUrl() {
  const conf = readKeyValueFile(proxyConfPath()).PROXY
  return conf || ''
}

export function trustedHosts() {
  try {
    return readFileSync(trustedConfPath(), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Persist the trusted-host list where dsh's own lifecycle reads it *and* where
 * this panel reads it. The file form is one host per line so the suite's shell
 * scripts can consume the same list.
 */
export function writeTrustedHosts(list) {
  const hosts = [...new Set((list ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))]
  const path = trustedConfPath()
  // 目标可能已被 homePath() 兜底到默认 home（文件只存在于那里时），mkdir 必须
  // 跟着解析后路径的父目录走，不能想当然 mkdir activeDshHome() —— 否则写进一个
  // 尚未创建的目录会直接 ENOENT。
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${hosts.join('\n')}${hosts.length ? '\n' : ''}`, 'utf8')
  return hosts
}

export function manifestInfo() {
  const info = readManifest(MANIFEST)
  return {
    version: info.version || '0.0.0',
    displayName: info.display_name || APP_NAME,
    description: info.desc || '',
    maintainer: info.maintainer || '',
    all: info,
  }
}

export {
  // Everything this module owns is declared with `export` in place. This block
  // only re-exports what arrived from dashboard-utils.js, so callers have a
  // single import site for paths and constants. Re-listing an owned name here
  // is a duplicate-export SyntaxError, which is why it is kept short.
  APP_DIR,
  APP_NAME,
  CONSOLE_APP_DIR,
  CONSOLE_PORT,
  DATA_DIR,
  DSH_HOME,
  DSH_PORT,
  resolve,
}
