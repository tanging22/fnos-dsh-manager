/** Versions: what is installed, what npm offers, and which one is pinned. */

import { api, esc, bytes, localTime, toast } from '../dom.js'

let poll = null

export async function render(host, ctx) {
  let state
  try {
    state = await api('/api/versions')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>版本</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const installed = state.installed ?? []
  const available = state.available ?? []

  host.innerHTML = `
    <div class="card">
      <h3>已安装</h3>
      ${installed.length ? `
        <div class="scroll"><table class="data">
          <thead><tr><th>版本</th><th>安装时间</th><th class="num">大小</th><th></th></tr></thead>
          <tbody>
            ${installed.map((v) => `
              <tr>
                <td>${esc(v.version)} ${v.current ? '<span class="tag tag-current">当前</span>' : ''}</td>
                <td>${localTime(v.installedAt)}</td>
                <td class="num">${bytes(v.sizeBytes)}</td>
                <td class="actions">
                  <button class="btn" data-switch="${esc(v.version)}" ${v.current ? 'disabled' : ''}>使用</button>
                  <button class="btn btn-danger" data-remove="${esc(v.version)}" ${v.current || installed.length <= 1 ? 'disabled' : ''}>删除</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="empty">尚未安装任何版本 - 从下方选择一个版本。</p>'}
      <div class="btn-row">
        <button class="btn btn-danger" id="prune">清理旧版本</button>
      </div>
    </div>

    <div class="card">
      <h3>从仓库安装</h3>
      <div class="logbar">
        <select id="pick" style="max-width:220px"></select>
        <button class="btn btn-primary" id="install">安装</button>
        <button class="btn" id="refresh-list">刷新列表</button>
        <span class="muted" id="reg"></span>
      </div>
      <p class="muted" id="job"></p>
      <pre class="log log-sm" id="joblog" hidden></pre>
    </div>
  `

  const pick = host.querySelector('#pick')
  pick.innerHTML = available.length
    ? available.map((v) => `<option value="${esc(v)}">${esc(v)}${v === state.latest ? ' (latest)' : ''}</option>`).join('')
    : `<option value="">${esc(state.error || '仓库不可达')}</option>`
  if (state.current && available.includes(state.current)) pick.value = state.current

  host.querySelector('#reg').textContent = state.cached
    ? `${state.registry} - 缓存于 ${localTime(new Date(state.fetchedAt).toISOString())}`
    : `${state.registry} - 实时`

  const jobLine = host.querySelector('#job')
  const jobLog = host.querySelector('#joblog')

  const watch = async () => {
    const job = await api('/api/versions/job').catch(() => ({ job: null }))
    const current = job.job
    if (!current || current.status !== 'running') {
      clearInterval(poll)
      poll = null
      if (current?.status === 'done') {
        toast(`已安装 ${current.version}`, 'ok')
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
    jobLine.textContent = `正在安装 ${current.version}...`
    if (current.log) {
      jobLog.hidden = false
      jobLog.textContent = current.log
      jobLog.scrollTop = jobLog.scrollHeight
    }
  }

  host.querySelector('#install').addEventListener('click', async () => {
    const version = pick.value
    if (!version) return toast('未选择版本', 'error')
    try {
      await api('/api/versions/install', { method: 'POST', body: { version } })
      toast(`安装已开始: ${version}`, 'ok')
      clearInterval(poll)
      poll = setInterval(watch, 2000)
      jobLine.textContent = `正在安装 ${version}...`
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  host.querySelector('#refresh-list').addEventListener('click', async () => {
    try {
      await api('/api/versions?refresh=1')
      await ctx.render()
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  host.querySelector('#prune').addEventListener('click', async () => {
    try {
      const result = await api('/api/versions/prune', { method: 'POST' })
      toast(result.removed?.length ? `已移除 ${result.removed.join(', ')}` : '没有可清理的版本', 'ok')
      await ctx.render()
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  host.querySelectorAll('[data-switch]').forEach((button) => {
    button.addEventListener('click', async () => {
      const version = button.dataset.switch
      try {
        await api('/api/versions/switch', { method: 'POST', body: { version } })
        toast(`已切换到 ${version}；启动 dsh 后生效`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })

  host.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const version = button.dataset.remove
      if (!confirm(`确定删除已安装的 dsh ${version}？此操作不可恢复。`)) return
      try {
        await api('/api/versions/remove', { method: 'POST', body: { version } })
        toast(`已删除 ${version}`, 'ok')
        await ctx.render()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })

  ctx.onLeave(() => {
    clearInterval(poll)
    poll = null
  })

  // Pick up an install that was already running before this tab opened.
  await watch()
}
