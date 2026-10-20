/**
 * 日志切片（rotation）。
 *
 * 为什么需要它：面板自己写的 `console.log` 里塞了 30 秒一次的 watchdog
 * 心跳，dsh 子进程的 stdout/stderr 又全部 tee 进 `dsh.log`。两个文件都只增
 * 不减，长跑几周就能滚到几十 MB —— 而日志页是「tail 最后 2MB + 按行截
 * 断」读的，文件越大，一次打开越慢，真正有用的那几行反而被淹没在心跳里。
 *
 * 这里统一按「单文件超过 LOG_ROTATE_MAX_BYTES 就切一片，最多留
 * LOG_ROTATE_KEEP 片」处理，超出的最旧一片直接删掉。
 *
 * 两种策略，不是偷懒写了两套，而是两个文件的写入方不一样，必须分开对待：
 *
 *  - `rename`：给**面板自己**写的日志用。面板每次 append 都重新 open 文件
 *    （见 `cmd/dashboard.js` 的 `log()`），不持有常驻 fd，所以 rename 是安全
 *    且原子的 —— 改名后下一次 append 自然在新文件上，中间不会丢行。
 *
 *  - `copytruncate`：给 **dsh 子进程正在写**的日志用。这个文件的 fd 是
 *    `startDsh` 里 `openSync(DSH_LOG,'a')` 拿到的，并且作为 stdio 直接塞给
 *    了子进程，**子进程攥的是那个 inode**。此时如果把 `dsh.log` rename 成
 *    `dsh.1.log`，子进程照样往 `dsh.1.log`（旧 inode）里写，新建的
 *    `dsh.log` 永远是空的 —— 日志页会变成一片空白，而且只有重启 dsh 才
 *    能恢复，这比日志太大还糟。所以只能「复制走再就地清空」：inode 不变，
 *    子进程的 fd 继续有效，无需重启。
 *
 *    （copytruncate 的固有代价是复制与清空之间极小的时间窗里新写入的字节
 *    可能跟切片重复或丢失。对 stdout/stderr 这种诊断流来说完全可接受，而
 *    rename 那种「日志直接空掉」的后果不可接受。）
 */

import { copyFileSync, existsSync, renameSync, statSync, truncateSync, unlinkSync } from 'node:fs'

/** 单文件上限：超过就切一片。 */
export const LOG_ROTATE_MAX_BYTES = 1024 * 1024

/** 保留的切片数量（不含当前文件）。 */
export const LOG_ROTATE_KEEP = 3

/** 切片序号放扩展名前面：`console.log` → `console.1.log`。 */
function slicePath(path, index) {
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return `${path}.${index}`
  return `${path.slice(0, dot)}.${index}${path.slice(dot)}`
}

/** 当前文件大小；文件不存在或不可读时返回 0（「不切」是最安全的默认）。 */
export function logSizeBytes(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 把已存在的切片整体后移一位（.1→.2，.2→.3），最旧的超出保留数就删掉，
 * 为「当前文件 → .1」腾出位置。
 *
 * 必须从最旧的往最新的方向挪，否则 .1 会先把 .2 覆盖掉，一串下去只剩一份。
 */
function shiftSlices(path, keep) {
  for (let index = keep; index >= 1; index -= 1) {
    const from = slicePath(path, index)
    if (!existsSync(from)) continue
    if (index >= keep) {
      try { unlinkSync(from) } catch { /* best effort */ }
      continue
    }
    const to = slicePath(path, index + 1)
    try { renameSync(from, to) } catch { /* best effort */ }
  }
}

/**
 * 需要就切一片。任何一步失败都吞掉 —— 轮转只是后勤，绝不能因为它把写日志
 * 的调用方（进而把面板主流程）拖垮。
 *
 * @param {string} path 日志文件绝对路径
 * @param {{ strategy?: 'rename' | 'copytruncate', maxBytes?: number, keep?: number }} [options]
 * @returns {{ rotated: boolean, reason?: string, slice?: string }}
 */
export function rotateLog(path, options = {}) {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_MAX_BYTES
  const keep = options.keep ?? LOG_ROTATE_KEEP
  const strategy = options.strategy ?? 'rename'

  if (logSizeBytes(path) < maxBytes) return { rotated: false, reason: 'under-limit' }

  const slice = slicePath(path, 1)
  try {
    if (strategy === 'copytruncate') {
      // 先腾位置，再复制，最后就地清空。顺序反了会先把数据冲掉。
      shiftSlices(path, keep)
      copyFileSync(path, slice)
      truncateSync(path, 0)
    } else {
      shiftSlices(path, keep)
      renameSync(path, slice)
    }
  } catch (error) {
    return { rotated: false, reason: `rotate-failed: ${error?.message ?? error}` }
  }
  return { rotated: true, slice }
}

/** 面板自己写的日志：每次 append 都重新 open，可以用 rename。 */
export function rotatePanelLog(path = '') {
  if (!path) return { rotated: false, reason: 'no-path' }
  return rotateLog(path, { strategy: 'rename' })
}

/** dsh 子进程持有的日志：inode 必须保持不变，只能 copytruncate。 */
export function rotateChildLog(path = '') {
  if (!path) return { rotated: false, reason: 'no-path' }
  return rotateLog(path, { strategy: 'copytruncate' })
}

/**
 * 带计数的子日志守卫。
 *
 * 为什么不每次都 `statSync`：stdout/stderr 是**逐 chunk** 写进日志的，一个
 * 繁忙的 dsh 每秒能吐出成百上千个 chunk，每个 chunk 都去 stat 一次是纯浪费。
 * 这里在内存里累加写入量，只有累计值越过上限才真正去 stat + 切片，平时只是
 * 一次整数加法。
 *
 * 切片后把计数重置成当前实际大小（而不是 0），这样即使有别的东西也在往这个
 * 文件里写，计数也不会跟真实大小越走越偏。
 *
 * @param {string} path
 * @param {{ maxBytes?: number, keep?: number }} [options]
 */
export function createChildLogGuard(path = '', options = {}) {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_MAX_BYTES
  let pending = logSizeBytes(path)
  return {
    /**
     * 记下刚写入的字节数，需要就切一片。
     * @param {number} bytes
     * @returns {boolean} 是否真的切了
     */
    note(bytes = 0) {
      pending += bytes
      if (!path || pending < maxBytes) return false
      const result = rotateChildLog(path)
      pending = logSizeBytes(path)
      return result.rotated
    },
    /** 丢弃累计值，下次重新从磁盘量起（比如子进程刚重启）。 */
    reset() {
      pending = logSizeBytes(path)
    },
  }
}
