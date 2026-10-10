/**
 * Console shell: tab routing and the status pill.
 *
 * Authentication was removed by design — fnOS's unified gateway already
 * authenticated the caller before the request reaches this panel, so there is
 * no login gate here. See cmd/dashboard-server.js for the same note.
 */

import { esc, toast, ws } from './dom.js'
import * as overview from './views/overview.js'
import * as logs from './views/logs.js'
import * as versions from './views/versions.js'
import * as plugins from './views/plugins.js'
import * as patches from './views/patches.js'
import * as access from './views/access.js'
import * as shortcuts from './views/shortcuts.js'
import * as settings from './views/settings.js'
import * as workspace from './views/workspace.js'

const VIEWS = { overview, logs, versions, plugins, patches, access, shortcuts, settings, workspace }

const app = document.getElementById('app')
const view = document.getElementById('view')
const pill = document.getElementById('status-pill')
const tabs = Array.from(document.querySelectorAll('.menu-item'))
const pageTitle = document.getElementById('page-title')

/**
 * Should live updates repaint right now?
 *
 * The only case that must suppress work is the panel sitting in a background
 * tab: painting then is wasted work nobody sees. Deliberately NOT keyed on the
 * `hidden` HTML attribute — the shell carries none, and when it did, every
 * update path in this file silently no-opped because nothing ever removed it.
 * `document.visibilityState` is the real signal and cannot be left stale by a
 * forgotten attribute.
 */
function isPanelVisible() {
  if (typeof document !== 'undefined' && document.visibilityState) {
    return document.visibilityState === 'visible'
  }
  return true
}

// 侧栏折叠：点击靠边（收起）→ 再点展开。持久化到 localStorage。
const sider = document.getElementById('sider')
const siderToggle = document.getElementById('sider-toggle')
function applySiderCollapsed(collapsed) {
  if (sider) sider.classList.toggle('collapsed', collapsed)
  if (siderToggle) siderToggle.setAttribute('aria-expanded', String(!collapsed))
}
if (siderToggle) {
  siderToggle.addEventListener('click', () => {
    const collapsed = sider.classList.toggle('collapsed')
    applySiderCollapsed(collapsed)
    try { localStorage.setItem('dsh-sider-collapsed', collapsed ? '1' : '0') } catch {}
  })
  // 恢复上次折叠状态
  let saved = false
  try { saved = localStorage.getItem('dsh-sider-collapsed') === '1' } catch {}
  applySiderCollapsed(saved)
}

const state = { tab: 'overview', logFile: null }
const leavers = []

const TAB_TITLES = {
  overview: '概览',
  versions: '版本',
  plugins: '插件管理',
  patches: '补丁',
  access: '访问记录',
  shortcuts: '快捷入口',
  workspace: '工作区',
  settings: '应用设置',
  logs: '运行日志',
}

const ctx = {
  state,
  async render() {
    await renderTab()
  },
  async refresh() {
    await renderTab()
  },
  setPill(status) {
    applyPill(status)
  },
  onLeave(fn) {
    leavers.push(fn)
  },
}

function applyPill(status) {
  const running = status?.running
  const healthy = status?.healthy
  const phase = status?.phase ?? status?.state?.status
  // 五态相位优先；fallback 到 running/healthy 二值。
  if (phase === 'building') {
    pill.className = 'pill pill-warn'
    pill.textContent = '部署中'
  } else if (phase === 'snapshotting') {
    pill.className = 'pill pill-warn'
    pill.textContent = '快照中'
  } else if (phase === 'starting' || (running && !healthy)) {
    pill.className = 'pill pill-warn'
    pill.textContent = '启动中'
  } else if (phase === 'running' || running) {
    pill.className = healthy === false ? 'pill pill-warn' : 'pill pill-ok'
    pill.textContent = healthy === false ? '启动中' : '运行中'
  } else {
    pill.className = 'pill pill-fail'
    pill.textContent = '已停止'
  }
}

// A push event (WS status/visit/access) can re-enter renderTab() while an
// earlier call is still awaiting its view. Serialising the whole body keeps a
// slow render from being torn down by the next one, so each view registers
// exactly one cleanup — otherwise its pollers accumulate without bound (see
// the usage timer in overview.js, which used to leak one 3s /api/usage poll per
// missed cleanup: measured at 20-29 requests/second against a designed 1/3s).
let renderQueue = Promise.resolve()
function renderTab() {
  const next = renderQueue.then(runRenderTab, runRenderTab)
  renderQueue = next.catch(() => {})
  return next
}
async function runRenderTab() {
  for (const fn of leavers.splice(0, leavers.length)) {
    try { fn() } catch { /* a failed cleanup must not block the next tab */ }
  }
  const module = VIEWS[state.tab] ?? overview
  // 概览页用自适应无滚动条布局，其余页保留滚动。
  view.classList.toggle('overview-view', state.tab === 'overview')
  view.innerHTML = '<div class="empty"><span class="spin">◌</span> 加载中…</div>'
  try {
    await module.render(view, ctx)
  } catch (error) {
    view.innerHTML = `<div class="card"><p class="empty">${esc(error.message)}</p></div>`
  }
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab))
  }
  if (pageTitle) pageTitle.textContent = TAB_TITLES[state.tab] ?? '概览'
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab
    renderTab()
  })
}

/**
 * Paint the shell and start the live-update machinery.
 *
 * `boot()` is fire-and-forget, so an unhandled rejection here would leave the
 * page blank with only a console message — which is what "白屏无内容" looks like
 * from the user's side. Catch it, and put the reason on screen where it can be
 * acted on. A failure inside `renderTab` is already handled per-tab; this is the
 * net for anything that escapes that (a missing #view, a broken module import).
 */
async function boot() {
  try {
    await renderTab()
  } catch (error) {
    const message = error?.message ?? String(error)
    if (view) {
      view.innerHTML = `<div class="card"><h3>控制台加载失败</h3>
        <p class="empty">${esc(message)}</p>
        <p class="muted">面板接口若不可用，请确认服务已启动；也可以尝试手动刷新。</p></div>`
    }
    console.error('[fnos-dsh-manager] boot failed:', error)
  }
}

document.getElementById('refresh')?.addEventListener('click', () => {
  renderTab()
  toast('已刷新')
})

setInterval(() => {
  if (state.tab === 'overview' && isPanelVisible()) renderTab()
}, 15000)

// Real-time push channel: replaces the 15s poll with server-driven updates.
// Status/access/visit events re-render the active view; a status event also
// refreshes the header pill. The interval above stays as a safety net for when
// the gateway strips WS upgrades (then push silently no-ops and poll carries).
const closeWs = ws((event) => {
  if (!isPanelVisible()) return
  if (event.type === 'status') {
    applyPill(event)
    if (state.tab === 'overview') renderTab()
  } else if (event.type === 'usage') {
    // dsh 进程树资源推送：直接写 5 列指标网格的 #m-cpu / #m-mem，与 3s 轮询渲染一致。
    if (state.tab === 'overview') {
      const cpuEl = document.getElementById('m-cpu')
      const memEl = document.getElementById('m-mem')
      if (cpuEl) cpuEl.textContent = event.cpu ?? '-'
      if (memEl) memEl.textContent = event.memory ?? '-'
    }
  } else if (event.type === 'visit' || event.type === 'access') {
    if (state.tab === 'overview' || state.tab === 'access') renderTab()
  }
})
window.addEventListener('beforeunload', closeWs)

boot()
