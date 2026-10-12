/**
 * 工作区：列出 dsh 的工作区（标题/路径/会话数/时间），支持「打开文件夹」（调 fnOS
 * 文件管理器）、复制路径与只读浏览目录。对齐 Go 版 Workspace.vue。
 */

import { api, esc, toast, bytes, localTime, timeAgo, url } from '../dom.js'

/**
 * 官方 SDK 只加载一次；加载失败一律解析成 null，不让 import 错误冒泡成崩溃。
 *
 * vendor 的是 @trimjs/web-app@0.5.0 的 dist/index.js（未修改，来源与 sha256 见该
 * 文件头注释）。它导出 TrimApp 类 —— 不是全局对象。
 */
let trimAppPromise = null

function loadTrimApp() {
  if (!trimAppPromise) {
    trimAppPromise = import('../vendor/trim-web-app.js')
      .then((mod) => mod?.TrimApp ?? null)
      .catch(() => null)
  }
  return trimAppPromise
}

/** 给任意 Promise 套硬超时：宿主不回应时不让按钮一直转圈（SDK 自带 5s 握手超时）。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * 调 fnOS 文件管理器打开一个目录。官方途径只有一条：
 *
 *   const { TrimApp } = await import('../vendor/trim-web-app.js')
 *   await new TrimApp().openFileManager(path)
 *
 * **不要写成 window.trimSdk.openFileManager(path)。** 上一版就是这么写的，而
 * 这个名字在官方 SDK 产物里出现 0 次 —— 宿主从不注入任何全局 SDK，它只通过
 * postMessage 握手把方法表交给 new TrimApp() 的实例（SDK 内部的
 * getWebMethods() 拿不到方法表时抛 "Host bridge is not available outside
 * iframe or app runtime"）。于是真机上 window.trimSdk 恒为 undefined，
 * 按钮必然「点了没反应」。
 *
 * 必须 await：SDK 方法返回 Promise。旧代码调完立刻 return true，失败只变成
 * 控制台里一条 unhandled rejection，UI 却弹「已交给文件管理器打开」——
 * 提示成功、什么都没发生。
 *
 * 返回 { ok, reason }，reason 分层对应可执行的下一步：
 *   no-sdk            官方 SDK 没随包发布。
 *   not-embedded      页面不在 iframe 里（直连 :28001 或经外部域名反代）。
 *                     官方 SDK 在这种环境下主动跳过握手，调用不会有任何反应。
 *   host-unreachable  在 iframe 里但父窗口不是 fnOS 宿主，握手超时。
 *   host-rejected     宿主收到了但拒绝：路径不在文件管理器可见树内（套件私有
 *                     数据目录），或宿主版本不支持此方法。
 */
async function openFileManager(path) {
  const TrimApp = await loadTrimApp()
  if (!TrimApp) return { ok: false, reason: 'no-sdk' }

  let app
  try {
    app = new TrimApp({ debug: false })
  } catch (error) {
    return { ok: false, reason: `sdk-init: ${error?.message ?? error}` }
  }

  // 官方 SDK 自报是否独立页面（判据即 window.parent === window）。只在它明确
  // 为 true 时才判独立 —— 未初始化时该字段是 undefined，不能误杀 iframe 内场景。
  await withTimeout(app.initPromise, 6000, 'SDK 初始化').catch(() => {})
  if (app.isStandaloneWeb === true) return { ok: false, reason: 'not-embedded' }

  try {
    const result = await withTimeout(app.openFileManager(path), 8000, '文件管理器')
    // 宿主返回 { code, msg, data }：code !== 0 是被拒，不能当成成功。
    if (result && typeof result === 'object' && 'code' in result && Number(result.code) !== 0) {
      const detail = result.msg || result.error || `code ${result.code}`
      return { ok: false, reason: `host-rejected: ${detail}` }
    }
    return { ok: true, reason: '' }
  } catch (error) {
    const message = String(error?.message ?? error)
    // 没人回应握手 = 父窗口不是 fnOS 宿主；其余是宿主明确拒绝。
    if (/timeout|Host bridge/i.test(message)) return { ok: false, reason: 'host-unreachable' }
    return { ok: false, reason: `host-rejected: ${message}` }
  }
}

/** 打不开时告诉用户下一步该做什么。 */
function fileManagerHint(reason) {
  if (reason === 'no-sdk') return '官方 SDK 没随包发布，调不了 fnOS 文件管理器。'
  if (reason === 'not-embedded') return '当前页面不是从 fnOS 应用中心打开的（直连面板端口，或经外部域名反代），宿主文件管理器不存在。请从「应用中心 → DSH 管理器」进入后再点。'
  if (reason.startsWith('sdk-init')) return `文件管理器 SDK 初始化失败：${reason.slice('sdk-init: '.length)}。宿主版本可能过旧。`
  if (reason === 'host-unreachable') return '页面在 iframe 里，但父窗口不是 fnOS 宿主（握手超时）。请从「应用中心 → DSH 管理器」进入后再点。'
  if (reason.startsWith('host-rejected')) return `宿主拒绝了这个目录（${reason.slice('host-rejected: '.length)}）：工作区多半位于套件私有数据目录，不在文件管理器可见的目录树内。`
  return '当前环境拿不到 fnOS 文件管理器能力。'
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
          ${path ? `<button class="btn btn-primary" data-open="${esc(path)}" title="调 fnOS 文件管理器打开这个目录">打开文件夹</button>` : ''}
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
    button.addEventListener('click', async () => {
      const path = button.dataset.open
      // 握手最多 5 秒、调用上限 8 秒，期间必须给出「在做事」的状态，否则
      // 用户只会以为按钮没反应。
      const label = button.textContent
      button.disabled = true
      button.textContent = '调用中…'
      let result
      try {
        result = await openFileManager(path)
      } catch (error) {
        result = { ok: false, reason: `host-rejected: ${error?.message ?? error}` }
      } finally {
        button.disabled = false
        button.textContent = label
      }
      if (result.ok) {
        toast('已打开文件管理器', 'ok')
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
