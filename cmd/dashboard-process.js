/**
 * Process supervision: start, stop, and health of the dsh web server.
 *
 * Deliberately avoids depending on the suite's own lifecycle script: this
 * panel has to work both when the suite exists (managed) and when it owns the
 * install (standalone). It therefore spawns dsh directly and writes a pidfile.
 *
 * Reliability model (ported from the mature Go reference `process.go`):
 *   - Process-group ownership: dsh is spawned `detached` (its own session +
 *     process group, pgid == pid), so a single negative-pid signal reaches the
 *     whole tree — no orphaned children left holding the port.
 *   - Three-stage stop: SIGTERM the group → poll → SIGKILL the group, then
 *     sweep the port for stragglers and wait for it to actually free.
 *   - Watchdog (`StartWatchdog` → `inspectAndHeal`, 1s tick): while the panel
 *     believes dsh is running, it re-checks the pid and the port every tick,
 *     adopts an orphaned child that inherited the port, and — after a small
 *     failure tolerance — tears the stale state down so the UI never reports
 *     "running" for a process that has died.
 */

import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  activeDshHome,
  lanAddresses,
  runWithTimeout,
} from './dashboard-utils.js'
import {
  DATA_DIR,
  NODE_MODULES_DSH,
  dshLaunch,
  dshRoot,
  effectiveMode,
  managedAppDir,
  managedPort,
  trustedHosts,
  applyLanBinding,
  webserverHost,
  manifestInfo,
  readPinnedVersion,
} from './dashboard-config.js'
import {
  GetStatus,
  SetStatus,
  SetLastRunState,
  StatusStarting,
  StatusRunning,
  StatusStopped,
} from './dashboard-state.js'
import { setTargetPidResolver } from './dashboard-usage.js'
import { CaptureLaunchToken, SetCurrentLaunchToken } from './dashboard-session.js'

export const PID_FILE = join(DATA_DIR, 'dsh.pid')
export const DSH_LOG = join(DATA_DIR, 'dsh.log')

// ---------------------------------------------------------------------------
// Managed process state (Go: `managedProcess`)
// ---------------------------------------------------------------------------

/**
 * The single process this panel supervises. `adoptedPid` tracks the case where
 * the pid we spawned died but a child of it (or a leftover listener) still owns
 * the port — the watchdog adopts it so stop/status keep working against the
 * *live* process, not a stale pid.
 */
const managed = {
  pid: null,      // pid we spawned (process group leader)
  adoptedPid: null, // pid the watchdog took over when `pid` died
  stopRequested: false, // set during an explicit stop → watchdog goes quiet
  failCount: 0,   // consecutive ticks where neither pid nor port was alive
}

/** The pid we currently believe is the live dsh (adopted over spawned). */
function currentPid() {
  return managed.adoptedPid || managed.pid
}

// ---------------------------------------------------------------------------
// pidfile helpers (Go: `removePidFileIfMatches`)
// ---------------------------------------------------------------------------

/** Version the operator pinned in the Versions tab, if any. */
export function pinnedVersion() {
  return readPinnedVersion()
}

/** PID of the instance this panel started, or `null`. */
export function readPid() {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function isAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove the pidfile only if it still names `pid` (never clobber a newer one). */
function removePidFileIfMatches(pid) {
  if (!pid || pid <= 0) return
  if (readPid() === pid) {
    try { rmSync(PID_FILE, { force: true }) } catch {}
  }
}

function writePid(pid) {
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true })
    writeFileSync(PID_FILE, String(pid), 'utf8')
  } catch {}
}

// ---------------------------------------------------------------------------
// Process-group kill (Go: `killProcessGroup` / `killProcessTree`)
// ---------------------------------------------------------------------------

/**
 * Signal an entire process group. Because dsh is spawned `detached: true`, it
 * is a group leader (pgid == its pid), so `-pid` reaches every descendant.
 * Returns `true` once the group is gone (or never existed).
 */
function signalGroup(pgid, signal) {
  if (!pgid || pgid <= 0) return true
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    // ESRCH means the group is already gone — that's success.
    if (error && error.code === 'ESRCH') return true
    // EPERM on an adopted pid we do not own: fall through to single-pid below.
    return error && error.code === 'EPERM' ? false : false
  }
  return false
}

function groupAlive(pgid) {
  if (!pgid || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * SIGTERM a process group, wait up to ~3s, then SIGKILL it. Returns `true` when
 * the group is confirmed gone. This is the three-stage stop the Go version uses.
 */
async function killProcessGroup(pgid) {
  if (!pgid || pgid <= 0) return true
  signalGroup(pgid, 'SIGTERM')
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await sleep(50)
  }
  signalGroup(pgid, 'SIGKILL')
  await sleep(100)
  return !groupAlive(pgid)
}

/**
 * Kill a process and, if it was a group leader, its whole group. Falls back to
 * a single-pid SIGKILL when the group is not reachable (e.g. adopted pid whose
 * pgid we cannot signal).
 */
async function killProcessTree(pid) {
  if (!pid || pid <= 0) return
  // Try the group first (dsh is a leader; descendants share the pgid).
  if (await killProcessGroup(pid)) return
  // Group unavailable → single pid.
  try { process.kill(pid, 'SIGKILL') } catch {}
}

// ---------------------------------------------------------------------------
// Port forensics (Go: `findPidsOnPort` / `isDshProcess` / `waitForPortFree`)
// ---------------------------------------------------------------------------

/**
 * `/proc/net/tcp` + `/proc/<pid>/fd` port→pid lookup, with a short-lived cache.
 *
 * The watchdog calls this **every second**, and the old implementation did it
 * by spawning `ss -ltnp` (or `fuser`) with `execFileSync`. That is a
 * synchronous subprocess on the panel's single thread: it blocks every
 * in-flight HTTP request, every WebSocket push and the watchdog's own next
 * tick, twice a second, forever. On a busy NAS that `ss` call is also one of
 * the most expensive things the box does at idle.
 *
 * The `/proc` route answers the same question with a few file reads and no
 * process at all:
 *   - `/proc/net/tcp` lists every listening socket; the local port is hex, and
 *     the inode column (`sl`… the 10th field) identifies the socket.
 *   - a listening socket's inode appears in `/proc/<pid>/fd/*` as `socket:[N]`,
 *     which yields the owning pid.
 * `/proc/net/tcp6` is read too, so an IPv6-bound dsh is still found.
 *
 * Results are cached for `PORT_SCAN_TTL_MS`: the callers either poll on a 1s
 * tick or run inside a stop sequence where a second of staleness is harmless,
 * and the alternative is one scan per call site rather than per tick.
 */
const PORT_SCAN_TTL_MS = 750
const portScanCache = new Map() // port -> { at, pids }

/** Parse `/proc/net/tcp{,6}` into a set of listening socket inodes per port. */
function listeningInodes(port) {
  const want = port.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      // cols[1] = local_address as "HEXADDR:HEXPORT", cols[3] = st (0A = LISTEN)
      const local = cols[1] ?? ''
      const colon = local.lastIndexOf(':')
      if (colon < 0) continue
      if (local.slice(colon + 1).toUpperCase() !== want) continue
      if (cols[3] !== '0A') continue
      const inode = cols[9]
      if (inode) inodes.add(inode)
    }
  }
  return inodes
}

/** Map socket inodes to pids via `/proc/<pid>/fd`. */
function pidsForInodes(inodes) {
  if (!inodes.size) return []
  const pids = new Set()
  let entries = []
  try { entries = readdirSync('/proc') } catch { return [] }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    let fds = []
    try { fds = readdirSync(`/proc/${name}/fd`) } catch { continue }
    for (const fd of fds) {
      let link = ''
      try { link = readlinkSync(`/proc/${name}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (m && inodes.has(m[1])) { pids.add(Number(name)); break }
    }
  }
  return [...pids]
}

/**
 * PIDs currently listening on `port`. Returns `[]` on any failure — never throws.
 *
 * Falls back to the old `ss`/`fuser` subprocess path when `/proc` yields nothing
 * AND has not been proven unusable, so a box with `/proc` mounted somewhere
 * unusual still gets the old answer. The fallback is memoised too, so a
 * permanently unavailable `/proc` costs one subprocess per TTL, not per call.
 */
function findPidsOnPort(port) {
  if (!port || port <= 0) return []
  const now = Date.now()
  const hit = portScanCache.get(port)
  if (hit && now - hit.at < PORT_SCAN_TTL_MS) return hit.pids

  let pids = pidsForInodes(listeningInodes(port))

  if (!pids.length && procNetUsable) {
    const viaTool = pidsOnPortViaTool(port)
    if (viaTool === null) procNetUsable = false // /proc unavailable: stop trying
    else pids = viaTool
  }

  portScanCache.set(port, { at: now, pids })
  return pids
}

/** Flipped off for good if `/proc/net/tcp*` turns out to be unreadable. */
let procNetUsable = true

/** The original `ss`/`fuser` probe. Returns `[]`, or null when no tool works. */
function pidsOnPortViaTool(port) {
  try {
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 2000 })
    const pids = new Set()
    for (const line of out.split('\n')) {
      if (!line.includes(`:${port}`)) continue
      const m = line.match(/pid=(\d+)/)
      if (m) pids.add(Number(m[1]))
    }
    return [...pids]
  } catch {}
  try {
    const out = execFileSync('fuser', [`${port}/tcp`], { encoding: 'utf8', timeout: 2000 })
    const pids = new Set()
    for (const tok of out.trim().split(/\s+/)) {
      if (/^\d+$/.test(tok)) pids.add(Number(tok))
    }
    return [...pids]
  } catch {}
  return null
}

/** Drop the memoised port scan (called after dsh is stopped/started). */
export function invalidatePortScan() {
  portScanCache.clear()
}

/** Is `pid` a dsh process (vs. an unrelated squatter on the port)? */
function isDshProcess(pid) {
  if (!pid || pid <= 0) return false
  const root = dshRoot()
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    // dsh's own entrypoint, its bin.js, or its package scope are all enough.
    if (cmdline.includes('bin.js')) return true
    if (cmdline.includes('@deepseek-ai/dsh')) return true
    if (root && cmdline.includes(root)) return true
  } catch {}
  try {
    const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8')
    if (root && cwd.includes(root)) return true
  } catch {}
  return false
}

/** First dsh-owned pid listening on `port`, or 0. */
function findDshPidOnPort(port) {
  for (const pid of findPidsOnPort(port)) {
    if (isAlive(pid) && isDshProcess(pid)) return pid
  }
  return 0
}

/** Block up to 500ms for the port to actually free. */
async function waitForPortFree(port) {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    invalidatePortScan()
    if (findPidsOnPort(port).length === 0) return
    await sleep(50)
  }
}

// ---------------------------------------------------------------------------
// The port dsh is actually listening on
// ---------------------------------------------------------------------------
export function listenPort() {
  return managedPort()
}

function appendLog(text) {
  try {
    mkdirSync(dirname(DSH_LOG), { recursive: true })
    writeFileSync(DSH_LOG, text, { flag: 'a' })
  } catch {}
}

// ---------------------------------------------------------------------------
// Run identity (the uid/gid dsh executes as)
// ---------------------------------------------------------------------------

/**
 * The identity dsh actually runs as — which is the panel's OWN identity.
 *
 * The panel cannot `setuid` (it runs under the fnOS manager account, not root,
 * and lacks CAP_SETUID), so any attempt to spawn dsh under a separate account
 * fails with `spawn EPERM`. The Go reference never setuids either (`process.go`
 * only sets `Setpgid`), it just spawns dsh as the panel's own process.
 *
 * Therefore dsh runs AS this panel, and the home directory must be owned by the
 * panel's own uid so dsh can write its profiles/logs/credentials. The earlier
 * "chown to a separate `dsh` account + setuid on spawn" model was a
 * self-contradictory misdiagnosis (it chowned home to uid 810 while spawning
 * without that uid, then setuid'ed and hit EPERM). Returns `{user,uid,gid}`.
 */
function panelIdentity() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const gid = typeof process.getgid === 'function' ? process.getgid() : null
  let user = process.env.USER || process.env.LOGNAME || null
  let shell = process.env.SHELL || null
  if (process.platform === 'linux') {
    try {
      const passwd = readFileSync('/etc/passwd', 'utf8')
      const row = passwd.split('\n').map((line) => line.split(':')).find((r) => r[2] === String(uid))
      if (row) {
        if (!user) user = row[0]
        // The login shell recorded in /etc/passwd is what dsh's built-in
        // terminal would inherit; `nologin`/`false` there kills it instantly.
        if (row[6] && row[6] !== '/sbin/nologin' && row[6] !== '/bin/false' && row[6] !== '/usr/sbin/nologin') {
          shell = row[6]
        }
      }
    } catch {}
  }
  return { user, uid: uid ?? null, gid: gid ?? null, shell }
}

// ---------------------------------------------------------------------------
// Pre-start self-heal
// ---------------------------------------------------------------------------

/**
 * Pre-start self-heal. Each step fixes one class of silent NAS startup failure;
 * every step is best-effort so a weird filesystem can never block the launch.
 *
 *  1. Kill leftover processes holding the dsh port (EADDRINUSE on restart).
 *  2. chmod 600 the credential files (dsh refuses group-readable creds).
 *  3. chown stray root-owned files back to the running user.
 *  3b. chown the home tree to the run account — IDEMPOTENTLY: skip when the
 *      tree is already owned by the target (the old blanket `chown -R` rewrote
 *      every ACL on every boot and blocked startup for ~30s on big homes).
 *  4. Fix a `nologin`/`false` shell on the run account.
 *  5. Clear the stale launch token (session holding replaces the old browser-auth patch).
 */
async function preStartSelfHeal(home, port) {
  const notes = []

  // 1. Stale listeners on the dsh port (previous unclean shutdown).
  if (process.platform !== 'win32') {
    for (const pid of findPidsOnPort(port)) {
      if (pid === process.pid) continue
      try {
        if (!isDshProcess(pid)) continue
        process.kill(pid, 'SIGTERM')
        notes.push(`killed stale dsh pid ${pid} on port ${port}`)
      } catch { /* gone already, or unreadable */ }
    }
  }

  // 2. Credential files must be owner-only or dsh refuses to start.
  for (const name of ['.credentials.yaml', '.env', 'proxy.conf', 'trusted_hosts.conf']) {
    const file = join(home, name)
    if (!existsSync(file)) continue
    try {
      const mode = statSync(file).mode & 0o777
      if (mode !== 0o600) {
        chmodSync(file, 0o600)
        notes.push(`chmod 600 ${name} (was ${mode.toString(8)})`)
      }
    } catch {}
  }

  // 3. Files created by a root ssh session block the service account.
  if (process.platform !== 'win32') {
    for (const name of ['.gitconfig', '.npmrc']) {
      const file = join(home, name)
      if (!existsSync(file)) continue
      try {
        if (statSync(file).uid === 0) {
          await runWithTimeout('chown', [`${process.env.USER || 'dsh-console'}:${process.env.USER || 'dsh-console'}`, file], 3000)
          notes.push(`chowned root-owned ${name}`)
        }
      } catch {}
    }
  }

  // 3b. Home ownership → the panel's own identity (dsh runs AS the panel), but
  //     only when it actually differs. This also undoes the earlier buggy chown
  //     to a separate `dsh` account (uid 810), which left the home un-writable
  //     by a dsh that runs as the panel.
  if (process.platform === 'linux' && existsSync(home)) {
    try {
      const { uid, gid } = panelIdentity()
      if (uid != null) {
        const st = statSync(home)
        if (st.uid !== uid) {
          await runWithTimeout('chown', ['-R', `${uid}:${gid ?? uid}`, home], 30000)
          notes.push(`chowned dsh home -> ${uid}:${gid ?? uid} (panel identity)`)
        } else {
          notes.push(`dsh home already owned by ${uid} (chown skipped)`)
        }
        await runWithTimeout('chmod', ['u+rwX', home], 3000)
      }
    } catch (error) {
      notes.push(`dsh home chown skipped: ${error?.message ?? error}`)
    }
  }

  // 4. Panel's own shell: `nologin`/`false` would kill dsh's terminal feature.
  //    Skip for root/none — do NOT `return` (the previous `return` here aborted
  //    the whole heal, skipping step 5).
  if (process.platform === 'linux') {
    try {
      const identity = panelIdentity()
      const runUser = identity.user
      if (runUser && runUser !== 'root') {
        const passwd = readFileSync('/etc/passwd', 'utf8')
        const row = passwd.split('\n').find((line) => line.startsWith(`${runUser}:`))
        if (row && (row.endsWith('/nologin') || row.endsWith('/bin/false') || row.endsWith('/usr/sbin/nologin'))) {
          // NOTE: usermod needs root/CAP_SETUID, which the manager account does
          // NOT have (v1.0.20 confirmed no setuid). So this almost always fails
          // with EPERM — but we still TRY (in case the panel ever runs as root)
          // and now RECORD the failure instead of swallowing it silently, so the
          // real fix below (SHELL env override) is the one that actually lands.
          try {
            await runWithTimeout('usermod', ['-s', '/bin/bash', runUser], 3000)
            notes.push(`fixed login shell for ${runUser} (was nologin/false)`)
          } catch (error) {
            notes.push(`login shell for ${runUser} still nologin/false (usermod EPERM: ${error?.message ?? error}) — using SHELL override instead`)
          }
        }
      }
    } catch {}
  }

  // 5. Browser token auth：不再 patch 上游，改由面板服务端会话代持
  //    （dashboard-session.js 捕获 token + 换 Cookie + 反代注入），保持上游纯净。
  //    这里只需清掉上次启动遗留的 token，避免旧 token 污染新进程的会话。
  SetCurrentLaunchToken('')

  if (notes.length) appendLog(`[dsh-console] self-heal: ${notes.join('; ')}\n`)
  return notes
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/**
 * dsh's web flag family. The CLI takes no `--host` at all, and the address it
 * binds comes from `${DSH_HOME}/profiles/web/cordis.patch.yml` — see
 * writeWebserverPatch(). Note this means dsh answers on exactly ONE address,
 * so anything dialling it (this panel's proxy included) has to use the same
 * host the patch pinned; see webserverHost().
 */
function buildArgs(port) {
  const args = ['web', '--port', String(port)]
  const hosts = [...lanAddresses(), 'localhost', '127.0.0.1', 'fnos.net', '5ddd.com', ...trustedHosts()]
  const unique = [...new Set(hosts.filter(Boolean))]
  if (unique.length) args.push('--trusted-host', ...unique)
  return args
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

export async function startDsh() {
  const existing = readPid()
  if (existing && isAlive(existing)) {
    // 已有活进程：直接对齐状态机，避免 UI 与实际脱节。
    SetStatus(StatusRunning, '')
    SetLastRunState(StatusRunning)
    return { ok: true, pid: existing, already: true }
  }

  const launch = dshLaunch()
  if (!launch) return { ok: false, error: 'dsh-not-installed' }

  const port = listenPort()
  const home = activeDshHome()
  mkdirSync(home, { recursive: true })
  // A fresh process is about to claim this port.
  invalidatePortScan()

  // 状态机：进入启动中。
  SetStatus(StatusStarting, '正在启动服务…')

  // Startup self-heal before spawning (best-effort, never blocks).
  try { await preStartSelfHeal(home, port) } catch {}

  // dsh records its home once per process; HOME, DSH_HOME and USERPROFILE all
  // have to agree or files land in /home/<user> instead.
  const identity = panelIdentity()
  // dsh's built-in terminal spawns the run account's login shell. The manager
  // account is nologin by default and the panel can't usermod it (no CAP_SETUID),
  // so we hand dsh a concrete working shell here. `identity.shell` prefers the
  // value in /etc/passwd only when it is a real shell; otherwise we fall back to
  // /bin/sh (always present, even on a minimal NAS), and finally to the panel's
  // own inherited SHELL. This is the one terminal fix within the panel's power.
  const terminalShell = identity.shell || process.env.SHELL || '/bin/sh'
  const env = {
    ...process.env,
    HOME: home,
    DSH_HOME: home,
    USERPROFILE: home,
    SHELL: terminalShell,
    DSH_WEB_PORT: String(port),
    DSH_LOG_DIR: dirname(DSH_LOG),
    // 标记为远程无头环境：dsh 据此关闭本地桌面应用探测（Go 版 InitAppEnv），
    // 避免会话头部出现「在 Zed 中打开」等桌面分体按钮（适配文档问题 #6）。
    SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 22',
  }
  try {
    const fd = openSync(DSH_LOG, 'a')
    // dsh runs AS the panel (no setuid) — the panel lacks CAP_SETUID, so any
    // `uid`/`gid` here fails with `spawn EPERM`. This matches the Go reference,
    // whose `SysProcAttr` only sets `Setpgid` and never drops privileges.
    // stdout 走 pipe：既 tee 回日志文件，又实时捕获 `?token=`（会话代持）。
    const spawnOpts = { env, cwd: home, detached: true, stdio: ['ignore', 'pipe', fd] }
    const child = spawn(launch.bin, [...launch.args, ...buildArgs(port)], spawnOpts)
    child.stdout.on('data', (chunk) => {
      try { writeSync(fd, chunk) } catch { /* log fd closed is fine */ }
      CaptureLaunchToken(chunk)
    })
    child.unref()
    // Record supervised state so the watchdog and stop both target the group.
    managed.pid = child.pid
    managed.adoptedPid = null
    managed.stopRequested = false
    managed.failCount = 0
    writePid(child.pid)

    // 等待 Web 就绪后翻到 running（Go 版 `waitAndActivateReverseProxy` 语义）。
    // 这里异步探测：就绪即置 running 并持久化上次运行状态。
    watchForReady(child.pid, port)

    return { ok: true, pid: child.pid, already: false }
  } catch (error) {
    appendLog(`[dsh-console] spawn failed: ${error?.message ?? error}\n`)
    SetStatus(StatusStopped, `启动失败: ${error?.message ?? error}`)
    return { ok: false, error: 'spawn-failed' }
  }
}

/**
 * 等待 dsh 端口就绪，就绪后把状态机翻到 running（对应 Go 版
 * `waitAndActivateReverseProxy`：HTTP 探测优先，TCP 兜底，超时则回退 stopped）。
 * 不阻塞 startDsh 返回——启动接口立即回包，状态机异步收敛。
 */
function watchForReady(pid, port) {
  const startedAt = Date.now()
  const timeoutMs = 300000 // 300s，同 Go 版
  const tick = async () => {
    // 进程已不在（被停/崩溃）→ 停止探测。
    if (!isAlive(pid) || managed.stopRequested) return

    const health = await probeHealth(port, { force: true })
    if (health.reachable) {
      // 仅当仍是同一个进程组组长时才翻 running，避免旧的探测覆盖新进程状态。
      if (currentPid() === pid && !managed.stopRequested) {
        SetStatus(StatusRunning, '')
        SetLastRunState(StatusRunning)
        appendLog(`[dsh-console] ready: pid ${pid} responding on port ${port}\n`)
      }
      return
    }

    if (Date.now() - startedAt >= timeoutMs) {
      appendLog(`[dsh-console] ready timeout (${timeoutMs / 1000}s) on port ${port}\n`)
      if (currentPid() === pid && !managed.stopRequested) {
        SetStatus(StatusStopped, `Web 就绪探测超时 (端口 ${port} 未响应)`)
      }
      return
    }
    setTimeout(tick, 500)
  }
  setTimeout(tick, 500)
}

/**
 * Stop dsh, three-stage: SIGTERM the process group → poll → SIGKILL the group,
 * then sweep the port for any stragglers and wait for the port to free. This
 * mirrors the Go version's `killHarnessLocked` (no orphan children holding the
 * port and causing the next start to die with EADDRINUSE).
 */
export async function stopDsh() {
  managed.stopRequested = true
  // The port is about to change hands; a memoised scan would report the old
  // listener for another 750ms and make the sweep below look like it failed.
  invalidatePortScan()

  const port = listenPort()
  const pid = currentPid() || readPid()

  if (pid && isAlive(pid)) {
    appendLog(`[dsh-console] stop: SIGTERM group ${pid}\n`)
    await killProcessGroup(pid)
    await killProcessTree(pid)
    removePidFileIfMatches(pid)
  }

  // Sweep the port for any dsh-owned stragglers the group kill missed.
  for (const p of findPidsOnPort(port)) {
    if (!isAlive(p)) continue
    if (!isDshProcess(p)) {
      appendLog(`[dsh-console] port ${port} held by foreign pid ${p}; left alone\n`)
      continue
    }
    appendLog(`[dsh-console] stop: kill straggler pid ${p} on port ${port}\n`)
    await killProcessTree(p)
  }

  // Wait for the port to actually release before declaring success.
  await waitForPortFree(port)

  try { rmSync(PID_FILE, { force: true }) } catch {}
  managed.pid = null
  managed.adoptedPid = null
  managed.failCount = 0
  // 停止即清 Launch Token：下次启动 dsh 会打印新 token，旧 token 已作废。
  SetCurrentLaunchToken('')
  // 状态机翻到 stopped，并持久化（面板重启后不再自启）。
  SetStatus(StatusStopped, '')
  SetLastRunState(StatusStopped)
  return { ok: true }
}

/**
 * Health probe. Targets follow the same rule as the proxy: dsh listens on one
 * address only, so probe the host the running patch pinned first (with
 * loopback as a fallback for an unpatched/managed instance).
 *
 * Results are memoised for {@link HEALTH_TTL_MS}. This runs on `/api/status`,
 * which the overview polls every 3s and which every WebSocket status push
 * triggers — and a *down* dsh is the expensive case: each unreachable target
 * burns a full 3s abort timeout, so one status call could block for up to 9s
 * while holding an open file descriptor, starving every other request. With the
 * cache the panel keeps answering immediately, and `watchForReady` still polls
 * often enough to notice a start.
 *
 * A `force` flag exists for the call sites that must not read a stale verdict
 * (the stop/start sequences and the restart wait loop).
 */
const HEALTH_TTL_MS = 1500
const healthCache = new Map() // port -> { at, result }

export function invalidateHealth() {
  healthCache.clear()
}

async function probeHealth(port, { force = false } = {}) {
  if (!force) {
    const hit = healthCache.get(port)
    if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.result
  }
  const result = await probeHealthUncached(port)
  healthCache.set(port, { at: Date.now(), result })
  return result
}

async function probeHealthUncached(port) {
  const bound = webserverHost()
  const targets = [...new Set([bound, '127.0.0.1', ...lanAddresses().slice(0, 1)])].filter(Boolean)
  for (const host of targets) {
    const controller = new AbortController()
    // A single unreachable target must not eat the whole budget: 3s x 3 = 9s.
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(`http://${host}:${port}/`, {
        redirect: 'manual',
        signal: controller.signal,
      })
      // Drain so the socket is released back to the pool instead of lingering.
      await response.body?.cancel?.().catch(() => {})
      return { reachable: true, status: response.status }
    } catch {
      // try next target
    } finally {
      clearTimeout(timer)
    }
  }
  return { reachable: false, status: 0 }
}

/** Per-target abort budget for one health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 1500

/**
 * Stop and relaunch dsh with a freshly written patch, then wait for the port.
 */
export async function restartDsh() {
  await stopDsh()
  const binding = applyLanBinding()
  const result = await startDsh()
  if (!result.ok) return { ...result, binding }
  // Force a fresh verdict here: this loop is the one place that must see the
  // port come up rather than a cached "still down".
  invalidateHealth()
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    const health = await probeHealth(listenPort(), { force: true })
    if (health.reachable) return { ...result, binding, healthy: true, waitedMs: (i + 1) * 250 }
  }
  return { ...result, binding, healthy: false }
}

// ---------------------------------------------------------------------------
// Watchdog (Go: `StartWatchdog` + `inspectAndHeal`)
// ---------------------------------------------------------------------------

/**
 * Start the 1s health-check loop. Self-heals a supervised process that died:
 * adopts an orphaned child that still owns the port, and after a small failure
 * tolerance tears down stale "running" state so status stops lying.
 */
export function StartWatchdog() {
  setInterval(inspectAndHeal, 1000).unref()
}

function inspectAndHeal() {
  const port = listenPort()

  // Nothing supervised and nothing on the port → nothing to do.
  if (!currentPid()) return

  // An explicit stop is in progress → stay silent, don't fight it.
  if (managed.stopRequested) return

  const pid = currentPid()

  // The pid we track is alive → healthy.
  if (isAlive(pid)) {
    managed.failCount = 0
    return
  }

  // The pid died; did a child take over the port? Adopt it.
  const adopted = findDshPidOnPort(port)
  if (adopted > 0) {
    managed.failCount = 0
    if (adopted !== pid) {
      appendLog(`[dsh-console] watchdog: adopted pid ${adopted} on port ${port}\n`)
      managed.adoptedPid = adopted
      writePid(adopted)
    }
    return
  }

  // Tolerate a few transient ticks (process restarting, port still binding).
  managed.failCount += 1
  if (managed.failCount <= 3) return

  // Confirmed dead with no successor: clear stale state.
  appendLog(`[dsh-console] watchdog: pid ${pid} dead and port ${port} unresponsive; clearing\n`)
  removePidFileIfMatches(pid)
  managed.pid = null
  managed.adoptedPid = null
  managed.failCount = 0
  // 进程意外退出 → token 作废，清掉避免反代用旧 token 换到失效 Cookie。
  SetCurrentLaunchToken('')
  // 状态机对齐：进程确实没了，别再让 UI 显示 running。
  if (GetStatus() !== StatusStopped) {
    SetStatus(StatusStopped, '进程意外退出')
    SetLastRunState(StatusStopped)
  }
}

/**
 * 当前需要监控的 dsh 主进程 pid（Go: `getTargetDshPid`）——端口优先，其次托管
 * pid，最后 pidfile。供 usage 采样器注入使用。
 */
export function getTargetDshPid() {
  const port = listenPort()
  const onPort = findDshPidOnPort(port)
  if (onPort > 0) return onPort
  return currentPid() || readPid() || 0
}

// usage 采样器需要「当前 dsh 主进程 pid」，注入解析器（避免循环 import）。
setTargetPidResolver(getTargetDshPid)

export async function dshStatus() {
  const pid = currentPid() || readPid()
  const alive = isAlive(pid)
  const port = listenPort()
  const root = dshRoot()
  let installedVersion = null
  try {
    if (root && existsSync(join(root, NODE_MODULES_DSH, 'package.json'))) {
      installedVersion = JSON.parse(
        readFileSync(join(root, NODE_MODULES_DSH, 'package.json'), 'utf8'),
      ).version
    }
  } catch {}
  const health = alive ? await probeHealth(port) : { reachable: false, status: 0 }
  // 状态机相位（显式五态），与 running/healthy 布尔并存供 UI 精确展示。
  const phase = GetStatus()
  return {
    pid,
    running: alive,
    healthy: health.reachable,
    httpStatus: health.status,
    port,
    phase,
    state: {
      status: phase,
      lastMessage: '', // 由 server.js 注入（snapshot() 提供完整字段）
    },
    mode: effectiveMode(),
    managedAppDir: managedAppDir(),
    dshRoot: root,
    installedVersion,
    home: activeDshHome(),
    panelVersion: manifestInfo().version,
  }
}
