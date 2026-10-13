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
import * as settings from './views/settings.js'
import * as workspace from './views/workspace.js'

const VIEWS = { overview, logs, versions, plugins, settings, workspace }

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
const siderScrim = document.getElementById('sider-scrim')

/* 窄屏（≤860px）侧栏是**常驻图标条**，不是滑出屏外的抽屉。
   桌面端的「折叠」与窄屏的「图标条」是同一套几何（46px），但语义不同：
   桌面折叠由用户在 localStorage 里存偏好，窄屏是强制的 —— 竖屏上
   184px 宽的侧栏会把内容挤成一列碎块，所以不读那个偏好。
   展开（drawer-open）只是把同一条侧栏拉宽露出文字，选完自动收回。 */
const narrowQuery = window.matchMedia('(max-width: 860px)')
const isNarrow = () => narrowQuery.matches

function applySiderCollapsed(collapsed) {
  if (sider) sider.classList.toggle('collapsed', collapsed)
  if (siderToggle) siderToggle.setAttribute('aria-expanded', String(!collapsed))
}

function setDrawerOpen(open) {
  if (!sider) return
  sider.classList.toggle('drawer-open', open)
  if (siderScrim) siderScrim.hidden = !open
  document.body.classList.toggle('drawer-active', open)
}

function closeDrawer() {
  if (isNarrow()) setDrawerOpen(false)
}

/* 按当前视口把侧栏摆到正确形态。窄屏：始终图标条。
   桌面：读 localStorage 的偏好。 */
function syncSiderMode() {
  if (isNarrow()) {
    applySiderCollapsed(true)
  } else {
    let saved = false
    try { saved = localStorage.getItem('dsh-sider-collapsed') === '1' } catch {}
    applySiderCollapsed(saved)
    setDrawerOpen(false)
  }
}

if (siderToggle) {
  siderToggle.addEventListener('click', () => {
    if (isNarrow()) {
      setDrawerOpen(!sider.classList.contains('drawer-open'))
      return
    }
    const collapsed = sider.classList.toggle('collapsed')
    applySiderCollapsed(collapsed)
    try { localStorage.setItem('dsh-sider-collapsed', collapsed ? '1' : '0') } catch {}
  })
  syncSiderMode()
}

// 点遮罩 / 按 Esc 关闭展开态
if (siderScrim) siderScrim.addEventListener('click', closeDrawer)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer()
})

// 视口跨越 860px 时重新摆形态：窄->宽要收回图标条并恢复桌面偏好，
// 宽->窄要强制图标条（否则侧栏会以桌面宽度占住竖屏）。
narrowQuery.addEventListener('change', () => {
  syncSiderMode()
  if (!isNarrow()) {
    document.body.classList.remove('drawer-active')
    if (siderScrim) siderScrim.hidden = true
  }
})

// 窄屏选中菜单后自动收回图标条，否则展开态会一直盖着内容
sider?.addEventListener('click', (event) => {
  if (event.target.closest('.menu-item')) closeDrawer()
})

const state = { tab: 'overview', logFile: null }
const leavers = []

const TAB_TITLES = {
  overview: '概览',
  versions: '版本',
  plugins: '插件管理',
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
  /** 推送通道当前是否在线。视图用它决定要不要降级轮询。 */
  pushLive() {
    return pushLive
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

// A push event (WS status/usage/visit) can re-enter renderTab() while an
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
  // 工作区页需要块级间距规则（见 app.css 的 .view.workspace-view）
  view.classList.toggle('workspace-view', state.tab === 'workspace')
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

// Real-time push channel: replaces the 15s poll with server-driven updates.
// Status/usage/visit events re-render the active view; a status event also
// refreshes the header pill. `pushLive` tracks whether the channel is actually
// up — the 15s safety net below only runs while it is down, because with the
// push channel up every field it would refresh is already being pushed.
//
// visit 是高频事件（一次代理请求就推一条）。它只影响「最近访问」那一个字段，
// 所以只改那一行文本,不再整页重渲 —— 整页重渲会重建概览页的 3s 轮询定时器,
// 实测把 /api/usage 从每 3s 一次抬到每秒多次。
let pushLive = false

setInterval(() => {
  if (pushLive) return
  if (state.tab === 'overview' && isPanelVisible()) renderTab()
}, 15000)

/**
 * 刷新「最近访问」卡的四行（时间/地址/IP/客户端），不重渲整页。
 *
 * 整页重渲会把概览页的定时器重建一遍，实测把 /api/usage 请求量抬到每秒多次。
 * 这里逐个改文本节点；卡片永远渲染这四行（无数据时为 `-`），所以每条 visit
 * 推送都有元素可写。`title` 一并更新，否则省略号截断后看不到全文。
 */
function applyVisit(event) {
  if (state.tab !== 'overview') return
  const write = (selector, value) => {
    const cell = document.querySelector(selector)
    if (!cell) return
    cell.textContent = value || '-'
    // 值在 <code> 里时，title 挂在外层 .v 上。
    const holder = cell.closest('.v') || cell
    holder.title = value || '-'
  }
  write('[data-visit-ts]', overview.visitTimeText(event?.ts))
  write('[data-visit-path]', event?.path)
  write('[data-visit-ip]', event?.ip)
  write('[data-visit-agent]', event?.agent)
}

const closeWs = ws((event) => {
  if (!isPanelVisible()) return
  if (event.type === 'status') {
    applyPill(event)
    if (state.tab === 'overview') renderTab()
  } else if (event.type === 'usage') {
    // dsh 进程树资源推送：直接写 5 列指标网格的 #m-cpu / #m-mem，与轮询渲染一致。
    if (state.tab === 'overview') {
      const cpuEl = document.getElementById('m-cpu')
      const memEl = document.getElementById('m-mem')
      if (cpuEl) cpuEl.textContent = event.cpu ?? '-'
      if (memEl) memEl.textContent = event.memory ?? '-'
    }
  } else if (event.type === 'visit') {
    applyVisit(event)
  }
}, (connected) => {
  const was = pushLive
  pushLive = connected
  // 通道刚恢复时补一次全量：断线期间的状态变化只有 HTTP 能拿到。
  if (connected && !was && isPanelVisible()) renderTab()
})
window.addEventListener('beforeunload', closeWs)

boot()
