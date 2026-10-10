/**
 * dsh 进程树 CPU/内存采样器（对齐 Go 版 `process.go` 的 `StartUsageSampler` +
 * `calculateDshUsage`）。
 *
 * 与 dashboard-resources.js 的「整机资源」互补：本模块只算 **dsh 进程树** 的
 * 常驻内存与相对整机算力的 CPU 百分比，供 UI 单独展示 dsh 吃了多少资源。
 *
 * 移植自 Go 版的关键可靠性点：
 *  - 进程树聚合：读 /proc/<pid>/task/<pid>/children 递归收集子孙，累加每个
 *    进程的 utime+stime（/proc/<pid>/stat）与 VmRSS（/proc/<pid>/status）。
 *  - CPU 是两次采样的差值：`deltaProc / deltaSys * 100`，且
 *    进程重启 / 时钟回跳 / 跨度 > 3s 时重置样本，防异常突刺；结果钳位 [0,100]。
 *  - 无订阅者时彻底挂起（0 CPU 唤醒），有订阅者才 1s 采样一次。
 *  - 缓存最近一帧 + 广播（值变化或 5s 心跳保底才推，避免刷屏）。
 */

import { readFileSync } from 'node:fs'

/** 最近一帧采样结果（缓存，供 /api/usage 秒回）。 */
const cache = { cpu: '-', memory: '-' }

/** 订阅者集合。 */
const subscribers = new Set()

/** 采样基准（Go: `procSample`）。 */
let lastSamplePid = 0
let lastTicks = 0
let lastSysTotal = 0
let lastSampleAt = 0

/** 心跳去重（Go: `broadcastUsageIfChanged`）。 */
let lastSentCpu = null
let lastSentMem = null
let lastSentAt = 0

// ---------------------------------------------------------------------------
// /proc 读取
// ---------------------------------------------------------------------------

/** 单进程常驻内存 KB（Go: `readProcRssKb`）。 */
function readProcRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+)/m.exec(status)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/** 系统总 CPU 时间（所有核心累加，jiffies）。Go: `readSystemTotalJiffies`。 */
function readSystemTotalJiffies() {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const line = stat.split('\n').find((l) => l.startsWith('cpu '))
    if (!line) return 0
    const fields = line.slice(3).trim().split(/\s+/).map(Number)
    return fields.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0)
  } catch {
    return 0
  }
}

/** 单进程 CPU ticks（utime + stime）。Go: `readProcTicks`。 */
function readProcTicks(pid) {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // 进程名可能含空格/括号，从最后一个 ')' 之后开始解析字段。
    const idx = content.lastIndexOf(')')
    if (idx === -1 || idx + 2 >= content.length) return null
    const fields = content.slice(idx + 2).trim().split(/\s+/)
    // fields[11]=utime, fields[12]=stime（相对 ')' 后第 0 个是 state 字段）。
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
    return utime + stime
  } catch {
    return null
  }
}

/** 递归收集 rootPid 及其所有子孙 pid。Go: `getFamilyPids`。 */
function getFamilyPids(rootPid, acc = []) {
  if (rootPid <= 0) return acc
  acc.push(rootPid)
  try {
    const children = readFileSync(`/proc/${rootPid}/task/${rootPid}/children`, 'utf8')
    for (const field of children.trim().split(/\s+/)) {
      const childPid = Number(field)
      if (Number.isInteger(childPid) && childPid > 0) getFamilyPids(childPid, acc)
    }
  } catch { /* 进程已退出或 children 不可读：到此为止 */ }
  return acc
}

/** 聚合进程树 CPU ticks 与常驻内存 KB。Go: `getDshTreeStats`。 */
function getDshTreeStats(mainPid) {
  if (mainPid <= 0 || process.platform !== 'linux') return { ticks: 0, rssKb: 0 }
  let ticks = 0
  let rssKb = 0
  for (const pid of getFamilyPids(mainPid)) {
    const t = readProcTicks(pid)
    if (t != null) ticks += t
    rssKb += readProcRssKb(pid)
  }
  return { ticks, rssKb }
}

/** 格式化内存字符串（Go 版同款：MB 或 GB，一位小数）。 */
function formatMemory(rssKb) {
  if (rssKb >= 1024 * 1024) return `${(rssKb / (1024 * 1024)).toFixed(1)} GB`
  return `${(rssKb / 1024).toFixed(1)} MB`
}

/**
 * 计算 dsh 进程树的 CPU 百分比与内存。返回 `{ cpu, memory }` 字符串。
 * Go: `calculateDshUsage`。
 */
function calculateDshUsage(pid) {
  if (pid <= 0 || process.platform !== 'linux') return { cpu: '-', memory: '-' }

  const { ticks, rssKb } = getDshTreeStats(pid)
  if (ticks === 0 && rssKb === 0) return { cpu: '-', memory: '-' }

  const memStr = formatMemory(rssKb)

  const sysTotal = readSystemTotalJiffies()
  if (sysTotal === 0) return { cpu: '-', memory: memStr }

  const now = Date.now()

  // 进程重启 / 时钟回跳 / 跨度 > 3s：重置样本，返回 0%（Go 版同款防突刺）。
  if (lastSamplePid !== pid || ticks < lastTicks || sysTotal <= lastSysTotal || now - lastSampleAt > 3000) {
    lastSamplePid = pid
    lastTicks = ticks
    lastSysTotal = sysTotal
    lastSampleAt = now
    return { cpu: '0.0%', memory: memStr }
  }

  const deltaSys = sysTotal - lastSysTotal
  const deltaProc = ticks - lastTicks

  lastTicks = ticks
  lastSysTotal = sysTotal
  lastSampleAt = now

  if (deltaSys === 0 || deltaProc === 0) return { cpu: '0.0%', memory: memStr }

  let pct = (deltaProc / deltaSys) * 100
  if (pct < 0) pct = 0
  else if (pct > 100) pct = 100
  return { cpu: `${pct.toFixed(1)}%`, memory: memStr }
}

// ---------------------------------------------------------------------------
// 采样循环（Go: `StartUsageSampler`）
// ---------------------------------------------------------------------------

/** 由 dashboard-process.js 注入的「当前 dsh 主进程 pid」解析函数。 */
let resolveTargetPid = () => 0

/**
 * 设置目标 pid 解析函数。由 dashboard-process.js 在加载时注入（避免循环依赖：
 * usage 模块需要 process 模块的 getTargetDshPid，而 process 模块反过来广播 usage）。
 */
export function setTargetPidResolver(fn) {
  resolveTargetPid = fn
}

function sampleOnce() {
  if (process.platform !== 'linux') {
    updateAndBroadcast('-', '-')
    return
  }
  const pid = resolveTargetPid()
  if (pid <= 0) {
    updateAndBroadcast('-', '-')
    return
  }
  const { cpu, memory } = calculateDshUsage(pid)
  updateAndBroadcast(cpu, memory)
}

function updateAndBroadcast(cpu, memory) {
  cache.cpu = cpu
  cache.memory = memory
  broadcastIfChanged(cpu, memory)
}

function broadcastIfChanged(cpu, memory) {
  const now = Date.now()
  const changed = cpu !== lastSentCpu || memory !== lastSentMem
  const heartbeatDue = now - lastSentAt >= 5000
  if (!changed && !heartbeatDue) return

  lastSentCpu = cpu
  lastSentMem = memory
  lastSentAt = now

  for (const fn of subscribers) {
    try { fn({ cpu, memory }) } catch {}
  }
}

/**
 * 订阅 usage 推送。首个订阅者接入时立即采样并推首帧（Go 版 `SubscribeUsage`
 * 的 `wakeUsageCh` 语义），返回取消订阅函数。
 */
export function SubscribeUsage(fn) {
  const wasEmpty = subscribers.size === 0
  subscribers.add(fn)
  if (wasEmpty) {
    // 立即采样建立基准并推首帧
    sampleOnce()
  } else {
    try { fn({ cpu: cache.cpu, memory: cache.memory }) } catch {}
  }
  return () => {
    subscribers.delete(fn)
  }
}

/** 启动采样协程。无订阅者时挂起（不清除 CPU 定时器，用惰性 tick 简化）。 */
export function StartUsageSampler() {
  setInterval(() => {
    if (subscribers.size === 0) return // 无订阅者：0 成本空转
    sampleOnce()
  }, 1000).unref()
}

/** 最近一帧缓存（供 /api/usage 秒回，无需等下一 tick）。 */
export function GetCachedUsage() {
  return { cpu: cache.cpu, memory: cache.memory }
}
