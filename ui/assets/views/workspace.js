/**
 * 工作区：列出 dsh 的工作区（标题/路径/会话数/时间），支持「打开文件夹」（调 fnOS
 * 文件管理器 SDK）、复制路径与只读浏览目录。对齐 Go 版 Workspace.vue。
 *
 * 「打开文件夹」走 fnOS 网关注入的 `trimSdk.openFileManager(path)`（Go 版同款），
 * 非网关环境（如直连 :28001）或 SDK 缺失时回退到复制路径。
 */

import { api, esc, toast, bytes, localTime, timeAgo, url } from '../dom.js'

/**
 * 调 fnOS 文件管理器打开一个目录。SDK 只能从网关 iframe 的父窗口拿，所以沿
 * parent 链往上找 —— fnOS 在不同版本/不同嵌套深度下注入 `window.trimSdk` 的
 * 位置并不一致，只查 `window.trimSdk || window.parent.trimSdk` 在多一层 iframe
 * 时就找不到。
 *
 * 返回 `{ ok, reason }`。旧签名只回 true/false，"打不开"和"为什么打不开"混成
 * 一个结果，用户只能看到一句笼统的"不可用"。区分出原因才有可操作的建议：
 *
 *   not-embedded  面板不是嵌在 fnOS 里打开的（直连 :28001/:28000 端口）。
 *                 网关没参与，自然没人注入 trimSdk —— 这是最常见的情形。
 *   cross-origin  嵌在 iframe 里，但父窗口跨域，读 `parent.trimSdk` 直接抛
 *                 SecurityError（浏览器不允许跨源读属性）。面板与网关不同端口
 *                 时必踩，且旧实现把异常吞掉后继续上溯，看起来像"没找到 SDK"。
 *   sdk-missing   能访问父窗口，但整条链上都没有 trimSdk（该版本 fnOS 未注入，
 *                 或页面是独立标签页打开的）。
 *   sdk-threw     SDK 在、调用却抛错（典型是路径不在文件管理器可见的目录树里，
 *                 例如套件私有数据目录下的工作区）。
 */
function openFileManager(path) {
  let scope = window
  let embedded = false
  let sawCrossOrigin = false
  let lastError = ''
  for (let depth = 0; scope && depth < 6; depth += 1) {
    let sdk = null
    try {
      sdk = scope.trimSdk
      if (window.top !== window.self) embedded = true
    } catch {
      // 跨域父窗口：读属性即 SecurityError，连 `sdk` 都拿不到。
      sawCrossOrigin = true
      embedded = true
    }
    if (sdk && typeof sdk.openFileManager === 'function') {
      try {
        sdk.openFileManager(path)
        return { ok: true, reason: '' }
      } catch (error) {
        lastError = error?.message ?? String(error)
      }
    }
    if (scope.parent === scope) break
    scope = scope.parent
  }
  if (lastError) return { ok: false, reason: `sdk-threw: ${lastError}` }
  if (!embedded) return { ok: false, reason: 'not-embedded' }
  if (sawCrossOrigin) return { ok: false, reason: 'cross-origin' }
  return { ok: false, reason: 'sdk-missing' }
}

/** 把打不开的原因翻成人能执行的下一步。 */
function fileManagerHint(reason) {
  if (reason === 'not-embedded') {
    return '当前不是从 fnOS 应用中心里打开的面板（直连面板端口），网关不会注入文件管理器 SDK。请从 fnOS 应用中心进入本套件再点。'
  }
  if (reason === 'cross-origin') {
    return '面板与网关不同源，浏览器禁止跨 iframe 调用文件管理器。请从 fnOS 应用中心进入本套件再点。'
  }
  if (reason.startsWith('sdk-threw')) {
    return '文件管理器拒绝了这个路径：多半是工作区在套件私有数据目录里，不在文件管理器可见的共享目录树内。'
  }
  return '当前环境没有 fnOS 文件管理器 SDK 可用。请从 fnOS 应用中心进入本套件再点。'
}

export async function render(host, ctx) {
  let data
  try {
    data = await api('/api/workspace')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3><span class="card-icon">📁</span>工作区</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const items = data.items ?? []
  const home = data.home ?? ''

  /** 复制路径并给出提示。`quiet` 用于"打开文件夹"的兜底分支：
 *  那里已经明确告诉用户文件管理器没打开，再弹一句"路径已复制"只会让人
 *  以为两步都成功了。 */
  const copy = (text, quiet = false) => () => {
    navigator.clipboard?.writeText(text).then(
      () => { if (!quiet) toast('路径已复制', 'ok') },
      () => toast('复制失败，请手动选中', 'error'),
    )
  }

  const cards = items.map((item) => {
    const title = item.title || item.workspaceId || '未命名'
    const sessions = (item.sessionIds ?? []).length
    const path = item.path
    return `
      <div class="card ws-card">
        <div class="card-head">
          <h3>${esc(title)}</h3>
          <span class="tag">${sessions} 会话</span>
        </div>
        <div class="row"><span class="k">路径</span><span class="v"><code>${esc(path || '—')}</code></span></div>
        <div class="row"><span class="k">工作区 ID</span><span class="v muted">${esc(item.workspaceId || '—')}</span></div>
        <div class="row"><span class="k">更新</span><span class="v">${item.updatedAt ? timeAgo(item.updatedAt) : '—'}</span></div>
        <div class="row"><span class="k">创建</span><span class="v">${item.createdAt ? localTime(item.createdAt) : '—'}</span></div>
        <div class="btn-row">
          ${path ? `<button class="btn btn-primary" data-open="${esc(path)}">打开文件夹</button>` : ''}
          ${path ? `<button class="btn" data-browse="${esc(path)}">浏览目录</button>` : ''}
          ${path ? `<button class="btn btn-ghost" data-copy="${esc(path)}">复制路径</button>` : ''}
        </div>
      </div>
    `
  }).join('')

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3><span class="card-icon">📁</span>工作区</h3>
        ${items.length ? `<span class="badge badge-idle">共 ${items.length} 个</span>` : ''}
      </div>
      <p class="muted">dsh 的会话与工作文件目录。下面列出 workspace.json 里登记的工作区。</p>
      ${home ? `<p class="muted">存储：<code>${esc(home)}/storages/workspace.json</code></p>` : ''}
    </div>

    ${items.length
      ? `<div class="grid ws-grid">${cards}</div>`
      : '<div class="card"><p class="empty">暂无工作区数据。请先运行 DeepSeek Harness 并在客户端创建工作区。</p></div>'
    }
  `

  host.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', copy(button.dataset.copy))
  })

  host.querySelectorAll('[data-browse]').forEach((button) => {
    button.addEventListener('click', () => browse(button.dataset.browse, host))
  })

  host.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const path = button.dataset.open
      const result = openFileManager(path)
      if (result.ok) {
        toast('已交给 fnOS 文件管理器打开', 'ok')
        return
      }
      // 打不开就说清楚是哪一种打不开，否则只剩一句"不可用"，无法判断该做什么。
      // 路径仍然复制好（quiet，不再重复提示），用户可以直接粘到文件管理器地址栏。
      copy(path, true)()
      toast(fileManagerHint(result.reason), 'error')
    })
  })
}

/** 只读浏览一个目录，在下方追加一个列表卡片。 */
async function browse(path, host) {
  let box = host.querySelector('.browse-box')
  if (!box) {
    box = document.createElement('div')
    box.className = 'browse-box'
    host.appendChild(box)
  }
  await renderBrowse(box, path)
}

async function renderBrowse(box, path) {
  box.innerHTML = '<div class="card"><p class="empty"><span class="spin">◌</span> 加载中…</p></div>'
  let data
  try {
    data = await api(`/api/workspace/browse?path=${encodeURIComponent(path)}`)
  } catch (error) {
    box.innerHTML = `<div class="card"><p class="empty">${esc(error.message)}</p></div>`
    return
  }
  if (!data.ok) {
    box.innerHTML = `<div class="card"><p class="empty">${esc(data.error || '无法读取目录')}</p></div>`
    return
  }

  const rows = (data.children ?? []).map((c) => `
    <tr>
      <td>${c.directory ? '📁' : '📄'}</td>
      <td>${c.directory
        ? `<a class="browse-link" data-path="${esc(c.path)}">${esc(c.name)}/</a>`
        : `<code>${esc(c.name)}</code>`}</td>
      <td class="num">${c.directory ? '—' : (c.size != null ? bytes(c.size) : '—')}</td>
      <td class="muted">${c.mtime ? localTime(c.mtime) : '—'}</td>
    </tr>
  `).join('')

  box.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3><span class="card-icon">🗂️</span>浏览目录</h3>
        ${data.parent ? `<button class="btn btn-ghost" data-parent="${esc(data.parent)}">↑ 上级</button>` : ''}
      </div>
      <p class="muted"><code>${esc(data.path)}</code></p>
      <div class="scroll"><table class="data">
        <thead><tr><th></th><th>名称</th><th class="num">大小</th><th>修改时间</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="empty">空目录</td></tr>'}</tbody>
      </table></div>
    </div>
  `

  const up = box.querySelector('[data-parent]')
  if (up) up.addEventListener('click', () => renderBrowse(box, up.dataset.parent))
  box.querySelectorAll('.browse-link').forEach((a) => {
    a.addEventListener('click', () => renderBrowse(box, a.dataset.path))
  })
}
