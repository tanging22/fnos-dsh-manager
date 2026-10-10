/**
 * 显式服务状态机（对齐 Go 版 `HarnessState`）+ 上次运行状态持久化。
 *
 * Go 版用五态 `HarnessState`（stopped/starting/running/building/snapshotting）
 * 驱动 UI 与自启决策，而非每次读 pid 临时推导。这里搬到 Node 版：
 *
 *  - 五态常量 + `SetStatus(status, msg)`，变更时才通知订阅者（无订阅挂起）。
 *  - `SubscribeState()` 返回一个唤醒函数，订阅者（WebSocket 推送 / status 轮询）
 *    靠它感知状态变化，避免轮询。
 *  - `LastRunState` 持久化到 `${DATA_DIR}/run-state.json`，面板重启后 `InitHarness`
 *    据它决定是否自动拉起 dsh（对应 Go 版 `GetLastRunState`/`SetLastRunState`）。
 *
 * 五态含义：
 *  - stopped      dsh 未运行
 *  - starting     主进程已拉起，等待 Web 就绪
 *  - running      Web 端口已响应（健康）
 *  - building     部署/升级运行环境（Node 版当前无离线包，预留）
 *  - snapshotting 快照维护中（预留）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './dashboard-utils.js'

export const StatusStopped = 'stopped'
export const StatusStarting = 'starting'
export const StatusRunning = 'running'
export const StatusBuilding = 'building'
export const StatusSnapshotting = 'snapshotting'

/** 上次运行状态持久化文件。 */
const RUN_STATE_PATH = join(DATA_DIR, 'run-state.json')

// ---------------------------------------------------------------------------
// 状态机（Go: `HarnessState`）
// ---------------------------------------------------------------------------

const state = {
  status: StatusStopped,
  lastMessage: '',
  targetVersion: '',
  startedAt: 0, // unix ms，running 态起点
}

/** 订阅者集合。用简单回调而非 channel：Node 单线程，无需跨 goroutine 信号。 */
const subscribers = new Set()

function notify() {
  for (const fn of subscribers) {
    try { fn(snapshot()) } catch { /* 一个坏订阅者不得拖垮广播 */ }
  }
}

/**
 * 变更状态。仅在 status 或 message 变化时通知订阅者。
 * `becameRunning` 时记录启动时刻（供 uptime 计算）。
 */
export function SetStatus(status, msg = '') {
  const oldStatus = state.status
  const becameRunning = status === StatusRunning && state.status !== status
  const changed = state.status !== status || state.lastMessage !== msg

  state.status = status
  state.lastMessage = msg
  if (status !== StatusBuilding) state.targetVersion = ''
  if (becameRunning) state.startedAt = Date.now()

  if (changed) {
    if (oldStatus !== status) {
      // 状态跃迁写进面板日志，便于排查（对应 Go 版 LogInfo("[状态] …")）
      logState(oldStatus, status, msg)
    }
    notify()
  }
}

function logState(oldStatus, status, msg) {
  // 借用 process.js 的 appendLog 会引入循环依赖；这里直接写控制台即可。
  // 面板启动/停止的日志已由 process.js 的 appendLog 覆盖，状态跃迁仅作调试辅助。
  if (process.env.DSH_DEBUG_STATE) {
    console.log(`[fnos-dsh-manager] [状态] ${oldStatus} → ${status}${msg ? `: ${msg}` : ''}`)
  }
}

export function SetTargetVersion(tv) {
  if (state.targetVersion !== tv) {
    state.targetVersion = tv
    notify()
  }
}

export function GetStatus() {
  return state.status
}

/** 完整状态快照（供 /api/status 与订阅推送）。 */
export function snapshot() {
  const running = state.status === StatusRunning
  const uptime = running && state.startedAt ? Date.now() - state.startedAt : 0
  return {
    status: state.status,
    lastMessage: state.lastMessage,
    targetVersion: state.targetVersion,
    startedAt: running && state.startedAt ? state.startedAt : 0,
    uptime,
  }
}

/**
 * 订阅状态变更，返回取消订阅函数。首个订阅者接入时立即回调一次当前快照，
 * 避免订阅者错过「当前已是 running」的初始态。
 */
export function SubscribeState(fn) {
  subscribers.add(fn)
  try { fn(snapshot()) } catch {}
  return () => {
    subscribers.delete(fn)
  }
}

/** 手动触发一次广播（状态未变但需刷新订阅者的场合，如端口探测完成）。 */
export function Poke() {
  notify()
}

// ---------------------------------------------------------------------------
// 上次运行状态持久化（Go: `GetLastRunState` / `SetLastRunState`）
// ---------------------------------------------------------------------------

/** 读取上次运行状态，默认 stopped（首次启动）。 */
export function GetLastRunState() {
  try {
    if (!existsSync(RUN_STATE_PATH)) return StatusStopped
    const raw = JSON.parse(readFileSync(RUN_STATE_PATH, 'utf8'))
    const st = raw?.lastRunState
    if (st === StatusRunning || st === StatusStarting) return st
    return StatusStopped
  } catch {
    return StatusStopped
  }
}

/** 持久化上次运行状态（原子写：先 .tmp 再 rename）。 */
export function SetLastRunState(status) {
  try {
    mkdirSync(dirname(RUN_STATE_PATH), { recursive: true })
    const tmp = `${RUN_STATE_PATH}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ lastRunState: status }, null, 2)}\n`, 'utf8')
    renameSync(tmp, RUN_STATE_PATH)
  } catch { /* 只读数据目录不得阻止面板启动 */ }
}
