/**
 * 工作区文件管理：列出 dsh 的 workspace.json 里的工作区，并提供只读目录浏览。
 *
 * 与 techysy/deepseek-harness-fnos 的 workspace.go 对齐：dsh 把工作区持久化在
 * `${DSH_HOME}/storages/workspace.json`，格式是 `unit.version=2` 的 domain 存储：
 *   unit.name = "workspace"、global.workspaceIds 有序列表、tables.workspaces 是
 *   id -> {path,title,sessionIds,createdAt,updatedAt} 的映射。
 *
 * 本模块职责：
 *   1. 解析 workspace.json，返回工作区列表（标题/路径/会话数/时间）；
 *   2. 按路径做只读目录浏览（列出子项 + 大小 + 类型），供前端「打开目录」用。
 *
 * 只读、无副作用：面板不写 dsh 的私有数据区，也不越界读取工作区声明的 path 之外
 * 的任意路径 —— 目录浏览严格限制在「workspace.json 里声明过的 path」范围内。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { activeDshHome } from './dashboard-utils.js'

/** workspace.json 的存储路径（与 Go 版 fetchWorkspaces 一致）。 */
export function workspaceFile() {
  return join(activeDshHome(), 'storages', 'workspace.json')
}

/**
 * 解析 workspace.json。返回 { items, archivedSessionIds }；文件不存在或解析失败
 * 时返回空列表（前端展示「暂无工作区」），绝不抛出让整个请求 500。
 */
export function workspaceState() {
  const file = workspaceFile()
  const empty = { items: [], archivedSessionIds: [], home: activeDshHome(), file }
  if (!existsSync(file)) return empty

  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...empty, error: 'workspace.json 解析失败' }
  }

  const unit = data?.unit ?? {}
  if (unit.name !== 'workspace') {
    return { ...empty, error: `不支持的存储单元: ${unit.name ?? 'unknown'}` }
  }
  // 版本兜底：当前只解析 v2；未来格式变更时在此兼容（与 Go 版一致）。
  if ((unit.version ?? 0) > 2) {
    return { ...empty, error: `workspace.json 版本 ${unit.version} 暂不支持` }
  }

  const global = data?.global ?? {}
  const tables = data?.tables?.workspaces ?? {}
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : []

  const seen = new Set()
  const items = []
  for (const id of order) {
    const rec = tables[id]
    if (!rec) continue
    seen.add(id)
    items.push(itemFromRecord(id, rec))
  }

  // 兜底：registry 未列出的记录（异常状态）按更新时间倒序追加。
  const leftover = Object.keys(tables)
    .filter((id) => !seen.has(id))
    .map((id) => ({ id, rec: tables[id] }))
    .sort((a, b) => String(b.rec?.updatedAt ?? '') < String(a.rec?.updatedAt ?? '') ? -1 : 1)
  for (const { id, rec } of leftover) {
    items.push(itemFromRecord(id, rec))
  }

  const archivedSessionIds = Array.isArray(global.archivedSessionIds)
    ? global.archivedSessionIds
    : []

  return { items, archivedSessionIds, home: activeDshHome(), file }
}

function itemFromRecord(id, rec) {
  return {
    workspaceId: id,
    path: rec?.path ?? null,
    title: rec?.title ?? '',
    sessionIds: Array.isArray(rec?.sessionIds) ? rec.sessionIds : [],
    createdAt: rec?.createdAt ?? null,
    updatedAt: rec?.updatedAt ?? null,
  }
}

/**
 * 只读浏览一个目录。`path` 必须是 workspace.json 里声明过的某个工作区 path
 * （或其子目录），否则拒绝 —— 面板没有义务、也不该浏览工作区声明之外的任意路径。
 */
export function listDirectory(requested) {
  if (!requested) return { ok: false, error: 'missing-path', status: 400 }

  const { items } = workspaceState()
  const declared = items.map((it) => it.path).filter(Boolean)

  // 规范化目标路径，并确认它落在某个声明的工作区 path 之内。
  let target = null
  try {
    target = resolve(requested)
  } catch {
    return { ok: false, error: 'bad-path', status: 400 }
  }
  const allowed = declared.find((p) => {
    try {
      const base = resolve(p)
      return target === base || target.startsWith(base + sep)
    } catch {
      return false
    }
  })
  if (!allowed) {
    return { ok: false, error: 'path-not-declared', status: 403 }
  }

  // 符号链接逃逸修复：上面的边界检查是词法比较（resolve 不解析符号链接），
  // 而 statSync/readdirSync 会跟随软链。工作区内一个指向 / 或任意目录的
  // symlink 会被 stat 成 directory，前端再下钻时词法仍在 base 内、实际 readdir
  // 的是链接目标，绕过「严格限制在声明 path 之内」的边界。用 realpath 校验
  // 真实路径仍以某个声明 path 的 realpath 为前缀。
  let realTarget
  try {
    realTarget = realpathSync(target)
  } catch {
    return { ok: false, error: 'not-found', status: 404 }
  }
  const realAllowed = declared.some((p) => {
    try {
      const base = realpathSync(resolve(p))
      return realTarget === base || realTarget.startsWith(base + sep)
    } catch {
      return false
    }
  })
  if (!realAllowed) {
    return { ok: false, error: 'path-not-declared', status: 403 }
  }

  let st
  try {
    st = statSync(target)
  } catch {
    return { ok: false, error: 'not-found', status: 404 }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'not-a-directory', status: 400 }
  }

  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    return { ok: false, error: `unreadable: ${error.message}`, status: 403 }
  }

  const children = entries.map((dirent) => {
    const full = join(target, dirent.name)
    let isDir = dirent.isDirectory()
    let size = null
    let mtime = null
    try {
      const s = statSync(full)
      isDir = s.isDirectory()
      size = s.isDirectory() ? null : s.size
      mtime = s.mtimeMs
    } catch {}
    return {
      name: dirent.name,
      path: full,
      directory: isDir,
      size,
      mtime: mtime ? new Date(mtime).toISOString() : null,
    }
  })
  // 目录在前、文件在后，各自按名字排序。
  children.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return {
    ok: true,
    path: target,
    // `allowed` 是 workspace.json 里的原始字符串，`target` 是 resolve() 后的绝对
    // 路径 —— 两者几乎不可能严格相等，于是在根工作区时 parent 仍指向 `..`，
    // 前端「上级」按钮会跳到一个必然被 403 拒绝的路径。两边都规范化后再比。
    parent: resolve(allowed) === target ? null : resolve(target, '..'),
    children,
  }
}
