/**
 * 系统资源占用读取：CPU、内存、磁盘、负载、进程数。
 *
 * 从 Linux 的 /proc 和 /sys 直接读取 CPU/内存/负载（零外部依赖），磁盘容量
 * 走 statvfs(2)（fs.statfsSync），同样零子进程；仅在 statfs 不可用时降级到
 * 一次 `df -k -P` 并被 30s 缓存兜住。
 * 每个采样都带 try/catch，单个指标失败不影响其余指标。
 *
 * 全模块**不得出现同步子进程**：`/api/resources` 被概览页每 3 秒轮询，任何
 * spawnSync/execSync 都会按轮询频率周期性冻结整个面板的事件循环。
 *
 * 关键诚实点：
 *  - CPU 百分比是「两次采样之间的差值」，所以 readResources() 内部记住上一次
 *    的 /proc/stat 快照，第一次调用返回 null（无基线，前端显示为「—」）。
 *  - 内存的 available 比 free 更有意义（含可回收的 page cache）。
 */

import { readFileSync, statfsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { totalmem, freemem, loadavg, cpus, uptime } from 'node:os'

/** 上一次 /proc/stat 的 CPU 快照，用于差值计算。 */
let prevCpu = null

/** 解析 /proc/stat 的 CPU 行（"cpu  123 4 56 ..."）。 */
function readCpuSample() {
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const line = stat.split('\n').find((l) => l.startsWith('cpu '))
    if (!line) return null
    const nums = line.slice(3).trim().split(/\s+/).map(Number)
    const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = nums
    const total = (user + nice + system + idle + iowait + irq + softirq + steal) || 1
    const busy = total - idle - iowait
    return { total, busy }
  } catch {
    return null
  }
}

/** CPU 使用率（0-100），需要两次采样。首次返回 null。 */
function cpuPercent() {
  const now = readCpuSample()
  if (!now) return null
  if (!prevCpu) {
    prevCpu = now
    return null
  }
  const dt = now.total - prevCpu.total
  const db = now.busy - prevCpu.busy
  prevCpu = now
  if (dt <= 0) return 0
  return Math.min(100, Math.max(0, (db / dt) * 100))
}

/** 内存：/proc/meminfo 里最关心的几项（单位字节）。 */
function memoryInfo() {
  const out = { total: totalmem(), free: freemem(), available: 0, cached: 0, buffers: 0, used: 0, percent: 0 }
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const get = (key) => {
      const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)
      return m ? Number(m[1]) * 1024 : 0
    }
    out.available = get('MemAvailable') || get('MemFree')
    out.cached = get('Cached')
    out.buffers = get('Buffers')
    out.total = get('MemTotal') || out.total
    out.used = out.total - out.available
    out.percent = out.total ? (out.used / out.total) * 100 : 0
  } catch {}
  return out
}

/** 挂载点列表（真实块设备，跳过虚拟 fs）。 */
function mountPoints() {
  const mounts = []
  try {
    const mtab = readFileSync('/proc/mounts', 'utf8')
    for (const line of mtab.split('\n')) {
      const parts = line.split(' ')
      if (parts.length < 3) continue
      const [device, mount, fs] = parts
      if (!device.startsWith('/dev/')) continue
      mounts.push({ device, mount, fs })
    }
  } catch {}
  if (!mounts.length) mounts.push({ device: 'rootfs', mount: '/', fs: 'unknown' })
  return mounts
}

/**
 * 磁盘容量：**默认不再 fork `df`**。
 *
 * 概览页每 3 秒轮询一次 `/api/resources`，旧实现在这里 `spawnSync('df', ...)`。
 * `spawnSync` 会**完全阻塞** Node 主线程：期间所有 HTTP 请求、WebSocket 推送、
 * 看门狗 tick 全部停摆。NAS 上 fork 一次通常数十毫秒，磁盘繁忙（USB/阵列唤醒）
 * 时可达数百毫秒 —— 而这只是为了读一个分钟级才变化的数字。
 *
 * 同项目的 dashboard-process.js 早已因为完全相同的理由把 `ss -ltnp` 换成了读
 * /proc（那里有大段注释论证「同步子进程会阻塞每一个 in-flight 请求」），这里
 * 属于同一处遗漏。
 *
 * `fs.statfsSync()` 是 statvfs(2) 的直接绑定：零子进程、零阻塞、几十微秒，
 * 且字段与 `df -k -P` 一一对应：
 *   total = blocks*bsize，used = (blocks-bfree)*bsize，available = bavail*bsize
 * 只有在 statfs 不可用（极旧内核/Node）时才退回 `df`，并被 30s 缓存兜住，
 * 保证降级路径也最多每 30 秒阻塞一次而不是每 3 秒。
 */
const DISK_FALLBACK_TTL_MS = 30000
let diskFallbackCache = { at: 0, value: null }

function diskUsage() {
  const mounts = mountPoints()
  if (typeof statfsSync === 'function') {
    return mounts.map((m) => {
      try {
        const s = statfsSync(m.mount)
        const bsize = s.bsize || 4096
        const total = Number(s.blocks) * bsize
        const freeBlocks = Number(s.bfree ?? 0)
        const availBlocks = Number(s.bavail ?? freeBlocks)
        return {
          ...m,
          total,
          used: total - freeBlocks * bsize,
          available: availBlocks * bsize,
          present: true,
        }
      } catch {
        // 挂载点已消失/无权限：只报存在性，不拖垮整个接口。
        return { ...m, present: true }
      }
    })
  }

  // ── 降级路径：statfs 不可用 ──
  const now = Date.now()
  if (diskFallbackCache.value && now - diskFallbackCache.at < DISK_FALLBACK_TTL_MS) {
    return diskFallbackCache.value.map((d) => ({ ...d }))
  }
  // mounts 上面已经读过一次，直接复用，不要再读一遍 /proc/mounts。
  const fallback = mounts.map((m) => ({ ...m, present: true }))
  const value = diskUsageViaDf(mounts, fallback)
  diskFallbackCache = { at: now, value }
  return value.map((d) => ({ ...d }))
}

/** `df -k -P`（POSIX 输出，字段稳定），失败则回退到仅报告挂载点存在性。 */
function diskUsageViaDf(mounts, fallback) {
  let dfOut = ''
  try {
    const r = spawnSync('df', ['-k', '-P'], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0 || !r.stdout) return fallback
    dfOut = r.stdout
  } catch {
    return fallback
  }

  const byMount = new Map()
  for (const line of dfOut.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const [fs, kbTotal, kbUsed, kbAvail, , mount] = parts
    byMount.set(mount, {
      device: fs,
      mount,
      fs: '',
      total: Number(kbTotal) * 1024,
      used: Number(kbUsed) * 1024,
      available: Number(kbAvail) * 1024,
      present: true,
    })
  }

  // 用 df 的结果补全挂载点（fs 类型从 /proc/mounts 拿）
  return mounts.map((m) => {
    const usage = byMount.get(m.mount)
    return usage ? { ...m, ...usage, fs: m.fs } : { ...m, present: true }
  })
}

/** 收集所有资源指标。 */
export function readResources() {
  const mem = memoryInfo()
  const cpu = cpuPercent()
  const load = loadavg()
  // cpus() 每次调用都要重新组装数组（含 model 字符串解析），这里只调一次。
  const cores = cpus()

  return {
    cpu: {
      percent: cpu, // null = 尚无基线（首次）
      cores: cores.length,
      model: cores[0]?.model ?? null,
      load: { one: load[0], five: load[1], fifteen: load[2] },
    },
    memory: {
      total: mem.total,
      used: mem.used,
      available: mem.available,
      free: mem.free,
      cached: mem.cached,
      buffers: mem.buffers,
      percent: mem.percent,
    },
    uptime: uptime(),
    disks: diskUsage(),
    sampledAt: Date.now(),
  }
}
