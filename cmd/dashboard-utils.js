/**
 * Environment, paths, and small helpers shared by the dashboard server and its
 * entrypoint. Kept dependency-free: the panel is the thing that must come up on
 * a NAS that may have lost its node_modules.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, delimiter, join, resolve } from 'node:path'

/**
 * This suite (the console) and the dsh instance it supervises are two different
 * things, and they usually live in two different directories:
 *
 *  - `CONSOLE_*` is *this* package: where the panel's own data and logs go.
 *  - `APP_NAME` / `APP_DIR` are the *supervised* dsh install, which may be an
 *    fnOS suite somebody else installed, or a version this panel downloaded.
 *
 * Conflating the two is the classic way to delete the wrong tree, so they are
 * kept separate here and every consumer names which one it means.
 */
export const CONSOLE_APP_NAME = process.env.TRIM_APPNAME || 'fnos-dsh-manager'
export const CONSOLE_APP_DIR = process.env.TRIM_APPDEST || `/var/apps/${CONSOLE_APP_NAME}`

/** The supervised dsh suite's name; override when the suite has another name. */
export const APP_NAME = process.env.MANAGED_APP || 'dsh'
export const APP_DIR = process.env.MANAGED_APP_DIR || `/var/apps/${APP_NAME}`

export const DATA_DIR = process.env.DATA_DIR || process.env.TRIM_PKGVAR || `${CONSOLE_APP_DIR}/var`
export const CONSOLE_PORT = Number(process.env.CONSOLE_PORT || 28001)
export const DSH_PORT = Number(process.env.DSH_PORT || process.env.MANAGED_SERVICE_PORT || 28000)
/**
 * A second, purpose-built LAN port that only proxies to dsh (no panel UI, no
 * API). The panel's own :28001 also serves `/p/`, but that shares the console
 * surface; this port is a clean http://<NAS-IP>:28002 straight into the suite
 * for LAN clients, with dsh's browser-token gate already bypassed at launch.
 */
export const LAN_PROXY_PORT = Number(process.env.LAN_PROXY_PORT || 28002)
export const CMD_MAIN = process.env.CMD_MAIN || `${CONSOLE_APP_DIR}/cmd/main`
export const MANIFEST = process.env.MANIFEST || `${CONSOLE_APP_DIR}/manifest`
export const DSH_HOME = process.env.DSH_HOME || `${DATA_DIR}/dsh_home`
export const NODE_BIN = process.env.NODE_BIN || process.execPath

/**
 * Discover every node executable on a fnOS box and report its version.
 *
 * fnOS ships node as versioned dependency apps (nodejs_v20, nodejs_v22,
 * nodejs_v24, ...) under the nodejs_* app dirs and /vol{n}/@appcenter.
 * The panel's own node is whichever
 * `cmd/main` happened to pick first, but dsh itself has a minimum Node (see
 * engines) — running dsh under an older node makes it exit silently. So the
 * panel scans all of them, parses `node -v`, and lets the caller pick the
 * newest (or any version it needs).
 *
 * Returns `[{ bin, version, major }]` sorted newest-major-first, deduped by
 * real path. Falls back to the panel's own node so the list is never empty.
 *
 * Memoised: `node -v` is one subprocess per candidate binary, and this is
 * reached from `bestNodeBin()` → `dshLaunch()` → `dshStatus()`, i.e. every
 * `/api/status` call. The set of installed node versions changes only when the
 * operator installs or removes the fnOS node app, so a one-minute cache costs
 * nothing and saves a burst of forks on every poll.
 */
const NODE_SCAN_TTL_MS = 60000
let nodeScanCache = { at: 0, value: [] }

export function discoverNodeBins() {
  if (Date.now() - nodeScanCache.at < NODE_SCAN_TTL_MS) return nodeScanCache.value
  const found = new Map()
  const seen = new Set()

  const add = (bin) => {
    if (!bin) return
    let real = bin
    try { real = resolve(bin) } catch {}
    try {
      const st = statSync(bin)
      if (!st.isFile()) return
      // dedupe by inode+dev so the /var/apps symlink and the /vol real path
      // collapse to one entry instead of two.
      const key = `${st.dev}:${st.ino}`
      if (seen.has(key)) return
      seen.add(key)
    } catch { return }
    let version = ''
    try {
      const r = spawnSync(bin, ['-v'], { encoding: 'utf8', timeout: 5000 })
      version = (r.stdout || '').trim()
    } catch {}
    const major = Number((version.match(/^v?(\d+)/) || [])[1]) || 0
    found.set(bin, { bin, version, major })
  }

  // The panel's own node first, so it is never lost even if the globs miss.
  add(process.env.NODE_BIN || process.execPath)

  const globDirs = []
  // /var/apps/nodejs_*/{target/bin,bin}
  try {
    for (const entry of readdirSync('/var/apps')) {
      if (entry.startsWith('nodejs_')) {
        globDirs.push(join('/var/apps', entry, 'target', 'bin'), join('/var/apps', entry, 'bin'))
      }
    }
  } catch {}
  // /vol{n}/@appcenter/nodejs_*/{bin,target/bin}
  try {
    const vols = readdirSync('/').filter((n) => /^vol\d+$/.test(n))
    for (const vol of vols) {
      let apps = []
      try { apps = readdirSync(join('/', vol, '@appcenter')) } catch {}
      for (const app of apps) {
        if (!app.startsWith('nodejs_')) continue
        globDirs.push(join('/', vol, '@appcenter', app, 'bin'), join('/', vol, '@appcenter', app, 'target', 'bin'))
      }
    }
  } catch {}

  for (const dir of globDirs) add(join(dir, 'node'))

  const value = [...found.values()].sort((a, b) => b.major - a.major)
  nodeScanCache = { at: Date.now(), value }
  return value
}

/** Force the next discoverNodeBins() to re-scan (after installing nodejs). */
export function invalidateNodeScan() {
  nodeScanCache = { at: 0, value: [] }
}

/**
 * The best node to run dsh under: the newest version the box offers, or the
 * panel's own node when nothing else is found. dsh needs a recent Node (its
 * engines floor rises over releases), so "newest" is the safe default.
 */
export function bestNodeBin() {
  const list = discoverNodeBins()
  return (list[0] || {}).bin || (process.env.NODE_BIN || process.execPath)
}

/**
 * Absolute path to the `npm` executable next to `NODE_BIN`.
 *
 * On fnOS node is installed under `/var/apps/nodejs_v22/target/bin/node` and npm
 * is its sibling (`.../bin/npm`), but that directory is not on the panel's PATH
 * (the install script exported it only for its own lifetime). Spawning the bare
 * string `'npm'` therefore fails with `spawn npm ENOENT`. Deriving the absolute
 * path from node's own location makes the panel independent of PATH.
 *
 * Falls back to `NODE_BIN` itself (`node` can run npm's CLI entrypoint), then to
 * the bare string `npm` for the rare case where npm genuinely is on PATH.
 */
export function npmBin() {
  const node = process.env.NODE_BIN || process.execPath
  const candidates = [
    join(dirname(node), process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    node,
    'npm',
  ]
  for (const candidate of candidates) {
    if (candidate === 'npm' || existsSync(candidate)) return candidate
  }
  return 'npm'
}

/**
 * PATH for spawning npm: node's own directory prepended.
 *
 * npm's shebang is `#!/usr/bin/env node`, so even when the panel spawns npm by
 * absolute path, npm still has to find `node` on PATH. On fnOS node lives under
 * `/vol1/@appcenter/nodejs_v22/bin`, which is absent from the panel's PATH —
 * that is exactly what `env: node: No such file or directory` reports. Prepending
 * node's directory makes npm's own node lookup succeed.
 */
export function nodeDirEnv(extra = {}) {
  const node = process.env.NODE_BIN || process.execPath
  const binDir = dirname(node)
  // npm runs package install scripts through `sh` (`spawn sh ENOENT` otherwise),
  // and those scripts may call make/gcc/etc. Ensure the standard system bin dirs
  // are always on PATH even when the panel was launched with a sparse PATH.
  const systemDirs = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']
  const parts = [binDir, ...(process.env.PATH ? process.env.PATH.split(delimiter) : []), ...systemDirs]
  const path = [...new Set(parts.filter(Boolean))].join(delimiter)
  return { ...extra, PATH: path }
}

/** True when a TCP connect to the proxy's host:port succeeds within ~2s. */
export function proxyUsable(proxyUrl) {
  return new Promise((resolve) => {
    let parsed
    try { parsed = new URL(String(proxyUrl)) } catch { return resolve(false) }
    const host = parsed.hostname
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    if (!host) return resolve(false)
    const socket = createConnection({ host, port, timeout: 2000 })
    let settled = false
    const done = (ok) => { if (settled) return; settled = true; socket.destroy(); resolve(ok) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/**
 * Environment for spawning npm: node's own dir on PATH, a writable cache/log
 * dir, and a proxy only when it actually accepts connections.
 *
 * Two failures this prevents:
 *   1. `npm error syscall: 'connect', address: 127.0.0.1, port: 7980` — a stale
 *      proxy that nothing is listening on. We probe it first and skip it when
 *      dead, so installs fall back to a direct registry connection.
 *   2. `Log files were not written ... /home/<app>/.npm/_logs` — the service
 *      account cannot write its home. npm's cache and log dir are repointed to
 *      the writable DATA_DIR.
 */
export async function npmEnv(proxy) {
  const env = { ...process.env }
  env.npm_config_cache = join(DATA_DIR, '.npm-cache')
  env.HOME = DATA_DIR
  if (proxy && (await proxyUsable(proxy))) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  return nodeDirEnv(env)
}

/** Resolved dsh home of the running instance; falls back to the data-dir home. */
export function activeDshHome() {
  const active = `${DATA_DIR}/workspace.active`
  try {
    if (existsSync(active)) {
      const line = readFileSync(active, 'utf8').trim()
      if (line) return line
    }
  } catch {}
  return DSH_HOME
}

export function nowIso() {
  return new Date().toISOString()
}

/** `2026-10-08 17:56:03` in local time: log lines and the UI agree on one format. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const ANSI = /\u001b\[[0-9;]*m/g

/** Strip colour escapes and trailing CR before a line is stored or returned. */
export function cleanLine(raw) {
  return String(raw ?? '').replace(ANSI, '').replace(/\r+$/, '')
}

/** `0.2.0-rc.2.5` sorts above `0.2.0-rc.2` and above `0.2.0-rc.2.4`. */
export function compareVersions(a, b) {
  const norm = (v) => String(v ?? '')
    .replace(/^v/, '')
    .split(/[.+-]/)
    .filter(Boolean)
  const ax = norm(a)
  const bx = norm(b)
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const x = ax[i]
    const y = bx[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    const numeric = Number.isFinite(nx) && Number.isFinite(ny)
    if (numeric) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Read `key = value` / `key=value` / `key value` from an fnOS manifest. */
export function readManifest(path = MANIFEST) {
  const out = {}
  try {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = /^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(trimmed)
      if (match) out[match[1]] = match[2].replace(/\s+$/, '')
    }
  } catch {}
  return out
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

/**
 * Run a command without a shell: no quoting traps and no shell-startup cost.
 * @returns {Promise<{code:number,stdout:string,stderr:string}>} never rejects.
 */
export function run(command, args = [], options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => done({ code: 127, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => done({ code: code ?? 0, stdout, stderr }))
  })
}

/** Same as {@link run} but never hangs: kills and reports `code: 124` on timeout.
 * `options.onData` (when given) is called with each stdout/stderr chunk as it
 * streams, so a long install can surface live progress instead of one lump. */
export function runWithTimeout(command, args = [], timeoutMs = 10000, options = {}) {
  return new Promise((done) => {
    const { onData, ...spawnOptions } = options
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ code: 124, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]` })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk; onData?.(chunk) })
    child.stdout.on('data', (chunk) => { stdout += chunk; onData?.(chunk) })
    child.on('error', (error) => finish({ code: 127, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }))
  })
}

/**
 * Non-loopback IPv4 addresses: what LAN clients can actually reach.
 *
 * Virtual adapters sort last. VPN/TUN clients (this box grows a `198.18.0.1`
 * for a proxy app; Tailscale/WireGuard do the same) answer `internal: false`
 * and are therefore indistinguishable from the real NIC by the fields above —
 * but binding dsh to one of them makes it unreachable to every real LAN client.
 * Two heuristics get them out of `[0]` without pretending to be authoritative:
 * a multicast/loopback MAC marks a virtual NIC outright, and a /30-or-smaller
 * netmask means "point-to-point tunnel", which is never someone's LAN. Both are
 * heuristics, so the concrete IP is still selectable in Settings.
 *
 * Memoised for {@link LAN_TTL_MS}: `networkInterfaces()` is a syscall, and this
 * is called by the trust fence on *every* request plus `preferredPatchHost()`,
 * `buildArgs()` and `probeHealth()`. An address that appears or disappears is
 * picked up within a few seconds, which is far faster than a user can notice.
 */
const LAN_TTL_MS = 5000
let lanCache = { at: 0, value: [] }

export function lanAddresses() {
  if (Date.now() - lanCache.at < LAN_TTL_MS) return lanCache.value
  const scored = []
  const groups = networkInterfaces()
  for (const list of Object.values(groups ?? {})) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      scored.push({ address: entry.address, rank: nicRank(entry) })
    }
  }
  scored.sort((a, b) => a.rank - b.rank)
  lanCache = { at: Date.now(), value: scored.map((entry) => entry.address) }
  return lanCache.value
}

/** Force the next lanAddresses() to re-read the interfaces. */
export function invalidateLanCache() {
  lanCache = { at: 0, value: [] }
}

/** Lower sorts first: real hardware ahead of virtual/tunnel adapters. */
function nicRank(entry) {
  const mac = (entry.mac || '').toLowerCase()
  const virtualMac = !mac || mac === '00:00:00:00:00:00' || mac.startsWith('ff:')
  // IPv6-style flag: multicast-capable MACs are virtual switch ports.
  const multicastMac = /^[0-9a-f]{2}:[0-9a-f]{2}:/.test(mac) && (parseInt(mac.slice(0, 2), 16) & 1) === 1
  const prefix = maskPrefix(entry.netmask)
  const tunnel = prefix !== null && prefix >= 30
  return (virtualMac || multicastMac ? 2 : 0) + (tunnel ? 1 : 0)
}

/** Bits set in an IPv4 dotted netmask, or null when it is not usable. */
function maskPrefix(netmask) {
  if (typeof netmask !== 'string') return null
  const parts = netmask.split('.')
  if (parts.length !== 4) return null
  let bits = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    bits += (octet.toString(2).match(/1/g) ?? []).length
  }
  return bits
}

export function localHost() {
  return hostname()
}

/** Join a base URL and a path without producing a double slash. */
export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}

export { dirname, existsSync, readFileSync, resolve }
