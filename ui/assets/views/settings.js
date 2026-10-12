/**
 * Settings: the handful of knobs that change behaviour, plus diagnostics.
 * The DeepSeek API key lives only in dsh's own credentials file — the panel no
 * longer has a password gate (fnOS's gateway authenticates), so there is no
 * auth card here.
 */

import { api, esc, toast } from '../dom.js'

export async function render(host, ctx) {
  let data
  try {
    data = await api('/api/settings')
  } catch (error) {
    host.innerHTML = `<div class="card"><h3>设置</h3><p class="empty">${esc(error.message)}</p></div>`
    return
  }

  host.innerHTML = `
    <div class="card">
      <h3>网络</h3>
      <label class="field">
        <span>可信主机（逗号分隔）</span>
        <input id="trusted" value="${esc((data.trustedHosts ?? []).join(', '))}" placeholder="dsh.example.com">
      </label>
      <p class="muted">dsh 始终只听 <code>127.0.0.1:3080</code>（它自己的原生默认值，只信任本机）。局域网访问一律走面板的反代入口：<code>:28001</code> 的 <code>/p/</code>，以及 <code>:28000</code> 的直连口（自动带 token，无需手输）。切换 dsh 版本不需要改任何配置。</p>
      <label class="checkbox"><input type="checkbox" id="proxy-enabled" ${data.proxyEnabled !== false ? 'checked' : ''}> 通过面板代理提供 dsh (/p/)</label>
      <div class="btn-row"><button class="btn btn-primary" id="save-net">保存网络设置</button></div>
    </div>

    <div class="card">
      <h3>访问来源</h3>
      <label class="checkbox"><input type="checkbox" id="access-trust" ${data.access?.trustProxyHeaders !== false ? 'checked' : ''}> 信任 X-Forwarded-For</label>
      <p class="muted">主页只展示最近一次访问者 IP；开启后以来源代理头为准，关闭则以直连 socket 地址为准。</p>
      <div class="btn-row"><button class="btn btn-primary" id="save-access">保存访问设置</button></div>
    </div>

    <div class="card">
      <h3>版本</h3>
      <label class="field">
        <span>磁盘保留版本数</span>
        <input id="keep" type="number" min="1" max="10" value="${esc(data.versions?.keep ?? 3)}" style="max-width:140px">
      </label>
      <label class="field">
        <span>npm 仓库</span>
        <input id="registry" value="${esc(data.install?.npmRegistry || 'https://registry.npmjs.org')}">
      </label>
      <label class="field">
        <span>安装代理（可选）</span>
        <input id="install-proxy" value="${esc(data.install?.proxy || '')}" placeholder="http://127.0.0.1:7890">
      </label>
      <div class="btn-row"><button class="btn btn-primary" id="save-versions">保存版本设置</button></div>
    </div>

    <div class="card">
      <h3>环境</h3>
      <p class="muted">检测 node / npm / git 是否就绪。「一键修复」能真正做的：当 npm 在别的 node 目录或 PATH 里能找到、但没和当前 node 放一起时，自动建软链让面板稳定命中 npm；node 本身缺失或 git 缺失需重装套件（fnOS 装 nodejs_v22 依赖时自动补齐）。</p>
      <div id="env"></div>
      <div class="btn-row">
        <button class="btn" id="env-check">检测环境</button>
        <button class="btn btn-primary" id="env-install">一键修复环境</button>
      </div>
    </div>

    <div class="card">
      <h3>诊断</h3>
      <div class="btn-row"><button class="btn" id="diagnose">运行检查</button></div>
      <div id="diag"></div>
    </div>
  `

  const post = async (body, okMessage) => {
    try {
      await api('/api/settings', { method: 'POST', body })
      toast(okMessage, 'ok')
      await ctx.refresh()
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  host.querySelector('#save-net').addEventListener('click', () => {
    const trustedHosts = host.querySelector('#trusted').value
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    // lanBind 已废弃：dsh 永远只听自己的原生回环默认值，LAN 走面板反代。
    post({
      trustedHosts,
      lanBind: false,
      proxy: { enabled: host.querySelector('#proxy-enabled').checked },
    }, '网络设置已保存')
  })

  host.querySelector('#save-access').addEventListener('click', () => {
    post({
      access: {
        trustProxyHeaders: host.querySelector('#access-trust').checked,
      },
    }, '访问设置已保存')
  })

  host.querySelector('#save-versions').addEventListener('click', () => {
    post({
      versions: { keep: Number(host.querySelector('#keep').value) || 3 },
      install: {
        npmRegistry: host.querySelector('#registry').value.trim() || 'https://registry.npmjs.org',
        proxy: host.querySelector('#install-proxy').value.trim(),
      },
    }, '版本设置已保存')
  })

  host.querySelector('#diagnose').addEventListener('click', async () => {
    const box = host.querySelector('#diag')
    box.innerHTML = '<p class="muted">运行中…</p>'
    try {
      const report = await api('/api/diagnostics')
      const rows = (report.checks ?? []).map((c) => `
        <tr>
          <td>${esc(c.label ?? c.name ?? '-')}</td>
          <td><span class="tag tag-${c.status === 'pass' ? 'current' : c.status === 'fail' ? 'danger' : 'muted'}">${esc(c.status)}</span></td>
          <td class="muted">${esc(c.detail ?? '')}${c.fix ? `<br><span class="muted">→ ${esc(c.fix)}</span>` : ''}</td>
        </tr>`).join('')
      const failed = (report.checks ?? []).filter((c) => c.status === 'fail').length
      box.innerHTML = `
        ${failed ? `<p class="alert-box alert-warn">${failed} 项检查未通过。</p>` : ''}
        <div class="scroll"><table class="data">
          <thead><tr><th>检查项</th><th>结果</th><th>详情</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="empty">无检查结果</td></tr>'}</tbody>
        </table></div>`
    } catch (error) {
      box.innerHTML = `<p class="empty">${esc(error.message)}</p>`
    }
  })

  const renderEnv = (state) => {
    const box = host.querySelector('#env')
    const row = (label, tool) => {
      const ok = tool?.present
      const badge = ok
        ? '<span class="tag tag-current">就绪</span>'
        : '<span class="tag tag-danger">缺失</span>'
      const err = !ok && tool?.error ? `<span class="muted"> — ${esc(tool.error)}</span>` : ''
      return `<div class="row"><span class="k">${label}</span><span class="v">${badge} ${esc(tool?.path || '-')} ${tool?.version ? `<span class="muted">${esc(tool.version)}</span>` : ''}${err}</span></div>`
    }
    box.innerHTML = `
      ${row('node', state.node)}
      ${row('npm', state.npm)}
      ${row('git', state.git)}
      ${(state.nodes ?? []).length ? `
        <div class="row"><span class="k">可用 node 版本</span><span class="v">${state.nodes.map((n) => `<span class="tag ${n.bin === state.bestNode ? 'tag-current' : ''}">${esc(n.version)}${n.bin === state.bestNode ? ' (启动 dsh)' : ''}</span>`).join(' ')}</span></div>
      ` : ''}
      ${state.needsFix ? '<p class="muted" style="margin-top:8px">检测到缺失项，可点击「一键安装环境」。</p>' : ''}
    `
  }

  host.querySelector('#env-check').addEventListener('click', async () => {
    const box = host.querySelector('#env')
    box.innerHTML = '<p class="muted">检测中…</p>'
    try {
      renderEnv(await api('/api/env'))
    } catch (error) {
      box.innerHTML = `<p class="empty">${esc(error.message)}</p>`
    }
  })

  host.querySelector('#env-install').addEventListener('click', async () => {
    const box = host.querySelector('#env')
    box.innerHTML = '<p class="muted">修复中…</p>'
    try {
      const result = await api('/api/env/install', { method: 'POST' })
      renderEnv(result.after ?? result.before)
      const notes = result.notes ?? []
      if (notes.length) {
        box.innerHTML += `<p class="muted">${notes.map(esc).join('<br>')}</p>`
      }
      toast(result.ok ? '环境已就绪' : '环境部分缺失，见详情', result.ok ? 'ok' : 'error')
    } catch (error) {
      box.innerHTML = `<p class="empty">${esc(error.message)}</p>`
    }
  })

  // Initial environment check on load.
  try {
    renderEnv(await api('/api/env'))
  } catch { /* env probe is best-effort */ }
}
