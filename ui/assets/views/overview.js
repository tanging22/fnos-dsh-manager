/**
 * Overview: 单页概览 —— 状态核心卡（应用名 + 版本 + dsh 状态指示灯 + 5 列指标 +
 * 底部运行控制按钮栏）+ 面板信息卡（上移，与状态卡同屏显示全部信息）。
 *
 * 对齐 Go 版 Overview.vue，但按需求收敛：
 * - 「进入 Harness」大按钮 → dsh 状态颜色指示灯（.status-lamp，五色）。
 * - 运行控制 4 按钮 → 融入状态卡底部按钮栏（不再独立 action-grid）。
 * - 面板信息卡上移，一个主页显示所有信息。
 */

import { api, esc, toast, url } from '../dom.js'

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

  // 会话代持：面板必须持有 dsh 的登录凭据才能反代。缺失时（典型是 fnOS 升级
  // 重启面板、dsh 却还活着）接口会 401、前端 WS 60 秒超时——这里直接告警。
  const sessionOk = Boolean(status.session?.cookie || status.session?.token)

  // dsh 最近一次启动打印的地址（`http://127.0.0.1:<port>/?token=…`）。
  //
  // 这条地址里主机是 dsh 自己的回环，照着点只会连到浏览器所在的那台机器，
  // 所以它只用来「看 + 复制」；真正能点的是 `session.entry` —— 同一个地址
  // 剥掉回环主机、换上面板代理前缀后的路径，在当前面板域名下打开即可凭
  // token 换到自己的 30 天 Cookie。
  const launchUrl = status.session?.url || ''
  const launchEntry = status.session?.entry || ''

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
        <button class="btn" data-action="launch" type="button">🔑 启动地址</button>
      </div>

      <!-- dsh 启动时打印的带 token 地址。整块带 data-copy，供下面的复制按钮取用。 -->
      <div class="launch-url-row" data-copy="${esc(launchUrl)}">
        <span class="launch-url-label">启动地址</span>
        ${launchUrl
          ? `<code class="launch-url">${esc(launchUrl)}</code>
             <button class="btn btn-ghost" data-action="copy-launch" type="button">复制</button>
             ${launchEntry ? '<span class="muted">按钮会用面板域名打开同一地址</span>' : ''}`
          : '<span class="muted">尚未捕获——dsh 每次启动会打印一次，重启服务后这里就有</span>'}
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
      </div>
      <div class="card">
        <div class="card-head"><h3><span class="card-icon">👥</span>最近访问</h3></div>
        ${status.recentVisit ? `
          <div class="row"><span class="k">来源 IP</span><span class="v"><code>${esc(status.recentVisit.ip || '-')}</code></span></div>
        ` : '<p class="empty">暂无访问记录</p>'}
      </div>
      <div class="card">
        <div class="card-head"><h3><span class="card-icon">🔑</span>会话代持</h3>
          <span class="badge ${sessionOk ? 'badge-ok' : 'badge-warn'}">${sessionOk ? '已就绪' : '缺凭据'}</span></div>
        <div class="row"><span class="k">Launch Token</span><span class="v">${status.session?.token ? '已捕获' : '未捕获'}</span></div>
        <div class="row"><span class="k">dsh-auth Cookie</span><span class="v">${status.session?.cookie ? '已持有' : '缺失'}</span></div>
        ${sessionOk ? '' : '<p class="empty">面板手里没有 dsh 登录凭据，反代会 401、前端 WebSocket 将在 60 秒后超时。请重启 dsh 重新捕获（重启后新进程会重新打印 Launch Token）。</p>'}
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
  // 「启动地址」→ 复制 dsh 自己打印的那条，并用面板域名打开同一地址。
  for (const btn of host.querySelectorAll('.action-bar [data-action="launch"]')) {
    btn.addEventListener('click', () => {
      if (!launchEntry) {
        toast('还没有捕获到启动地址：dsh 每次启动才打印一次，请重启一次服务', 'error')
        return
      }
      if (launchUrl) copyText(launchUrl)
      window.open(url(launchEntry), '_blank', 'noopener')
    })
  }
  for (const btn of host.querySelectorAll('[data-action="copy-launch"]')) {
    btn.addEventListener('click', () => {
      const text = btn.closest('[data-copy]')?.dataset.copy || launchUrl
      if (text) copyText(text)
    })
  }

  // dsh 进程树资源：定时刷新。
  //
  // 清理函数必须在任何 await 之前注册。renderTab() 的流程是
  // 「先 leavers.splice() 回收上一轮的清理函数，再 await module.render()」，
  // 而 WS 推送（app.js 的 status/visit/access 事件）随时可能在这个 await
  // 期间再次调用 renderTab()。若等 await 结束才注册，那一次并发渲染会把
  // 尚未入列的清理函数漏掉，于是每漏一个就永久多留一个 3s 定时器，
  // /api/usage 的请求量呈指数增长（实测每秒 20~29 次，正常应为每 3s 一次）。
  const cleanupUsage = startUsageTimer(host)
  ctx.onLeave(() => { cleanupUsage() })
}

// dsh 进程树 CPU/内存采样：写入 5 列指标网格的 #m-cpu / #m-mem。
// 同步返回清理函数，不再 await 首次采样——首次采样在后台触发即可。
function startUsageTimer(host) {
  let stopped = false
  const draw = async () => {
    let usage
    try {
      usage = await api('/api/usage')
    } catch {
      usage = { cpu: '-', memory: '-' }
    }
    // 请求期间可能已被切走：此时 DOM 里已没有 #m-cpu/#m-mem，querySelector
    // 自然返回 null，无需再判断，也不写任何已卸载节点。
    if (stopped) return
    const cpuEl = host.querySelector('#m-cpu')
    const memEl = host.querySelector('#m-mem')
    if (cpuEl) cpuEl.textContent = usage.cpu ?? '-'
    if (memEl) memEl.textContent = usage.memory ?? '-'
  }
  draw()
  const timer = setInterval(draw, 3000)
  return () => { stopped = true; clearInterval(timer) }
}

/**
 * 复制文本。
 *
 * 直连面板端口（http://<NAS-IP>:28001）是非安全上下文，`navigator.clipboard`
 * 根本不存在 —— 只写 `navigator.clipboard.writeText(...)` 会抛 TypeError，
 * 按钮表现成"点了没反应"。这里回退到临时 textarea + execCommand。
 */
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('已复制', 'ok'),
      () => toast('复制失败，请手动选中', 'error'),
    )
    return
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'error')
  } catch {
    toast('复制失败，请手动选中', 'error')
  }
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
