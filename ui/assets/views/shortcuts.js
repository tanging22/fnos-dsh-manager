/**
 * Shortcuts: the reachable URLs the panel can compute, plus whatever the
 * operator pins. Custom entries are stored through /api/settings.
 */

import { api, esc, toast } from '../dom.js'

export async function render(host, ctx) {
  let data
  try {
    data = await api('/api/shortcuts')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>快捷入口</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const discovered = data.entries ?? []
  const custom = data.custom ?? []

  host.innerHTML = `
    <div class="card">
      <h3>自动发现</h3>
      <p class="muted">根据实时端口和本机实际拥有的地址生成。</p>
      <div class="scroll"><table class="data">
        <thead><tr><th>入口</th><th>URL</th><th>备注</th><th></th></tr></thead>
        <tbody>
          ${discovered.map((e) => `
            <tr>
              <td>${esc(e.label)}</td>
              <td><a href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(e.url)}</a></td>
              <td class="muted">${esc(e.note ?? '')}</td>
              <td><span class="muted">${esc(e.health ?? '')}</span></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h3>固定入口</h3>
      ${custom.length ? `
        <div class="scroll"><table class="data">
          <thead><tr><th>名称</th><th>URL</th><th></th></tr></thead>
          <tbody>
            ${custom.map((e, index) => `
              <tr>
                <td>${esc(e.label)}</td>
                <td><a href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(e.url)}</a></td>
                <td><button class="btn btn-danger" data-remove="${index}">移除</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="empty">还没有固定入口。</p>'}
      <div class="logbar">
        <input id="label" placeholder="名称" style="max-width:180px">
        <input id="url" placeholder="https://..." style="flex:1">
        <button class="btn btn-primary" id="add">固定</button>
      </div>
    </div>
  `

  host.querySelector('#add').addEventListener('click', async () => {
    const label = host.querySelector('#label').value.trim()
    const url = host.querySelector('#url').value.trim()
    if (!label || !url) return toast('名称和 URL 都必填', 'error')
    if (!/^https?:\/\//i.test(url)) return toast('URL 必须以 http:// 或 https:// 开头', 'error')
    try {
      await api('/api/settings', { method: 'POST', body: { shortcuts: [...custom, { label, url }] } })
      toast('已固定', 'ok')
      await ctx.refresh()
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  host.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const index = Number(button.dataset.remove)
      const next = custom.filter((_, i) => i !== index)
      try {
        await api('/api/settings', { method: 'POST', body: { shortcuts: next } })
        await ctx.refresh()
      } catch (error) {
        toast(error.message, 'error')
      }
    })
  })
}
