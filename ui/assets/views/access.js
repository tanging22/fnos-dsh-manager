/** Access: who reached the instance through the panel proxy, newest first. */

import { api, esc, timeAgo, toast } from '../dom.js'

let poll = null

export async function render(host, ctx) {
  let data
  try {
    data = await api('/api/access?limit=200')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>访问记录</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const entries = data.entries ?? []

  host.innerHTML = `
    <div class="card">
      <h3>最近访客</h3>
      <p class="muted" id="note">${data.enabled
        ? '仅记录通过面板代理的请求。IP 为完整地址。'
        : '记录已关闭 — 请在设置中开启。'}</p>
      <div class="logbar">
        <input id="filter" placeholder="按 ip / 路径 过滤" style="max-width:260px">
        <label class="checkbox"><input type="checkbox" id="live"> 自动刷新 (10s)</label>
        <span class="muted" id="count"></span>
        <span style="flex:1"></span>
        <button class="btn btn-danger" id="clear">清空</button>
      </div>
      <div class="scroll"><table class="data">
        <thead><tr><th>时间</th><th>来源</th><th>方法</th><th>路径</th><th class="num">状态</th><th class="num">耗时</th><th>客户端</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      ${entries.length ? '' : '<p class="empty">还没有访问记录。</p>'}
    </div>
  `

  const rows = host.querySelector('#rows')
  const filter = host.querySelector('#filter')

  const paint = () => {
    const needle = filter.value.trim().toLowerCase()
    const shown = needle
      ? entries.filter((e) => `${e.ip} ${e.path} ${e.method}`.toLowerCase().includes(needle))
      : entries
    rows.innerHTML = shown.map((e) => `
      <tr>
        <td title="${esc(e.ts)}">${esc(timeAgo(e.ts))}</td>
        <td><code>${esc(e.ip || '-')}</code></td>
        <td>${esc(e.method)}</td>
        <td>${esc(e.path)}</td>
        <td class="num">${esc(e.status ?? '-')}</td>
        <td class="num">${esc(e.tookMs ?? '-')}ms</td>
        <td class="truncate" title="${esc(e.userAgent ?? '')}">${esc(shortAgent(e.userAgent))}</td>
      </tr>`).join('')
    host.querySelector('#count').textContent = `${shown.length} / ${entries.length} (已存 ${data.stats?.lines ?? 0} 条)`
  }

  filter.addEventListener('input', paint)
  paint()

  host.querySelector('#live').addEventListener('change', (event) => {
    clearInterval(poll)
    poll = null
    if (event.target.checked) poll = setInterval(() => ctx.refresh(), 10000)
  })

  host.querySelector('#clear').addEventListener('click', async () => {
    try {
      await api('/api/access', { method: 'DELETE' })
      toast('访问日志已清空', 'ok')
      await ctx.refresh()
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  ctx.onLeave(() => {
    clearInterval(poll)
    poll = null
  })
}

function shortAgent(agent) {
  const text = String(agent ?? '')
  if (!text) return '-'
  const browser = text.match(/(Chrome|Firefox|Safari|Edg|curl|PostmanRuntime)\/?[\d.]*/i)
  const os = text.match(/\(([^)]{0,40})\)/)
  return [browser?.[0], os?.[1]].filter(Boolean).join(' ').slice(0, 48) || text.slice(0, 48)
}
