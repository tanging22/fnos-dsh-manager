/**
 * 工作区：列出 dsh 的工作区（标题/路径/会话数/时间），支持「打开文件夹」（调 fnOS
 * 文件管理器 SDK）、复制路径与只读浏览目录。对齐 Go 版 Workspace.vue。
 *
 * 「打开文件夹」走 fnOS 网关注入的 `trimSdk.openFileManager(path)`（Go 版同款），
 * 非网关环境（如直连 :28001）或 SDK 缺失时回退到复制路径。
 */

import { api, esc, toast, bytes, localTime, timeAgo, url } from '../dom.js'

/**
 * 调 fnOS 文件管理器打开一个目录。返回 true 表示已交给 SDK，false 表示不可用。
 */
function openFileManager(path) {
  const sdk = window.trimSdk || window.parent?.trimSdk
  if (sdk && typeof sdk.openFileManager === 'function') {
    try {
      sdk.openFileManager(path)
      return true
    } catch {
      return false
    }
  }
  return false
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

  const copy = (text) => () => {
    navigator.clipboard?.writeText(text).then(
      () => toast('路径已复制', 'ok'),
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
      if (openFileManager(path)) {
        toast('已交给 fnOS 文件管理器打开', 'ok')
      } else {
        // SDK 不可用（非网关环境/直连端口），回退到复制路径。
        copy(path)()
      }
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
