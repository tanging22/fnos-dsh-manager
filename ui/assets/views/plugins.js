/** Plugins: install / remove / enable bundles and toggle plugin rows. */

import { api, esc, toast } from '../dom.js'

let poll = null

export async function render(host, ctx) {
  let state
  try {
    state = await api('/api/plugins')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>插件</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const bundles = state.bundles ?? []
  const pluginRows = state.pluginRows ?? []
  const market = state.market ?? {}

  host.innerHTML = `
    <div class="card">
      <h3>插件市场 (dshmarket)</h3>
      <p class="muted">将官方 dsh 插件市场安装到受管 profile 中。
        安装后，打开 dsh 并在「设置 → 插件市场」中浏览和添加插件。</p>
      <div class="btn-row">
        ${market.installed
          ? `<button class="btn btn-primary" id="market-update">更新 ${esc(market.package)}</button>
             <button class="btn btn-danger" id="market-remove">移除</button>
             <span class="tag ${market.enabled ? 'tag-current' : ''}">${market.enabled ? '已启用' : '已禁用'}</span>`
          : `<button class="btn btn-primary" id="market-install">安装 ${esc(market.package)}</button>`}
      </div>
      <p class="muted" id="job"></p>
      <pre class="log log-sm" id="joblog" hidden></pre>
    </div>

    <div class="card">
      <h3>已安装的插件包</h3>
      <p class="muted">${esc(state.restartRequiredHint ?? '')}</p>
      ${bundles.length ? `
        <div class="scroll"><table class="data">
          <thead><tr><th>包名</th><th>版本</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${bundles.map((b) => `
              <tr>
                <td>${esc(b.name)}${b.isMarket ? ' <span class="tag tag-current">市场</span>' : ''}</td>
                <td>${esc(b.version ?? '—')}</td>
                <td>${b.installed
                  ? `<span class="tag ${b.enabled ? 'tag-current' : ''}">${b.enabled ? '已启用' : '已禁用'}</span>`
                  : '<span class="tag">未安装</span>'}</td>
                <td>
                  ${b.installed
                    ? `<button class="btn" data-toggle="${esc(b.name)}" data-enabled="${b.enabled ? '1' : '0'}">${b.enabled ? '禁用' : '启用'}</button>
                       ${b.removable ? `<button class="btn btn-danger" data-remove="${esc(b.name)}">移除</button>` : ''}`
                    : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="empty">未安装任何插件。在下方添加，或安装插件市场。</p>'}
    </div>

    <div class="card">
      <h3>安装插件</h3>
      <div class="logbar">
        <input type="text" id="spec" placeholder="包名，如 dshmarket 或 @scope/name" style="flex:1">
        <button class="btn" id="inspect">检查</button>
        <button class="btn btn-primary" id="install">安装</button>
      </div>
      <p class="muted" id="inspect-result"></p>
    </div>

    ${pluginRows.length ? `
    <div class="card">
      <h3>插件条目 (patch 覆盖)</h3>
      <div class="scroll"><table class="data">
        <thead><tr><th>ID</th><th>模块</th><th>状态</th><th></th></tr></thead>
        <tbody>
          ${pluginRows.map((row) => `
            <tr>
              <td>${esc(row.id)}</td>
              <td>${esc(row.name || '—')}</td>
              <td><span class="tag ${row.disabled ? '' : 'tag-current'}">${row.disabled ? '已禁用' : '已启用'}</span></td>
              <td><button class="btn" data-row="${esc(row.id)}" data-rowname="${esc(row.name)}" data-rowdisabled="${row.disabled ? '1' : '0'}">${row.disabled ? '启用' : '禁用'}</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>` : ''}
  `

  const jobLine = host.querySelector('#job')
  const jobLog = host.querySelector('#joblog')

  const watch = async () => {
    const job = await api('/api/plugins/job').catch(() => ({ job: null }))
    const current = job.job
    if (!current || current.status !== 'running') {
      clearInterval(poll)
      poll = null
      if (current?.status === 'done') {
        toast(`已安装 ${current.name ?? current.spec}`, 'ok')
        jobLine.textContent = ''
        jobLog.hidden = true
        jobLog.textContent = ''
        await ctx.render()
        return
      }
      if (current?.status === 'failed') {
        toast(`安装失败: ${current.error ?? '未知'}`, 'error', 8000)
        jobLine.textContent = current.detail ? String(current.detail).slice(-500) : ''
        jobLog.hidden = true
      }
      return
    }
    jobLine.textContent = `正在安装 ${current.spec ?? ''}...`
    if (current.log) {
      jobLog.hidden = false
      jobLog.textContent = current.log
      jobLog.scrollTop = jobLog.scrollHeight
    }
  }

  const startInstall = async (spec) => {
    try {
      await api('/api/plugins/install', { method: 'POST', body: { spec } })
      toast(`安装已开始: ${spec}`, 'ok')
      clearInterval(poll)
      poll = setInterval(watch, 2000)
      jobLine.textContent = `正在安装 ${spec}...`
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  // dshmarket install / update / remove buttons
  const marketInstall = host.querySelector('#market-install')
  if (marketInstall) marketInstall.addEventListener('click', () => startInstall(market.package))
  const marketUpdate = host.querySelector('#market-update')
  if (marketUpdate) marketUpdate.addEventListener('click', () => startInstall(market.package))
  const marketRemove = host.querySelector('#market-remove')
  if (marketRemove) {
    marketRemove.addEventListener('click', async () => {
      try {
        const result = await api('/api/plugins/remove', { method: 'POST', body: { name: market.package } })
        toast(`已移除 ${result.name}`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  }

  // Bundle toggle (enable/disable)
  host.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.toggle
      const enabled = button.dataset.enabled !== '1'
      try {
        await api('/api/plugins/enable', { method: 'POST', body: { name, enabled } })
        toast(`${enabled ? '已启用' : '已禁用'} ${name}`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })

  // Bundle remove
  host.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.remove
      try {
        await api('/api/plugins/remove', { method: 'POST', body: { name } })
        toast(`已移除 ${name}`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })

  // Plugin row toggle
  host.querySelectorAll('[data-row]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.row
      const name = button.dataset.rowname || ''
      const enabled = button.dataset.rowdisabled === '1'
      try {
        await api('/api/plugins/row', { method: 'POST', body: { id, name, enabled } })
        toast(`${enabled ? '已启用' : '已禁用'} ${id}`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })

  // Inspect + install
  host.querySelector('#inspect').addEventListener('click', async () => {
    const spec = host.querySelector('#spec').value.trim()
    const out = host.querySelector('#inspect-result')
    if (!spec) return toast('请输入包名', 'error')
    try {
      const result = await api('/api/plugins/inspect', { method: 'POST', body: { spec } })
      out.textContent = result.ok
        ? `${result.name} — 最新 ${result.latest} (${result.versions?.length ?? 0} 个版本)`
        : `未找到: ${result.error}`
    } catch (error) {
      out.textContent = error.message
    }
  })

  host.querySelector('#install').addEventListener('click', async () => {
    const spec = host.querySelector('#spec').value.trim()
    if (!spec) return toast('请输入包名', 'error')
    await startInstall(spec)
  })

  ctx.onLeave(() => {
    clearInterval(poll)
    poll = null
  })

  // Pick up an install already running before this tab opened.
  await watch()
}
