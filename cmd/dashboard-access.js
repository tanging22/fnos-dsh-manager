/**
 * Recent-visitor log.
 *
 * dsh itself records no access records, so anything purporting to show "who
 * visited" has to observe traffic somewhere. The panel therefore owns a reverse
 * proxy (see server.js), and this module is its durable side: every proxied
 * request appends one record to a JSONL file, newest-last.
 *
 * Retention follows the toggle: turning recording off also stops retaining, and
 * the file is capped at `access.max` (default 500) records.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DATA_DIR, loadConfig } from './dashboard-config.js'

/** JSONL append-only log; one record per proxied request. */
export const ACCESS_LOG_PATH = `${DATA_DIR}/access.log`

/** JSONL log of panel sign-ins; one record per attempt (ok or rejected). */
export const LOGIN_LOG_PATH = `${DATA_DIR}/login.log`

let queue = []
let flushing = false
let timer = null
let retryTimer = null
let droppedCount = 0

function ensureFile() {
  mkdirSync(dirname(ACCESS_LOG_PATH), { recursive: true })
  if (!existsSync(ACCESS_LOG_PATH)) writeFileSync(ACCESS_LOG_PATH, '', 'utf8')
}

/** 保留完整 IP 供运维精确定位访客（首页「最近访问」与「访问记录」页都用它）。 */
export function redactIp(ip) {
  const text = String(ip ?? '').trim()
  return text
}

export function recordVisit({ ip, method, path, status, tookMs, auth = 'anonymous', userAgent = '' }) {
  if (!loadConfig().access?.enabled) return
  queue.push({
    ts: new Date().toISOString(),
    ip: redactIp(ip),
    method: String(method ?? '').toUpperCase(),
    path: String(path ?? ''),
    status: Number(status ?? 0),
    tookMs: Number(tookMs ?? 0),
    auth,
    userAgent: String(userAgent).slice(0, 160),
  })
  if (queue.length >= 20) void flush()
  else if (!timer) timer = setTimeout(() => { timer = null; void flush() }, 1000)
}

export async function flush() {
  if (flushing || !queue.length) return
  flushing = true
  const batch = queue
  queue = []
  try {
    ensureFile()
    appendFileSync(ACCESS_LOG_PATH, `${batch.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
    invalidateStats()
    trimLog()
  } catch {
    // 无界 requeue 修复：写失败（磁盘满/只读）时若无限制地把整批塞回队列，
    // 每个代理请求仍持续 push → queue 只增不减，长期运行内存泄漏。改成
    // 硬上限：超出的丢最旧（并计丢失数），绝不让队列无限膨胀。
    const merged = batch.concat(queue)
    const MAX_PENDING = 1000
    droppedCount += Math.max(0, merged.length - MAX_PENDING)
    queue = merged.slice(-MAX_PENDING)
    // 失败后安排一次退避重试，否则唯一触发 flush 的途径是再来 20 条。
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; void flush() }, 5000)
      retryTimer.unref?.()
    }
  } finally {
    flushing = false
  }
}

function trimLog() {
  const max = Math.max(1, Number(loadConfig().access?.max ?? 500))
  try {
    const lines = readFileSync(ACCESS_LOG_PATH, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= max) return
    const tmp = `${ACCESS_LOG_PATH}.tmp`
    writeFileSync(tmp, `${lines.slice(lines.length - max).join('\n')}\n`, 'utf8')
    renameSync(tmp, ACCESS_LOG_PATH)
  } catch {}
}

/** Newest-first, each remote address counted once per most-recent visit. */
export function recentVisitors(limit = 50) {
  const max = Math.max(1, Number(limit))
  let lines = []
  try {
    lines = readFileSync(ACCESS_LOG_PATH, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch { /* skip a torn trailing line */ }
  }
  return out
}

export function clearVisitors() {
  try {
    ensureFile()
    writeFileSync(ACCESS_LOG_PATH, '', 'utf8')
    invalidateStats()
  } catch {}
}

/**
 * Newest-first list of sign-in attempts.
 *
 * Read-only on purpose: v1.0.20 removed the panel's own password gate (fnOS's
 * gateway authenticates), so nothing calls `recordLogin` any more and no new
 * `login.log` rows are written. The reader stays because the two endpoints that
 * surface it (`/api/access/login` and `recentLogin` in `/api/status`) still
 * resolve, and an install that predates the auth removal may have real history
 * in the file — those records remain useful ("was this my session?").
 */
export function recentLogins(limit = 50) {
  const max = Math.max(1, Number(limit))
  let lines = []
  try {
    lines = readFileSync(LOGIN_LOG_PATH, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch { /* skip a torn trailing line */ }
  }
  return out
}

/**
 * Byte/line summary for the status card.
 *
 * Memoised against the log's own (size, mtime): `/api/status` runs this on every
 * poll and it used to read the entire file (up to `access.max` records) each
 * time, purely to count lines. A `statSync` is enough to know whether the cached
 * answer is still good, and the file only changes when a flush happens — which
 * invalidates it in the same module.
 */
let statsCache = { at: 0, bytes: 0, lines: 0, size: -1, mtime: 0 }

export function accessLogStats() {
  try {
    if (!existsSync(ACCESS_LOG_PATH)) return { bytes: 0, lines: 0 }
    const st = statSync(ACCESS_LOG_PATH)
    const now = Date.now()
    if (st.size === statsCache.size && st.mtimeMs === statsCache.mtime) {
      return { bytes: statsCache.bytes, lines: statsCache.lines }
    }
    const bytes = st.size
    // Count newlines instead of building an array of every line: this is a
    // count, and splitting allocates a string per record for nothing.
    const text = readFileSync(ACCESS_LOG_PATH, 'utf8')
    let lines = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lines += 1
    }
    if (text.length && !text.endsWith('\n')) lines += 1
    statsCache = { at: now, bytes, lines, size: st.size, mtime: st.mtimeMs }
    return { bytes, lines }
  } catch {
    return { bytes: 0, lines: 0 }
  }
}

/** Forget the memoised stats (called whenever the log is rewritten). */
function invalidateStats() {
  statsCache = { at: 0, bytes: 0, lines: 0, size: -1, mtime: 0 }
}
