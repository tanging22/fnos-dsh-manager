/**
 * 系统资源占用读取：CPU、内存、磁盘、负载、进程数。
 *
 * 从 Linux 的 /proc 和 /sys 直接读取 CPU/内存/负载（零外部依赖），磁盘容量
 * 用一次 `df -k -P`（fnOS 自带 busybox df），失败时降级为仅报告挂载点。
 * 每个采样都带 try/catch，单个指标失败不影响其余指标。
 *
 * 关键诚实点：
 *  - CPU 百分比是「两次采样之间的差值」，所以 readResources() 内部记住上一次
 *    的 /proc/stat 快照，第一次调用返回 null（无基线，前端显示为「—」）。
 *  - 内存的 available 比 free 更有意义（含可回收的 page cache）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
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
 * 磁盘容量：优先用 `df -k -P`（POSIX 输出，字段稳定），失败则回退到仅
 * 报告挂载点存在性。单位统一换算成字节。
 */
function diskUsage() {
  const fallback = mountPoints().map((m) => ({ ...m, present: true }))
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
  const disks = mountPoints().map((m) => {
    const usage = byMount.get(m.mount)
    return usage ? { ...m, ...usage, fs: m.fs } : { ...m, present: true }
  })
  return disks
}

/** 收集所有资源指标。 */
export function readResources() {
  const mem = memoryInfo()
  const cpu = cpuPercent()
  const load = loadavg()

  return {
    cpu: {
      percent: cpu, // null = 尚无基线（首次）
      cores: cpus().length,
      model: cpus()[0]?.model ?? null,
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
