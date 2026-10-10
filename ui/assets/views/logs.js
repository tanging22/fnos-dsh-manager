/** Logs: pick a file, read its tail. Polling is opt-in, never automatic. */

import { api, esc, localTime, toast } from '../dom.js'

let timer = null
let lastBlobUrl = null

export async function render(host, ctx) {
  let listing
  try {
    listing = await api('/api/logs/list')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>日志</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const files = listing.files ?? []
  const selected = ctx.state.logFile || files[0]?.name || 'dsh.log'

  host.innerHTML = `
    <div class="card">
      <h3>日志</h3>
      <div class="logbar">
        <select id="file" style="max-width:280px"></select>
        <select id="lines" style="max-width:110px">
          <option value="10" selected>10 行</option>
          <option value="50">50 行</option>
          <option value="100">100 行</option>
          <option value="200">200 行</option>
          <option value="500">500 行</option>
        </select>
        <button class="btn" id="reload">刷新</button>
        <button class="btn" id="export">导出</button>
        <label class="checkbox"><input type="checkbox" id="follow"> 自动跟随 (5s)</label>
        <span class="muted" id="meta"></span>
      </div>
      <pre class="log" id="out">加载中...</pre>
    </div>
  `

  const select = host.querySelector('#file')
  select.innerHTML = files.length
    ? files.map((f) => `<option value="${esc(f.name)}" ${f.name === selected ? 'selected' : ''}>${esc(f.name)} - ${esc(f.sizeBytes)}B</option>`).join('')
    : '<option value="">(暂无日志文件)</option>'

  const out = host.querySelector('#out')
  const meta = host.querySelector('#meta')
  let lastText = ''

  const load = async () => {
    const name = host.querySelector('#file').value
    const lines = host.querySelector('#lines').value
    if (!name) {
      out.textContent = '未选择日志文件。'
      return
    }
    ctx.state.logFile = name
    try {
      const data = await api(`/api/logs?file=${encodeURIComponent(name)}&lines=${encodeURIComponent(lines)}`)
      const text = (data.lines ?? []).join('\n') || '(空)'
      // Only touch the DOM when the content actually changed: a follow poll on an
      // idle log must not cause a re-layout on every tick.
      if (text !== lastText) {
        lastText = text
        out.textContent = text
      }
      meta.textContent = `${data.file} - ${localTime(data.modifiedAt)}${data.truncated ? ' - 已截断' : ''}`
    } catch (error) {
      out.textContent = `失败: ${error.message}`
      toast(error.message, 'error')
    }
  }

  host.querySelector('#reload').addEventListener('click', load)
  host.querySelector('#file').addEventListener('change', load)
  host.querySelector('#lines').addEventListener('change', load)
  host.querySelector('#follow').addEventListener('change', (event) => {
    clearInterval(timer)
    timer = null
    if (event.target.checked) timer = setInterval(load, 5000)
  })

  host.querySelector('#export').addEventListener('click', () => {
    const name = host.querySelector('#file').value
    const text = out.textContent
    if (!name || !text) return toast('没有可导出的日志', 'error')
    // Free the previous object URL so a long session does not leak blobs.
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl)
    const blob = new Blob([text], { type: 'text/plain; charset=utf-8' })
    lastBlobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = lastBlobUrl
    a.download = `${name.replace(/[^\w.-]/g, '_')}-${Date.now()}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
  })

  // Stop following when the operator leaves the tab.
  ctx.onLeave(() => {
    clearInterval(timer)
    timer = null
  })

  await load()
}
