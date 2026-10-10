/**
 * Overview: 单页概览 —— 状态核心卡（应用名 + 版本 + dsh 状态指示灯 + 5 列指标 +
 * 底部运行控制按钮栏）+ 面板信息卡（上移，与状态卡同屏显示全部信息）。
 *
 * 对齐 Go 版 Overview.vue，但按需求收敛：
 * - 「进入 Harness」大按钮 → dsh 状态颜色指示灯（.status-lamp，五色）。
 * - 运行控制 4 按钮 → 融入状态卡底部按钮栏（不再独立 action-grid）。
 * - 面板信息卡上移，一个主页显示所有信息。
 */

import { api, esc, bytes, localTime, toast, url } from '../dom.js'

// 五态 → 状态灯（颜色指示灯，替换原「进入 Harness」按钮）。
const PHASE_LAMP = {
  stopped: { label: '已停止', cls: 'lamp-stopped' },
  starting: { label: '启动中', cls: 'lamp-starting' },
  running: { label: '运行中', cls: 'lamp-running' },
  building: { label: '部署中', cls: 'lamp-building' },
  snapshotting: { label: '快照中', cls: 'lamp-snapshotting' },
}

export async function render(host, ctx) {
  let status
  try {
    status = await api('/api/status')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>状态</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  ctx.setPill(status)

  const running = status.running
  const healthy = status.healthy
  const mode = status.mode || 'auto'
  // Two DIFFERENT versions, and conflating them is what made this confusing:
  //   dshVersion    — the DeepSeek Harness build actually running (npm package)
  //   panelVersion — this fnOS suite (its own manifest), i.e. the manager
  // The header sits next to the app name, so it shows the MANAGER's version —
  // that is the thing the user installs and updates from 应用中心. The dsh build
  // belongs next to the service it belongs to, in the status card below.
  const panelVersion = status.panel?.version ?? '-'
  const dshVersion = status.version || status.installedVersion || '-'
  const phase = status.phase || status.state?.status || (running ? 'running' : 'stopped')

  // 状态指示灯（对齐五态状态机）。
  const lamp = PHASE_LAMP[phase] || (running
    ? (healthy ? PHASE_LAMP.running : PHASE_LAMP.starting)
    : PHASE_LAMP.stopped)

  // 状态徽章（指标网格里复用，保留 .badge 五态）。
  const PHASE_BADGE = {
    stopped: '<span class="badge badge-fail"><span class="dot dot-fail"></span>已停止</span>',
    starting: '<span class="badge badge-warn"><span class="dot dot-warn"></span>启动中</span>',
    running: '<span class="badge badge-ok"><span class="dot dot-ok"></span>运行中</span>',
    building: '<span class="badge badge-warn"><span class="dot dot-warn"></span>部署中</span>',
    snapshotting: '<span class="badge badge-warn"><span class="dot dot-warn"></span>快照中</span>',
  }
  const stateBadge = PHASE_BADGE[phase] || (running
    ? (healthy ? PHASE_BADGE.running : PHASE_BADGE.starting)
    : PHASE_BADGE.stopped)

  // dsh 进程树资源（CPU/内存）初始占位，由 renderDshUsage 填充。
  const cpuMetric = '<div class="metric-value" id="m-cpu">—</div>'
  const memMetric = '<div class="metric-value" id="m-mem">—</div>'

  // 运行时间
  const uptimeText = status.state?.startedAt
    ? fmtUptime(Date.now() - status.state.startedAt)
    : '—'

  // 底部状态通知（对齐 Go 版 last_message alert）
  const lastMessage = status.state?.lastMessage || ''
  const lastAlert = lastMessage
    ? `<div class="alert-box ${phase === 'running' ? 'alert-info' : 'alert-warn'}">${esc(lastMessage)}</div>`
    : ''

  const appName = 'DeepSeek Harness'

  host.innerHTML = `
    <!-- 状态核心卡：应用名 + 状态指示灯 + 5 列指标 + 底部运行控制按钮栏 -->
    <div class="card hero-card">
      <div class="hero-top">
        <div class="hero-title">
          <span class="app-name">${esc(appName)}</span>
          <span class="app-version">管理器 v${esc(panelVersion)}</span>
        </div>
        <div class="hero-action">
          <span class="status-lamp ${lamp.cls}" role="status" aria-label="dsh 状态: ${lamp.label}">
            <span class="lamp-dot"></span>${lamp.label}
          </span>
        </div>
      </div>

      <div class="hero-divider"></div>

      <!-- 5 列指标网格（运行状态/PID/CPU/内存/运行时间） -->
      <div class="metric-grid">
        <div class="metric">
          <span class="metric-label">运行状态</span>
          ${stateBadge}
        </div>
        <div class="metric">
          <span class="metric-label">运行时间</span>
          <div class="metric-value" id="m-uptime">${esc(uptimeText)}</div>
        </div>
        <div class="metric">
          <span class="metric-label">进程 PID</span>
          <div class="metric-value">${running && status.pid ? esc(status.pid) : '-'}</div>
        </div>
        <div class="metric">
          <span class="metric-label">CPU 占用</span>
          ${cpuMetric}
        </div>
        <div class="metric">
          <span class="metric-label">内存占用</span>
          ${memMetric}
        </div>
      </div>

      <!-- Which dsh build is running. The header shows the MANAGER's version,
           so the service's own version needs a home of its own here; otherwise
           upgrading dsh from the Versions tab looks like it changed nothing. -->
      <div class="hero-footnote">
        DeepSeek Harness <code>${esc(dshVersion)}</code>
        ${status.port ? ` · 端口 <code>${esc(status.port)}</code>` : ''}
      </div>

      <div class="hero-divider"></div>

      <!-- 运行控制按钮栏：融入状态卡底部（原独立 action-grid 收敛到此） -->
      <div class="action-bar">
        ${running
          ? `<button class="btn btn-danger" data-action="stop" type="button">⏹ 停止服务</button>`
          : `<button class="btn btn-primary" data-action="start" type="button" ${phase === 'starting' ? 'disabled' : ''}>▶ ${phase === 'starting' ? '服务启动中' : '启动服务'}</button>`}
        <button class="btn" data-action="restart" type="button">🔄 重启服务</button>
        <button class="btn" data-action="open" data-open="/p/" type="button">🔗 打开面板入口</button>
        <button class="btn" data-action="open" data-open="/api/versions" type="button">📦 版本管理</button>
      </div>
    </div>

    ${lastAlert}

    <!-- 面板信息卡：上移，与状态卡同屏显示全部信息 -->
    <h2 class="section-title">面板信息</h2>
    <div class="grid overview-grid">
      <div class="card">
        <div class="card-head"><h3><span class="card-icon">📦</span>安装</h3><span class="tag">${esc(mode)}</span></div>
        <div class="row"><span class="k">根目录</span><span class="v">${esc(status.dshRoot || '-')}</span></div>
        <div class="row"><span class="k">Home</span><span class="v">${esc(status.home || '-')}</span></div>
        <div class="row"><span class="k">托管目录</span><span class="v">${esc(status.managedAppDir || '-')}</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h3><span class="card-icon">🖥️</span>面板</h3><span class="badge badge-idle">v${esc(status.panel?.version ?? '-')}</span></div>
        <div class="row"><span class="k">端口</span><span class="v">${esc(status.port ?? '-')}</span></div>
        <div class="row"><span class="k">数据目录</span><span class="v">${esc(status.panel?.dataDir ?? '-')}</span></div>
        <div class="row"><span class="k">访问量</span><span class="v">${esc(status.access?.lines ?? 0)} 条 · ${bytes(status.access?.bytes ?? 0)}</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h3><span class="card-icon">👥</span>最近访问</h3></div>
        ${status.recentVisit ? `
          <div class="row"><span class="k">来源</span><span class="v"><code>${esc(status.recentVisit.ip || '-')}</code></span></div>
          <div class="row"><span class="k">路径</span><span class="v">${esc(status.recentVisit.path || '-')}</span></div>
          <div class="row"><span class="k">时间</span><span class="v">${localTime(status.recentVisit.ts)}</span></div>
        ` : '<p class="empty">暂无访问记录</p>'}
      </div>
    </div>
  `

  // 运行控制按钮
  for (const btn of host.querySelectorAll('.action-bar [data-action="stop"]')) {
    btn.addEventListener('click', () => service('stop', ctx))
  }
  for (const btn of host.querySelectorAll('.action-bar [data-action="start"]')) {
    btn.addEventListener('click', () => service('start', ctx))
  }
  for (const btn of host.querySelectorAll('.action-bar [data-action="restart"]')) {
    btn.addEventListener('click', () => service('restart', ctx))
  }
  // 「版本管理」按钮切到版本标签
  for (const btn of host.querySelectorAll('.action-bar [data-open="/api/versions"]')) {
    btn.addEventListener('click', () => { ctx.state.tab = 'versions'; ctx.refresh() })
  }
  // 「打开面板入口」按钮 → 新标签页打开 /p/（Harness 入口）
  for (const btn of host.querySelectorAll('.action-bar [data-open="/p/"]')) {
    btn.addEventListener('click', () => { window.open(url('/p/'), '_blank', 'noopener') })
  }

  // dsh 进程树资源：独立加载 + 定时刷新，注册到 ctx.onLeave 清理定时器。
  const cleanupUsage = renderDshUsage(host)
  ctx.onLeave(() => { cleanupUsage() })
}

// dsh 进程树 CPU/内存采样：写入 5 列指标网格的 #m-cpu / #m-mem。
async function renderDshUsage(host) {
  const draw = async () => {
    let usage
    try {
      usage = await api('/api/usage')
    } catch {
      usage = { cpu: '-', memory: '-' }
    }
    const cpuEl = host.querySelector('#m-cpu')
    const memEl = host.querySelector('#m-mem')
    if (cpuEl) cpuEl.textContent = usage.cpu ?? '-'
    if (memEl) memEl.textContent = usage.memory ?? '-'
  }
  await draw()
  const timer = setInterval(draw, 3000)
  return () => clearInterval(timer)
}

function fmtUptime(ms) {
  const s = Math.floor(Number(ms) / 1000) || 0
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时`
}

async function service(action, ctx) {
  try {
    await api(`/api/service/${action}`, { method: 'POST' })
    toast(`dsh 已请求${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`, 'ok')
    await ctx.refresh()
  } catch (error) {
    toast(error.message, 'error')
  }
}
