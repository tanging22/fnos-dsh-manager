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
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import {
  activeDshHome,
  lanAddresses,
  nodeDirEnv,
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
import { applyPatches } from './dashboard-patches.js'

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
 *
 * 返回值语义：**信号送达返回 `false`，组已消失（或从未存在）返回 `true`**
 * —— 也就是"这个组还在不在"，与函数名相反。历史上这里写成
 * `error.code === 'EPERM' ? false : false`（两个分支相同，明显笔误），
 * 语义无从判断。当前没有调用方使用返回值，但极易误导后续维护，故在此写明。
 */
function signalGroup(pgid, signal) {
  if (!pgid || pgid <= 0) return true
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    // ESRCH means the group is already gone — that's "gone".
    if (error && error.code === 'ESRCH') return true
    // EPERM（进程存在但我们无权发信号，例如被接管的 adopted pid）：
    // 组还在，调用方会退回单 pid kill。
    return false
  }
  // 信号已送达，组此刻仍然存在（SIGTERM 是异步的）。
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
 *
 * 第二轮优化（长跑）：TTL 750ms 在看门狗 1s tick 下几乎等于每次都真扫 ——
 * 省不下任何一次扫描，却保留了缓存的全部复杂度。提到 3000ms 后，稳态下每
 * 3~4 个 tick 才扫一次。所有"端口即将易主"的调用点（startDsh / stopDsh /
 * waitForPortFree / restart）都已经显式 `invalidatePortScan()`，3 秒的陈旧
 * 窗口不会造成误判。
 */
const PORT_SCAN_TTL_MS = 3000
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

/**
 * 上一轮全量扫描得到的 socket inode → pid 映射。
 *
 * 稳态下（dsh 正常监听）端口上的 inode 集合每轮都一样，命中它的进程也不会
 * 变。所以先花 O(命中数 × fd) 去核对缓存里的候选 pid —— 通常只有 1 个进程、
 * 十几个 readlink —— 只有核对失败（进程换了、端口被抢占）才回到 O(全部进程
 * × 全部 fd) 的全量扫描。NAS 上这是从 ~4000 次系统调用降到 ~20 次的差别，
 * 也是面板空闲时 CPU 占用的主要来源。
 */
let inodeOwnerCache = new Map() // inode -> pid

/** 该 pid 是否仍持有这个 socket inode（一次 /proc/<pid>/fd 遍历）。 */
function pidHoldsInode(pid, inode) {
  if (!isAlive(pid)) return false
  let fds = []
  try { fds = readdirSync(`/proc/${pid}/fd`) } catch { return false }
  for (const fd of fds) {
    let link = ''
    try { link = readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { continue }
    if (link === `socket:[${inode}]`) return true
  }
  return false
}

/** Map socket inodes to pids via `/proc/<pid>/fd`. */
function pidsForInodes(inodes) {
  if (!inodes.size) return []
  const pids = new Set()

  // 快路径：核对上一轮的 inode → pid 映射。
  let allResolved = true
  for (const inode of inodes) {
    const pid = inodeOwnerCache.get(inode)
    if (pid && pidHoldsInode(pid, inode)) pids.add(pid)
    else allResolved = false
  }
  if (allResolved && pids.size) return [...pids]

  // 慢路径：全量扫描。
  //
  // 缓存里**只记本次查询的 inode**（而不是全系统每个 socket 都记一条）：
  // `findPidsOnPort()` 永远只查 dsh 那一个端口，给其余几万个 socket 各建一条
  // Map 记录换不来任何命中，纯占内存。查询集通常只有 1~3 个 inode，所以缓存规模
  // 被它封顶，且每次整体替换 —— 不会随重启次数累积陈旧条目。
  const found = new Map()
  let entries = []
  try { entries = readdirSync('/proc') } catch { return [...pids] }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    let fds = []
    try { fds = readdirSync(`/proc/${name}/fd`) } catch { continue }
    for (const fd of fds) {
      let link = ''
      try { link = readlinkSync(`/proc/${name}/fd/${fd}`) } catch { continue }
      const m = /^socket:\[(\d+)\]$/.exec(link)
      if (!m) continue
      if (inodes.has(m[1])) {
        pids.add(pid)
        // 同一个 socket 可能被多个 pid 持有（fork 继承）：旧实现会把它们都收下，
        // 这里保持同样语义，只在缓存里记第一个（快路径命中它即可）。
        if (!found.has(m[1])) found.set(m[1], pid)
        break
      }
    }
  }
  inodeOwnerCache = found
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

/**
 * Block for the port to actually free.
 *
 * 预算 1500ms 而不是 500ms：调用它的两处都在"刚刚 SIGTERM/SIGKILL 过"之后，
 * 而优雅关闭的 dsh 要 flush 日志/会话，几百毫秒很正常。500ms 太容易在进程还
 * 没退完时就判定"端口仍被占用"，调用方（尤其新加的 preStartSelfHeal）于是带着
 * 一个将死的监听去 spawn，撞上 EADDRINUSE。端口一旦真的释放，循环会立刻返回，
 * 所以放宽预算只影响失败路径，不拖慢正常停止。
 */
async function waitForPortFree(port) {
  const deadline = Date.now() + 1500
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
// Startup failure reporting
// ---------------------------------------------------------------------------

/** Rolling tail of dsh's stderr, kept only to explain a failed boot. */
let startupStderrTail = ''
let lastLaunchError = ''

/**
 * Accumulate dsh's stderr and pull out the single most useful line.
 *
 * dsh's failure output is chatty: a stack trace, a config dump, a "run
 * --dump-config-schema" hint. The line that names the actual problem is
 * whatever follows the last `Error:`/`WARNING:` marker, so prefer that and fall
 * back to the last non-empty line. Everything is still written to the log file;
 * this exists purely so the UI can say something better than "已停止".
 */
function rememberStartupStderr(chunk) {
  const text = String(chunk ?? '')
  startupStderrTail = (startupStderrTail + text).slice(-4096)
}

function lastStartupStderr() {
  const lines = startupStderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const marked = [...lines].reverse().find((line) => /error|错误|失败|unknown|invalid|unexpected|not found|EACCES|ENOENT/i.test(line))
  const picked = (marked ?? lines[lines.length - 1])
  return picked.length > 200 ? `${picked.slice(0, 200)}…` : picked
}

/** Clear the captured stderr; called just before a fresh launch. */
function resetStartupStderr() {
  startupStderrTail = ''
  lastLaunchError = ''
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
  let killedStale = false
  if (process.platform !== 'win32') {
    for (const pid of findPidsOnPort(port)) {
      if (pid === process.pid) continue
      try {
        if (!isDshProcess(pid)) continue
        process.kill(pid, 'SIGTERM')
        killedStale = true
        notes.push(`killed stale dsh pid ${pid} on port ${port}`)
      } catch { /* gone already, or unreadable */ }
    }
    // SIGTERM 是异步的：发完立刻往下走，startDsh 紧接着 spawn 新进程，而旧
    // 进程可能还握着端口 → 新进程直接 EADDRINUSE，UI 卡在「启动中」。
    // stopDsh() 结尾有这一步，启动路径此前缺了。
    if (killedStale) {
      await waitForPortFree(port)
      notes.push(`port ${port} released before launch`)
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
          await runWithTimeout('chown', [`${process.env.USER || 'fnos-dsh-manager'}:${process.env.USER || 'fnos-dsh-manager'}`, file], 3000)
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

  if (notes.length) appendLog(`[fnos-dsh-manager] self-heal: ${notes.join('; ')}\n`)
  return notes
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/**
 * dsh's launch arguments.
 *
 * Verified against the real CLI (`@deepseek-ai/dsh` 0.2.0-rc.2, `lib/bin.js`):
 *
 *  - **`web` is not a subcommand.** `parseDshArgs` treats any first argument
 *    that is neither an option nor `plugin` as a profile name and rewrites
 *    `["web", ...rest]` into `["--profile", "web", ...rest]`. So `dsh web --port N`
 *    is exactly `dsh --profile web --port N`, and `--port` is forwarded to the
 *    profile's app via the positional `[args...]` sink.
 *  - **The CLI itself defines only six options**: `--profile`, `--patch`,
 *    `--from-default-profile`, `--dump-config`, `--dump-config-schema`,
 *    `--dump-default-config`. There is **no `--trusted-host`**, no `--no-open`,
 *    no `--host`.
 *
 * That last point matters: this function used to append
 * `--trusted-host <h1> <h2> ... <hN>`. Because commander runs with
 * `allowUnknownOption()` and a positional `[args...]`, the flag *and every host
 * after it* fell through into the profile app's argv. The web profile's app
 * does not understand them, so dsh came up either failing validation or booting
 * with a mangled command line — which is the "dsh 启动但打不开 web" symptom.
 * The trusted-host list is not a CLI concern at all: dsh reads it from
 * `trusted_hosts.conf` in its home (see writeTrustedHosts), so nothing needs to
 * be passed here.
 *
 * `--no-open` is what the mature Go reference passes
 * (`deepseek.harness.fnos/harness.go`: `dshCliCmd("web", "--port", port, "--no-open")`)
 * to stop dsh trying to launch a desktop browser on a headless NAS. It arrives
 * in the same `[args...]` sink, so it is appended last and is safe to pass.
 */
function buildArgs(port) {
  return ['web', '--port', String(port), '--no-open']
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

export async function startDsh() {
  return serializeServiceOp(async () => {
  // 补丁自动内置：客户端 bundle 的 host-mode 补丁在每次启动前置自动应用
  // （幂等，已打过的文件跳过），不再有手动「应用补丁」页面。放在所有早退分支
  // 之前——包括「已有活进程直接复用」和「dsh 未安装」——这样新装/切换版本后
  // 只要还走过一次启动，bundle 就是修好的状态。best-effort，绝不阻塞启动。
  try {
    const patches = applyPatches()
    if (!patches.ok) appendLog(`[fnos-dsh-manager] client patch partially failed\n`)
  } catch (error) {
    appendLog(`[fnos-dsh-manager] client patch failed: ${error?.message ?? error}\n`)
  }

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
  // The previous attempt's stderr must not be blamed on this one.
  resetStartupStderr()

  // 状态机：进入启动中。
  SetStatus(StatusStarting, '正在启动服务…')

  // The `webserver` block must be on disk BEFORE dsh boots, because dsh reads it
  // while assembling the profile and ignores later edits to host/port. It used to
  // be written only by the /api/service routes, so any other path into this
  // function — the panel's own "resume last state" autostart, or a start
  // triggered from anywhere else — launched dsh against a stale or absent patch.
  // When that happened dsh fell back to its own built-in default, which binds
  // loopback on port 3080, while the panel then polled 28000 forever and the UI
  // showed "启动中" that never became "运行中". Write it here so every start path
  // is covered by construction.
  try {
    const binding = applyLanBinding()
    if (!binding.ok) appendLog(`[fnos-dsh-manager] lan binding skipped: ${binding.error}\n`)
    else appendLog(`[fnos-dsh-manager] lan binding: host=${binding.host} lan=${binding.lan}\n`)
  } catch (error) {
    appendLog(`[fnos-dsh-manager] lan binding failed: ${error?.message ?? error}\n`)
  }

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
  // nodeDirEnv 把 node 的 bin 目录 + 系统目录补进 PATH：面板自身是被 fnOS 套件
  // 框架降权启动的，环境里通常**没有 PATH**（实测 /proc/<pid>/environ 缺 PATH）。
  // 若原样 `...process.env` 传给 dsh，dsh 装插件时内部 pnpm 要执行依赖的
  // postinstall 脚本（如 protobufjs 的 `node scripts/postinstall`），spawn 的
  // shell 靠 PATH 找 `node` 却找不到 → `Failed to spawn lifecycle script ...
  // No such file or directory (os error 2)`。面板 spawn npm 时已经用 nodeDirEnv
  // 补过 PATH，这里 spawn dsh 也必须补，否则带 postinstall 的插件永远装不上。
  const env = nodeDirEnv({
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
    // ── 终端（xterm.js / node-pty）所需 ──
    // 面板是被 nohup 拉起的守护进程，没有控制终端，于是 TERM 压根不存在。
    // node-pty 会把 undefined 传给终端初始化程序，xterm/pty 侧的
    // terminfo 查找随之失败，表现就是「终端无法运行」或一进去就花屏/退出。
    // 所以必须显式给一个真实存在的终端类型；xterm-256color 支持颜色与常用能力。
    TERM: process.env.TERM || 'xterm-256color',
    // dsh 的代理/子进程还需要这两个（Go 版 InitAppEnv 同样设置）。
    // CI=true 让 dsh 不要尝试任何交互式 TTY 探测。
    CI: 'true',
    DSH_AGENTS_HOME: join(home, 'agents'),
  })
  // fd 提到 try 外面：spawn() 同步抛出时（ENOENT/EACCES/EMFILE）catch 分支
  // 必须能关掉它。此前 catch 分支漏了 closeSync，正是本模块专门修过的 fd
  // 泄漏（见下方 'exit' 处理里的注释）在同一个函数里的遗漏路径。
  let fd = null
  try {
    fd = openSync(DSH_LOG, 'a')
    // dsh runs AS the panel (no setuid) — the panel lacks CAP_SETUID, so any
    // `uid`/`gid` here fails with `spawn EPERM`. This matches the Go reference,
    // whose `SysProcAttr` only sets `Setpgid` and never drops privileges.
    //
    // stderr goes through a PIPE, not straight to the log file. dsh reports a
    // bad flag, a schema mismatch or a missing plugin on stderr and then exits,
    // so with `stdio: ['ignore','pipe',fd]` the panel could see the process die
    // but not WHY — the UI said only "已停止" and the reason was buried in a log
    // file nobody opens. Now the tail of stderr is captured and surfaced as the
    // status message, which is what turns "dsh 启动但打不开 web" into an
    // actionable message. It is still tee'd to the same file, unchanged.
    const spawnOpts = { env, cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    const child = spawn(launch.bin, [...launch.args, ...buildArgs(port)], spawnOpts)
    child.stdout.on('data', (chunk) => {
      try { writeSync(fd, chunk) } catch { /* log fd closed is fine */ }
      CaptureLaunchToken(chunk)
    })
    child.stderr.on('data', (chunk) => {
      try { writeSync(fd, chunk) } catch { /* log fd closed is fine */ }
      rememberStartupStderr(chunk)
    })
    child.on('error', (error) => {
      try { closeSync(fd) } catch { /* already closed */ }
      appendLog(`[fnos-dsh-manager] child error: ${error?.message ?? error}\n`)
      lastLaunchError = error?.message ?? String(error)
    })
    // A dsh that exits during startup almost always printed why on stderr, and
    // `watchForReady` would otherwise keep polling a dead pid until the 300s
    // timeout. Fail fast with the real reason instead.
    child.on('exit', (code, signal) => {
      // fd 泄漏修复：DSH_LOG 的 fd 此前从不 close，每次 startDsh/restart
      // （看门狗自愈、版本切换、补丁应用都会 restart）新开一个，长跑耗尽
      // 进程 fd 上限后 spawn 静默失败、日志全丢。子进程退出即归还。
      try { closeSync(fd) } catch { /* already closed */ }
      const detail = lastLaunchError || lastStartupStderr()
      appendLog(`[fnos-dsh-manager] dsh exited code=${code} signal=${signal}${detail ? `: ${detail}` : ''}\n`)
      if (managed.stopRequested) return
      if (currentPid() !== child.pid) return
      managed.pid = null
      managed.adoptedPid = null
      managed.failCount = 0
      removePidFileIfMatches(child.pid)
      SetStatus(StatusStopped, detail
        ? `dsh 启动即退出（code=${code}）：${detail}`
        : `dsh 启动即退出（code=${code}${signal ? `, signal=${signal}` : ''}），详见运行日志`)
      SetLastRunState(StatusStopped)
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
    // spawn() 同步抛出的分支同样开了 fd（openSync 在 try 内但在 spawn 之前）。
    if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
    appendLog(`[fnos-dsh-manager] spawn failed: ${error?.message ?? error}\n`)
    SetStatus(StatusStopped, `启动失败: ${error?.message ?? error}`)
    return { ok: false, error: 'spawn-failed' }
  }
  })
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
        appendLog(`[fnos-dsh-manager] ready: pid ${pid} responding on port ${port}\n`)
      }
      return
    }

    if (Date.now() - startedAt >= timeoutMs) {
      appendLog(`[fnos-dsh-manager] ready timeout (${timeoutMs / 1000}s) on port ${port}\n`)
      if (currentPid() === pid && !managed.stopRequested) {
        SetStatus(StatusStopped, `Web 就绪探测超时 (端口 ${port} 未响应)`)
      }
      return
    }
    setTimeout(tick, 500)
  }
  setTimeout(tick, 500)
}
// setTimeout 链 unref：进程退出时最多拖 500ms 的问题已由调用处 .unref() 不可行
// （tick 是 async 重排的），保持现状可接受——watchForReady 最长 300s 但进程
// 存活期间本就有看门狗常驻。

/**
 * Stop dsh, three-stage: SIGTERM the process group → poll → SIGKILL the group,
 * then sweep the port for any stragglers and wait for the port to free. This
 * mirrors the Go version's `killHarnessLocked` (no orphan children holding the
 * port and causing the next start to die with EADDRINUSE).
 */
export async function stopDsh() {
  return serializeServiceOp(async () => {
    managed.stopRequested = true
    // The port is about to change hands; a memoised scan would report the old
    // listener for another 750ms and make the sweep below look like it failed.
    invalidatePortScan()

    const port = listenPort()
    const pid = currentPid() || readPid()

    if (pid && isAlive(pid)) {
      appendLog(`[fnos-dsh-manager] stop: SIGTERM group ${pid}\n`)
      await killProcessGroup(pid)
      await killProcessTree(pid)
      removePidFileIfMatches(pid)
    }

    // Sweep the port for any dsh-owned stragglers the group kill missed.
    for (const p of findPidsOnPort(port)) {
      if (!isAlive(p)) continue
      if (!isDshProcess(p)) {
        appendLog(`[fnos-dsh-manager] port ${port} held by foreign pid ${p}; left alone\n`)
        continue
      }
      appendLog(`[fnos-dsh-manager] stop: kill straggler pid ${p} on port ${port}\n`)
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
  })
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
 * Only a POSITIVE verdict is cached. A negative says nothing reliable about
 * the next millisecond — dsh is mid-boot, or the probe simply lost a race — and
 * serving a stale "not reachable" made the UI flip-flop between 运行中 and
 * 启动中 for a service that was up and answering (observed: healthy=true at
 * t+1s, false at t+3s, true at t+7s while a direct request returned 200
 * throughout). Caching only success keeps the win that matters — a running dsh
 * costs one probe per 1.5s no matter how many status calls arrive — while a
 * stopped/unreachable dsh is re-probed, which is exactly when the answer is
 * cheap (connection refused returns immediately) and the freshness matters.
 *
 * A `force` flag exists for the call sites that must not read a cached verdict
 * at all (the stop/start sequences and the restart wait loop).
 */
const HEALTH_TTL_MS = 1500
const healthCache = new Map() // port -> { at, result }

export function invalidateHealth() {
  healthCache.clear()
}

async function probeHealth(port, { force = false } = {}) {
  if (!force) {
    const hit = healthCache.get(port)
    if (hit?.result?.reachable && Date.now() - hit.at < HEALTH_TTL_MS) return hit.result
  }
  const result = await probeHealthUncached(port)
  if (result.reachable) healthCache.set(port, { at: Date.now(), result })
  else healthCache.delete(port)
  return result
}

async function probeHealthUncached(port) {
  const bound = webserverHost()
  // Loopback first, always. dsh binds exactly ONE address, and the panel reaches
  // it over loopback in every supported deployment; a target derived from a
  // possibly-stale patch is only a fallback. The mature reference hard-codes
  // 127.0.0.1 for exactly this reason (`waitAndActivateReverseProxy` probes
  // `http://127.0.0.1:<port>` and TCP-dials the same).
  const targets = [...new Set(['127.0.0.1', bound, ...lanAddresses().slice(0, 1)])].filter(Boolean)
  for (const host of targets) {
    if (await probeHttpOnce(host, port)) return { reachable: true, status: 200 }
    // TCP fallback: dsh can hold the port open while an HTTP request still
    // fails — it has bound but not finished mounting, or it is slow on the very
    // first hit. "The port is open" is enough to call it up and let the caller
    // surface a genuine HTTP error, instead of looping until the 300s timeout
    // and reporting a misleading "启动失败" (the reference does the same).
    if (await probeTcpOnce(host, port)) return { reachable: true, status: 0, tcpOnly: true }
  }
  return { reachable: false, status: 0 }
}

/** One HTTP GET against a candidate host, with a hard deadline. */
async function probeHttpOnce(host, port) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`http://${host}:${port}/`, {
      redirect: 'manual',
      signal: controller.signal,
    })
    // Release the socket instead of leaving it for the GC.
    try { await response.body?.cancel() } catch { /* already consumed */ }
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** TCP-connect fallback so "bound but not serving yet" still counts as up. */
function probeTcpOnce(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (ok) => {
      clearTimeout(timer)
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), HEALTH_TCP_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Per-target abort budget for one HTTP health probe. */
const HEALTH_PROBE_TIMEOUT_MS = 1500
/** Per-target budget for the TCP fallback connect. */
const HEALTH_TCP_TIMEOUT_MS = 1000

/**
 * Service-op mutex: concurrent start/stop/restart (UI double-click, retry
 * storms, watchdog adopt racing a manual start) previously interleaved
 * read-modify-write on `managed` + pidfile — a stop could wipe a just-written
 * pid of a concurrent start, or two dsh children could end up alive. All
 * service operations are serialized through one promise chain instead.
 */
let serviceOpChain = Promise.resolve()
function serializeServiceOp(fn) {
  const run = serviceOpChain.then(fn, fn)
  // Keep the chain alive even if fn rejects: the next op must still run.
  serviceOpChain = run.then(() => {}, () => {})
  return run
}

/**
 * Stop and relaunch dsh with a freshly written patch, then wait for the port.
 *
 * 注意：这里**不能**再包一层 serializeServiceOp —— stopDsh/startDsh 各自已经
 * 串行化，若 restart 也入链，则 `await stopDsh()` 会排到 restart 自己之后，
 * 形成自死锁、永不返回。restart 通过依次 await 两个已串行化的子操作，
 * 天然获得同样的互斥效果。
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
      appendLog(`[fnos-dsh-manager] watchdog: adopted pid ${adopted} on port ${port}\n`)
      managed.adoptedPid = adopted
      writePid(adopted)
    }
    return
  }

  // Tolerate a few transient ticks (process restarting, port still binding).
  managed.failCount += 1
  if (managed.failCount <= 3) return

  // Confirmed dead with no successor: clear stale state.
  appendLog(`[fnos-dsh-manager] watchdog: pid ${pid} dead and port ${port} unresponsive; clearing\n`)
  removePidFileIfMatches(pid)
  managed.pid = null
  managed.adoptedPid = null
  managed.failCount = 0
  // 进程意外退出 → token 作废，清掉避免反代用旧 token 换到失效 Cookie。
  SetCurrentLaunchToken('')
  // 状态机对齐：进程确实没了，别再让 UI 显示 running。
  if (GetStatus() !== StatusStopped) {
    // Prefer dsh's own last word (captured from stderr) over a generic message —
    // a bare "进程意外退出" gives the operator nothing to act on.
    const detail = lastStartupStderr()
    SetStatus(StatusStopped, detail ? `dsh 已退出：${detail}` : 'dsh 进程意外退出（详见运行日志）')
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
