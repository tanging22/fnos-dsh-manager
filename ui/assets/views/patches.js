/**
 * Patches: inspect and apply the runtime edits applied to dsh's own client
 * bundles. See cmd/dashboard-patches.js for why the settings host-mode patch
 * exists and what lifting dsh's loopback guard costs.
 */

import { api, esc, toast } from '../dom.js'

const STATE_LABEL = {
  already: ['已应用', 'tag-ok'],
  pending: ['待应用', 'tag-warn'],
  missing: ['上游已不需要', ''],
  error: ['失败', 'tag-fail'],
}

export async function render(host, ctx) {
  let data
  try {
    data = await api('/api/patches')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>补丁</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  const versions = data.versions ?? []

  host.innerHTML = `
    <div class="card">
      <h3>dsh 补丁</h3>
      <p class="muted">
        <b>设置项 host 模式</b>：dsh 用 <code>ctx.remote.$host.isLoopback</code> 决定设置读写位置 ——
        回环走 <code>host</code>（读服务端配置），非回环走 <code>memory</code>（进程内，改了不落盘）。
        局域网从 <code>:28000</code> 进来一定是非回环，于是插件与模型设置整页空白。
        本补丁把该三元表达式钉成字面量 <code>"host"</code>，让 LAN / FN Connect 也能读写服务端配置。
      </p>
      <p class="muted">
        代价：<b>这解除了 dsh 有意的回环限制</b>。信任面完全依赖本面板的围栏，
        所以请勿把 <code>:28000</code> / <code>:28001</code> 暴露到不受信任的网络。
      </p>
      ${versions.length ? `
        <div class="scroll"><table class="data">
          <thead><tr><th>dsh 版本</th><th>文件</th><th>状态</th></tr></thead>
          <tbody>
            ${versions.map((entry) => `
              <tr>
                <td>${esc(entry.version)}</td>
                <td>${entry.files.length ? esc(entry.files.map((f) => f.file.split('/')[0]).join(', ')) : '<span class="muted">无相关文件</span>'}</td>
                <td>${entry.files.map((f) => {
                  const [label, cls] = STATE_LABEL[f.state] ?? [f.state, '']
                  return `<span class="tag ${cls}">${esc(label)}</span>` + (f.error ? ` <span class="muted">${esc(f.error)}</span>` : '')
                }).join(' ') || '<span class="muted">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : '<p class="empty">尚未安装任何 dsh 版本 - 先到「版本」页装一个。</p>'}
      <div class="btn-row">
        <button class="btn btn-primary" id="apply" ${versions.length ? '' : 'disabled'}>应用补丁并重启 dsh</button>
        <button class="btn" id="refresh">刷新</button>
      </div>
      <p class="muted">应用是幂等的：已打过补丁的文件会被跳过，新装的 dsh 版本会在下次点「应用」时一并补上。</p>
    </div>
  `

  host.querySelector('#refresh').addEventListener('click', () => ctx.render())
  host.querySelector('#apply')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = '应用中...'
    try {
      const result = await api('/api/patches/apply', { method: 'POST' })
      const patched = result.versions.reduce(
        (sum, entry) => sum + entry.files.filter((f) => f.state === 'patched').length, 0)
      const already = result.versions.reduce(
        (sum, entry) => sum + entry.files.filter((f) => f.state === 'already').length, 0)
      toast(`已打补丁 ${patched} 个文件，跳过 ${already} 个；dsh 已重启`)
      await ctx.render()
    } catch (error) {
      toast(`应用失败：${error.message}`)
      button.disabled = false
      button.textContent = '应用补丁并重启 dsh'
    }
  })
}
