#!/usr/bin/env node
/**
 * End-to-end smoke test, runnable on the NAS or on a dev box.
 *
 * It boots the real panel against a throwaway DATA_DIR, drives its HTTP API the
 * way the browser does, and asserts the behaviour that actually matters:
 *  - the trust fence rejects an untrusted Host,
 *  - there is no auth gate (fnOS's gateway authenticates; the panel serves once
 *    the trust fence passes, and ignores any x-console-key header),
 *  - every view's endpoint answers with the shape the UI expects,
 *  - the reverse proxy records a visit (the whole reason it exists),
 *  - log tailing survives a file it cannot read.
 *
 * Nothing here touches the real dsh instance: DSH_PORT points at a stub the
 * test starts itself, so `npm run smoke` is safe on a live box.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const PANEL_PORT = 29001
const STUB_PORT = 29000
const PASSWORD = 'smoke-test-key'

const sandbox = mkdtempSync(join(tmpdir(), 'fnos-dsh-manager-smoke-'))
const dataDir = join(sandbox, 'data')
const homeDir = join(dataDir, 'dsh_home')
mkdirSync(join(homeDir, 'profiles', 'web'), { recursive: true })
mkdirSync(join(dataDir, 'logs'), { recursive: true })
writeFileSync(join(homeDir, '.credentials.yaml'), `DEEPSEEK_API_KEY: ${PASSWORD}\n`)
writeFileSync(join(dataDir, 'dsh.log'), 'stub log line one\nstub log line two\n')

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${condition || !detail ? '' : ` — ${detail}`}`)
}

/** The dsh the panel proxies to; records that it was reached.
 *
 * `/html*` answers with REAL HTML, because the proxy's HTML path (CSP strip +
 * `__DSH_TRANSPORT__` shim + manifest `crossorigin` injection) is where a bug
 * breaks every page the panel serves. The stub replied `text/plain`
 * unconditionally, so that entire path had no coverage — which is how
 * `injectManifestCredentials` could call `.replace()` on a Buffer and throw an
 * uncaught exception on every HTML response while the suite stayed green.
 */
/* An oversized HTML page: bigger than the panel's 8MB injection cap.
 *
 * The buffer cap exists so a mislabelled upstream cannot make one request eat
 * arbitrary memory — but the old implementation implemented "give up injecting
 * and pass it through" as `if (buffered <= CAP) chunks.push(c)`, i.e. it stopped
 * collecting, returned the truncated first 8MB, AND declared that truncated
 * length as `content-length`. The client silently got a broken page. The fix
 * pipes the response straight through instead, so the body must arrive intact.
 */
const HUGE_PREFIX = '<!doctype html><html><body>'
const HUGE_SUFFIX = '</body></html>'
const HUGE_PADDING = 9 * 1024 * 1024
const HUGE_HTML_LENGTH = HUGE_PREFIX.length + HUGE_PADDING + HUGE_SUFFIX.length

let stubHits = 0
const stub = createServer((request, response) => {
  stubHits += 1
  const url = request.url ?? '/'
  if (url.startsWith('/html-huge')) {
    const body = `${HUGE_PREFIX}${'x'.repeat(HUGE_PADDING)}${HUGE_SUFFIX}`
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
    return
  }
  /* 上游以为自己住在回环上：302 + HTML body（因此走 proxyHtml 分支，而不是
     上面「其它」分支的 location 剥离）。真实 dsh 在 / 未登录/未初始化时就是
     这种响应——Location 若原样带出去，浏览器会跳到它自己的 127.0.0.1:3080，
     表现就是「打开 :28000 一片空白」。 */
  if (url.startsWith('/redirect')) {
    response.writeHead(302, {
      'content-type': 'text/html; charset=utf-8',
      location: `http://127.0.0.1:${STUB_PORT}/login?next=%2F`,
    })
    response.end('<!doctype html><html><body>redirecting</body></html>')
    return
  }
  if (url.startsWith('/html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head>
<title>dsh</title>
<link rel="manifest" href="/manifest.webmanifest">
</head><body><h1>你好 dsh</h1>
<div data-slot="settings.action">open config</div>
</body></html>`)
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(`stub:${url}`)
})

/* The stub has to speak WebSocket upgrades, because the panel's WS proxy is a
 * separate code path from the HTTP proxy and the bug that shipped in 1.0.29/
 * 1.0.30 lived only there. Node's HTTP server emits the 101 handshake headers
 * in LOWERCASE, and the proxy used to append its own capitalised `Connection` /
 * `Upgrade` on top, so the browser saw each name twice and refused the socket
 * while the access log happily recorded 101. Reproducing the lowercase form
 * here is the whole point: an upstream that capitalised them would have hidden
 * the bug. */
stub.on('upgrade', (request, socket, head) => {
  if (!(request.url ?? '').startsWith('/api/remote.mux')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'upgrade: websocket',
    'connection: Upgrade',
    'sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZbK+xOoo=',
    'sec-websocket-protocol: typert-mux',
    '',
    '',
  ].join('\r\n'))
  if (head && head.length) socket.unshift(head)
  socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])) // a masked-less text frame "hi"
})

const panelEnv = {
  ...process.env,
  DATA_DIR: dataDir,
  DSH_HOME: homeDir,
  CONSOLE_PORT: String(PANEL_PORT),
  DSH_PORT: String(STUB_PORT),
  TRIM_APPNAME: 'fnos-dsh-manager',
  TRIM_APPDEST: join(sandbox, 'app'),
  TRIM_PKGVAR: dataDir,
  MANAGED_APP_DIR: join(sandbox, 'app'),
  CONSOLE_UI: join(ROOT, 'ui'),
  // MANIFEST is what `cmd/main` exports on a real box so the panel can read its
  // own version. The suite omitted it, which is precisely why the "panel reports
  // v0.0.0" bug survived: without it the panel fell back to the non-existent
  // /var/apps/{appname}/manifest and the version assertions had nothing to
  // compare against. Mirroring production here keeps this harness honest.
  MANIFEST: join(ROOT, 'manifest'),
}

const panel = spawn(process.execPath, [join(ROOT, 'cmd', 'dashboard.js')], {
  env: panelEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let panelOutput = ''
panel.stdout.on('data', (chunk) => { panelOutput += chunk })
panel.stderr.on('data', (chunk) => { panelOutput += chunk })

const base = `http://127.0.0.1:${PANEL_PORT}`

async function waitForPanel(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/status`)
      if (response.status) return true
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** Call the API the way the UI does, with the key header. */
function call(path, { method = 'GET', key = PASSWORD, headers = {}, body, redirect = 'follow' } = {}) {
  const init = { method, headers: { ...headers }, redirect }
  if (key) init.headers['x-console-key'] = key
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  return fetch(`${base}${path}`, init)
}

async function jsonOf(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

/**
 * Poll `probe` until it returns a non-null value, or fail after `timeoutMs`.
 *
 * Several parts of the panel are deliberately asynchronous (the visitor log
 * batches writes; service start waits on health checks), so the honest test is
 * "it converges", not "it is instant".
 */
async function waitFor(probe, { timeoutMs = 5000, intervalMs = 150, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last !== null && last !== undefined && last !== false) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  console.log(`      (timed out waiting for ${description} after ${timeoutMs}ms)`)
  return last === false ? null : null
}

/**
 * Send a raw HTTP/1.1 request and return the status line plus body.
 *
 * `fetch` cannot express a forged Host header — undici treats it as forbidden
 * and silently substitutes the real one — so the trust fence has to be tested
 * over a plain socket. That is exactly the attack path a hostile client would
 * take, which makes it the honest test.
 */
function rawRequest({ host, path = '/', method = 'GET', extraHeaders = [] }) {
  return new Promise((resolve, reject) => {
    const socket = connect(PANEL_PORT, '127.0.0.1', () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        ...extraHeaders,
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { data += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0)
      const body = data.slice(data.indexOf('\r\n\r\n') + 4)
      resolve({ status, body })
    })
  })
}

/* Same trick as rawRequest, but for an upgrade: keep reading past the headers so
 * the test can prove the tunnel is live and upstream frames come back. */
function rawUpgrade({ host, port = PANEL_PORT, path, protocol = 'typert-mux' }) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${protocol}`,
        '',
        '',
      ].join('\r\n'))
    })
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('binary')
      const split = text.indexOf('\r\n\r\n')
      resolve({
        head: split === -1 ? text : text.slice(0, split),
        tail: split === -1 ? '' : text.slice(split + 4),
      })
      socket.destroy()
    }
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('binary')
      // Headers plus the two "hi" payload bytes: enough to prove the pipe works.
      if (text.indexOf('\r\n\r\n') !== -1 && text.length >= text.indexOf('\r\n\r\n') + 6) finish()
    })
    socket.on('error', (error) => { if (!done) { done = true; reject(error) } })
    socket.on('close', finish)
    setTimeout(finish, 3000).unref?.()
  })
}

/* Same as rawUpgrade, but over the gateway proxy's Unix socket — the last hop
 * between the browser and the panel, i.e. exactly what the fnOS 统一网关 does. */
function rawUpgradeUnix({ socketPath, host, path, protocol = 'typert-mux' }) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${protocol}`,
        '',
        '',
      ].join('\r\n'))
    })
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('binary')
      const split = text.indexOf('\r\n\r\n')
      resolve({
        head: split === -1 ? text : text.slice(0, split),
        tail: split === -1 ? '' : text.slice(split + 4),
      })
      socket.destroy()
    }
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('binary')
      if (text.indexOf('\r\n\r\n') !== -1 && text.length >= text.indexOf('\r\n\r\n') + 6) finish()
    })
    socket.on('error', (error) => { if (!done) { done = true; reject(error) } })
    socket.on('close', finish)
    setTimeout(finish, 3000).unref?.()
  })
}

try {
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve))

  if (!(await waitForPanel())) {
    console.error('panel did not start within 15s')
    console.error(panelOutput.slice(-4000))
    process.exit(1)
  }

  /* --- trust fence: a Host the panel does not know must be refused --------- */
  /* Over a raw socket: fetch would rewrite the Host header and the test would
     pass no matter what the fence does. */
  const untrusted = await rawRequest({ host: 'evil.example.com', path: '/api/status' })
  check('untrusted Host is rejected', untrusted.status === 403, `got ${untrusted.status}`)
  check('rejection names the host', untrusted.body.includes('evil.example.com'), untrusted.body.trim())

  const crossSite = await rawRequest({
    host: `127.0.0.1:${PANEL_PORT}`,
    path: '/api/status',
    extraHeaders: ['Origin: https://evil.example.com'],
  })
  check('cross-site Origin is rejected', crossSite.status === 403, `got ${crossSite.status}`)

  const trustedRaw = await rawRequest({ host: `127.0.0.1:${PANEL_PORT}`, path: '/api/status' })
  check('loopback Host is still allowed', trustedRaw.status === 200, `got ${trustedRaw.status}`)

  /* --- no auth gate: fnOS's gateway authenticates, the panel does not ------ */
  /* There is deliberately no password check. Every API call is served once it
     passes the trust fence above; a missing or wrong `x-console-key` header is
     simply ignored. */
  const noKey = await call('/api/logs/list', { key: '' })
  check('request without a key is served', noKey.status === 200, `got ${noKey.status}`)

  const wrongKey = await call('/api/logs/list', { key: 'nope' })
  check('request with a wrong key is still served', wrongKey.status === 200, `got ${wrongKey.status}`)

  const login = await call('/api/login', { method: 'POST', key: '', body: { password: PASSWORD } })
  check('login endpoint is gone', login.status === 404, `got ${login.status}`)

  /* --- status ------------------------------------------------------------ */
  const status = await jsonOf(await call('/api/status'))
  check('status reports the panel port', status.panel?.port === PANEL_PORT, JSON.stringify(status.panel))
  check('status reports the configured dsh port', status.port === STUB_PORT, String(status.port))
  /* The access log was removed in v1.0.40 (the overview only shows the last
     visitor's IP), so /api/status must no longer carry a log summary. */
  check('status carries no access-log summary', status.access === undefined, JSON.stringify(status.access))
  /* Session holding is what keeps the reverse proxy authenticated. A panel that
     lost it serves 401s and the dsh client's WebSocket dies after 60s, so the
     state has to be visible rather than inferred from a blank page. */
  check('status exposes session-holding state',
    typeof status.session?.token === 'boolean' && typeof status.session?.cookie === 'boolean',
    JSON.stringify(status.session))
  check('status has no secret in it', !JSON.stringify(status).includes(PASSWORD), 'password leaked into /api/status')

  /* --- logs -------------------------------------------------------------- */
  const logList = await jsonOf(await call('/api/logs/list'))
  check('log list finds dsh.log', (logList.files ?? []).some((file) => file.name === 'dsh.log'), JSON.stringify(logList.files))
  const logBody = await jsonOf(await call('/api/logs?file=dsh.log&lines=10'))
  /* A file ending in a newline splits to a trailing empty element; the reader
     keeps it, so compare the meaningful lines. */
  const meaningful = (logBody.lines ?? []).filter((line) => line !== '')
  check('log tail returns lines', meaningful.length === 2, JSON.stringify(logBody.lines))
  const missingLog = await call('/api/logs?file=../../etc/passwd')
  check('log reader refuses an unknown file', missingLog.status === 404, `got ${missingLog.status}`)

  /* --- versions ---------------------------------------------------------- */
  const versions = await jsonOf(await call('/api/versions'))
  check('versions reports a pinned version field', 'current' in versions, JSON.stringify(Object.keys(versions)))
  check('versions lists installed entries', Array.isArray(versions.installed), JSON.stringify(versions.installed))

  /* --- proxy records a visit (the reason the proxy exists) --------------- */
  const proxied = await call('/p/hello', { key: '' })
  check('proxy forwards to dsh', proxied.status === 200, `got ${proxied.status}`)
  check('proxy upstream actually served it', (await proxied.text()).includes('stub:/hello'), 'stub did not see the request')
  check('proxy reached the stub exactly once', stubHits === 1, `stubHits=${stubHits}`)

  /* --- proxy serves REAL HTML through the injection path ------------------
   *
   * `injectManifestCredentials` called `.replace()` on a Buffer (the output of
   * `injectDshHtml`), so every HTML response threw `TypeError: body.replace is
   * not a function` inside a stream 'end' handler. Being unhandled, that became
   * an uncaughtException and the request produced no response at all — the
   * panel's own `uncaughtException` guard logged it and kept the process alive,
   * but the user's page was dead. Nothing caught it because the stub only ever
   * returned text/plain.
   *
   * These assertions therefore matter twice over: they pin the HTML path, and
   * the "panel still alive" one after them pins that a future throw there is a
   * degraded page rather than a dead proxy.
   */
  const htmlProxy = await call('/p/html', { key: '' })
  const injectedHtml = await htmlProxy.text()
  check('proxy serves an HTML page', htmlProxy.status === 200, `got ${htmlProxy.status}`)
  check('proxy injects the manifest crossorigin attribute',
    /<link[^>]*crossorigin="use-credentials"[^>]*rel="manifest"|rel="manifest"[^>]*crossorigin/.test(injectedHtml)
    || (injectedHtml.includes('crossorigin="use-credentials"') && injectedHtml.includes('rel="manifest"')),
    'manifest link was not given crossorigin')
  check('proxy injects the transport privilege shim',
    injectedHtml.includes('__DSH_TRANSPORT__') && injectedHtml.includes('ownsHost'), 'shim missing')
  check('proxy preserves the upstream HTML intact',
    injectedHtml.includes('你好 dsh') && injectedHtml.includes('settings.action'),
    'upstream body was corrupted (UTF-8 or byte offsets)')
  check('proxy does not corrupt non-ASCII HTML',
    injectedHtml.includes('你好'), 'multi-byte characters were mangled by the re-encode')
  check('the panel survives proxying HTML',
    (await call('/api/status')).status === 200, 'panel died proxying HTML')

  const hugeProxy = await call('/p/html-huge', { key: '' })
  const hugeBody = await hugeProxy.text()
  check('proxy passes an oversized HTML page through untruncated',
    hugeBody.length === HUGE_HTML_LENGTH,
    `got ${hugeBody.length} bytes, want ${HUGE_HTML_LENGTH}`)
  check('the panel survives proxying oversized HTML',
    (await call('/api/status')).status === 200, 'panel died proxying 9MB of HTML')

  /* A 302 carrying an HTML body lands in proxyHtml, which must rewrite the
     loopback Location too — otherwise the browser follows it to its own
     127.0.0.1 and comes up blank (the ":28000 opens blank" symptom). */
  const redirect = await call('/p/redirect', { key: '', redirect: 'manual' })
  check('an HTML redirect keeps the browser inside the proxy prefix',
    redirect.headers.get('location') === '/p/login?next=%2F', String(redirect.headers.get('location')))

  /* The JSONL access log is gone (v1.0.40 瘦身): the proxy keeps only the
     most recent visitor in memory, surfaced as /api/status.recentVisit.
     recordVisit() runs synchronously inside the proxy's response handling,
     so it is already set by the time the proxied calls above resolved. */
  const statusAfter = await jsonOf(await call('/api/status'))
  check('proxy recorded the last visitor', Boolean(statusAfter.recentVisit?.ip),
    JSON.stringify(statusAfter.recentVisit))
  check('the old access-log API is gone', (await call('/api/access?limit=5')).status === 404)
  check('the old login-log API is gone', (await call('/api/access/login')).status === 404)

  /* --- diagnostics and settings ----------------------------------------- */
  const diagnostics = await jsonOf(await call('/api/diagnostics'))
  /* Diagnostics entries are keyed by `label`; normalise before asserting so the
     test does not depend on which field the module happens to use. */
  const checkLabels = (diagnostics.checks ?? []).map((entry) => String(entry.label ?? entry.name ?? entry.id ?? ''))
  check('diagnostics returns checks', checkLabels.length > 0, JSON.stringify(diagnostics.summary))
  check('diagnostics flags the missing patch file',
    checkLabels.some((label) => label.includes('patch')),
    JSON.stringify(checkLabels))

  const settings = await jsonOf(await call('/api/settings'))
  check('settings never echoes the key', !JSON.stringify(settings).includes(PASSWORD), JSON.stringify(settings))

  const saved = await jsonOf(await call('/api/settings', {
    method: 'POST',
    body: { access: { trustProxyHeaders: false } },
  }))
  check('settings persist the proxy-header trust toggle', saved.settings?.access?.trustProxyHeaders === false,
    JSON.stringify(saved.settings?.access))

  const onDisk = JSON.parse(readFileSync(join(dataDir, 'console-config.json'), 'utf8'))
  check('settings hit the disk', onDisk.access?.trustProxyHeaders === false, JSON.stringify(onDisk.access))

  /* --- shortcuts page removed (v1.0.40 瘦身) ------------------------------ */
  check('the shortcuts API is gone', (await call('/api/shortcuts')).status === 404)

  /* --- service control is safe to call against the stub ------------------ */
  const stopped = await jsonOf(await call('/api/service/stop', { method: 'POST' }))
  check('stop reports success', stopped.ok === true, JSON.stringify(stopped))

  /* --- patches: auto-applied on dsh start (page removed in v1.0.40) ------
   *
   * The settings host-mode patch edits dsh's own client bundles, so a fake
   * version dir is all it needs. dsh was stopped by the service-control check
   * above; starting it funnels through startDsh(), which now applies the
   * patches automatically — that IS the feature under test. */
  const fakeVersion = '0.0.0-smoke'
  const fakeClient = join(dataDir, 'versions', fakeVersion, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js')
  mkdirSync(join(dataDir, 'versions', fakeVersion), { recursive: true })
  mkdirSync(join(dirname(fakeClient)), { recursive: true })
  writeFileSync(fakeClient, 'window.__ModuleLoader__ = { t: ctx.remote.$host.isLoopback ? "host" : "memory" };\n', 'utf8')

  check('the patch management API is gone', (await call('/api/patches')).status === 404)

  /* The smoke env has no installed dsh (the proxy target is a stub), so the
     start itself answers dsh-not-installed — what matters here is that the
     attempt ran the auto-patch before bailing out. */
  const started = await jsonOf(await call('/api/service/start', { method: 'POST' }))
  check('start answers with a structured result', typeof started?.ok === 'boolean', JSON.stringify(started).slice(0, 200))
  const patchedText = readFileSync(fakeClient, 'utf8')
  check('the ternary is gone from the bundle', !/isLoopback \? "host" : "memory"/.test(patchedText), patchedText.slice(0, 120))
  check('the bundle carries the marker comment', patchedText.startsWith('/* dsh-console: settings host-mode patch */'),
    patchedText.slice(0, 60))

  /* Starting again must not patch twice: the marker is idempotent. */
  await call('/api/service/start', { method: 'POST' })
  const repatched = readFileSync(fakeClient, 'utf8')
  check('re-starting is a no-op, not a double patch',
    (repatched.match(/dsh-console: settings host-mode patch/g) ?? []).length === 1,
    `marker count=${(repatched.match(/dsh-console: settings host-mode patch/g) ?? []).length}`)

  /* --- the WS proxy: one handshake header per name ------------------------
   *
   * In 1.0.29/1.0.30 `proxyUpgradeToDsh` rebuilt `Connection: Upgrade` /
   * `Upgrade: websocket` on top of the lowercase copies Node had already parsed
   * out of the upstream 101, so each name appeared twice. HTTP header names are
   * case-insensitive, but a browser treats a duplicated `Connection` as a
   * malformed handshake: the panel logged 101, the browser dropped the socket and
   * the UI looped on `connection lost, retry #1..#4`. The access log was all
   * green the whole time, which is exactly why it went unnoticed.
   */
  const mux = await rawUpgrade({ host: `127.0.0.1:${PANEL_PORT}`, path: '/p/api/remote.mux' })
  check('the WS proxy completes the handshake', /^HTTP\/1\.1 101 /.test(mux.head), mux.head.split('\r\n')[0] ?? '(empty)')
  for (const name of ['connection', 'upgrade', 'sec-websocket-protocol']) {
    const count = (mux.head.match(new RegExp(`^${name}:`, 'gmi')) ?? []).length
    check(`the 101 carries ${name} exactly once`, count === 1, `count=${count} head=${mux.head.replace(/\r\n/g, ' | ')}`)
  }
  check('the 101 keeps the upstream subprotocol', /sec-websocket-protocol: typert-mux/i.test(mux.head),
    mux.head.replace(/\r\n/g, ' | '))
  check('the 101 keeps the upstream accept key', /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZbK\+xOoo=/i.test(mux.head),
    mux.head.replace(/\r\n/g, ' | '))
  check('the tunnel carries upstream frames back', mux.tail.includes('hi'), `tail=${JSON.stringify(mux.tail)}`)
  check('the panel survives the proxied handshake', (await call('/api/status')).status === 200)

  /* An upstream that refuses the upgrade must not be dressed up as success. */
  const refused = await rawUpgrade({ host: `127.0.0.1:${PANEL_PORT}`, path: '/p/nope' })
  check('a refused upgrade is not reported as 101', !/^HTTP\/1\.1 101 /.test(refused.head), refused.head.split('\r\n')[0] ?? '(empty)')

  /* --- the gateway proxy: a 101 must keep Connection, not drop it ---------
   *
   * proxy.py dropped `connection` as hop-by-hop on every response and only
   * re-sent `Connection: Upgrade` upstream — never back to the client. The
   * browser therefore saw a 101 carrying `Upgrade` alone, rejected the
   * handshake, and dropped the socket while the panel logged a clean 101.
   * The fnOS 统一网关 is documented to support WebSocket, so this hop has to
   * hand a valid 101 back on its own.
   */
  /* Some images only ship `python3`; pick whichever this platform actually has. */
async function pythonBin() {
  for (const candidate of ['python3', 'python']) {
    const found = await new Promise((resolve) => {
      const probe = spawn(candidate, ['-c', 'import sys;sys.exit(0)'], { stdio: 'ignore' })
      probe.on('error', () => resolve(false))
      probe.on('close', (code) => resolve(code === 0))
    })
    if (found) return candidate
  }
  return null
}

/* The gateway hop needs a real AF_UNIX socket; where the interpreter has no
   * AF_UNIX (some Windows builds) there is nothing to bind, so skip rather than
   * report a false failure. CI runs Linux and does cover this. */
  let hasUnixSocket = true
  const python = await pythonBin()
  if (!python) {
    hasUnixSocket = false
  } else if (await new Promise((resolve) => {
    const probe = spawn(python, ['-c', 'import socket,sys;sys.exit(0 if hasattr(socket,"AF_UNIX") else 1)'], { stdio: 'ignore' })
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  }) !== true) {
    hasUnixSocket = false
  }

  if (!hasUnixSocket) {
    console.log('  ~ skipped 6 gateway checks (no python with AF_UNIX on this platform)')
  } else {
  const gatewaySock = join(sandbox, 'gateway.sock')
  const gateway = spawn(python, [join(ROOT, 'cmd', 'proxy.py')], {
    env: {
      ...process.env,
      CONSOLE_PORT: String(PANEL_PORT),
      SOCK_PATH: gatewaySock,
      GATEWAY_PREFIX: '/app/gw',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let gatewayOutput = ''
  gateway.stdout.on('data', (chunk) => { gatewayOutput += chunk })
  gateway.stderr.on('data', (chunk) => { gatewayOutput += chunk })

  try {
    if (!(await waitFor(() => existsSync(gatewaySock), { description: 'gateway socket' }))) {
        console.error('proxy.py did not bind its socket')
        console.error(gatewayOutput.slice(-4000))
        check('the gateway proxy starts and binds its socket', false, 'no socket appeared')
      } else {
        const gw = await rawUpgradeUnix({
          socketPath: gatewaySock,
          host: 'gw.local',
          path: '/app/gw/p/api/remote.mux',
        })
        check('the gateway proxy completes the handshake', /^HTTP\/1\.1 101 /.test(gw.head), gw.head.split('\r\n')[0] ?? '(empty)')
        for (const name of ['connection', 'upgrade']) {
          const count = (gw.head.match(new RegExp(`^${name}:`, 'gmi')) ?? []).length
          check(`the gateway 101 carries ${name} exactly once`, count === 1, `count=${count} head=${gw.head.replace(/\r\n/g, ' | ')}`)
        }
        check('the gateway 101 keeps the subprotocol', /sec-websocket-protocol: typert-mux/i.test(gw.head),
          gw.head.replace(/\r\n/g, ' | '))
        check('the gateway tunnel carries upstream frames back', gw.tail.includes('hi'), `tail=${JSON.stringify(gw.tail)}`)
      }
    } finally {
      gateway.kill()
    }
  }

  /* --- unknown endpoints ------------------------------------------------ */
  const bogus = await call('/api/does-not-exist')
  check('unknown endpoint is 404', bogus.status === 404, `got ${bogus.status}`)

  /* --- static UI --------------------------------------------------------- */
  const html = await fetch(`${base}/`)
  check('the UI index is served', html.status === 200, `got ${html.status}`)
  const htmlBody = await html.text()
  check('UI uses relative asset paths (gateway prefix safe)',
    htmlBody.includes('assets/app.js') && !htmlBody.includes('"/assets/'), 'absolute /assets/ path found')

  /* The shell must NOT carry `hidden`.
   *
   * It used to, and nothing ever removed it. That is visually inert (`.shell
   * { display: flex }` outranks the UA's `[hidden] { display: none }`), so the
   * page looked fine — which is why it survived review. But `element.hidden`
   * stayed `true`, and both live-update paths in app.js test it, so the 15s poll
   * and every WebSocket push were discarded. Symptom: "实时刷新无效，要手动刷新".
   *
   * Asserted on the served HTML because that is what the browser parses.
   */
  const shellTag = /<div[^>]*\bid="app"[^>]*>/.exec(htmlBody)?.[0] ?? ''
  check('the app shell is not left hidden', !/\shidden[\s>]/.test(shellTag),
    `#app still carries the hidden attribute: ${shellTag}`)

  // And the JS must not gate updates on that attribute either.
  const appJsText = await (await fetch(`${base}/assets/app.js`)).text()
  check('live updates do not depend on a hidden attribute',
    !/app\.hidden|\bapp\s*\.\s*hidden\b/.test(appJsText),
    'app.js still reads app.hidden — live updates would be silently dropped')
  check('live updates use the real visibility signal',
    appJsText.includes('visibilityState'), 'app.js does not consult document.visibilityState')

  /* `onLeave` lives on `ctx`, not on `state`. A stray `state.onLeave(...)` threw
   * a TypeError on the line right before `boot()`, so the shell rendered but no
   * API call was ever made — "打开没数据，要手动刷新". The page looked alive
   * because the HTML is static, which is why it went unnoticed.
   */
  check('app.js does not call onLeave on the wrong object',
    !/\bstate\.onLeave\b/.test(appJsText),
    'app.js calls state.onLeave — it throws before boot() runs')
  check('the push channel is closed on unload',
    /addEventListener\('beforeunload',\s*closeWs\)/.test(appJsText),
    'app.js no longer wires beforeunload -> closeWs')
  const script = await fetch(`${base}/assets/app.js`)
  check('the UI bundle is served', script.status === 200, `got ${script.status}`)

  /* --- the usage poller must be cancelable from the moment it is created ---
   *
   * renderTab() drains the previous leavers and then `await`s the view. The
   * overview view used to `await` its first /api/usage sample and only then
   * register the clearInterval cleanup, so a push event arriving inside that
   * window (WS status/visit/access all call renderTab) dropped the cleanup on
   * the floor. Every miss leaked one 3s timer forever and /api/usage grew
   * exponentially — measured at 20-29 requests/second against a designed 1/3s.
   */
  const overviewJs = await (await fetch(`${base}/assets/views/overview.js`)).text()
  const usageAnchor = overviewJs.indexOf('startUsageTimer(host)')
  check('the overview view creates its usage timer synchronously',
    usageAnchor !== -1, 'overview.js no longer uses startUsageTimer(host)')
  const beforeAwait = (() => {
    const decl = overviewJs.indexOf('function startUsageTimer(')
    if (decl === -1 || usageAnchor === -1) return false
    // The factory must be synchronous: an `await` inside it would reopen the
    // very window this fix closes.
    const body = overviewJs.slice(decl, overviewJs.indexOf('\n}', decl))
    if (/\basync\b[^\n]*function startUsageTimer/.test(overviewJs)) return false
    if (/await\s+draw\(\)/.test(body)) return false
    // Registration must sit immediately after the factory call.
    const at = overviewJs.indexOf("ctx.onLeave(() => { cleanupUsage() })")
    const between = overviewJs.slice(usageAnchor, at === -1 ? usageAnchor : at)
    return at !== -1 && !/await/.test(between) && !/\bdraw\(/.test(between)
  })()
  check('the usage cleanup is registered before any await',
    beforeAwait, 'overview.js registers ctx.onLeave after an await — a concurrent re-render can leak the timer')
  check('the usage cleanup also guards writes after the request',
    /let stopped = false/.test(overviewJs) && /if \(stopped\) return/.test(overviewJs),
    'overview.js has no stopped guard — a late response can write into a torn-down view')

  /* The second half of the fix: serialise renderTab() itself. Even with a
   * synchronously-created timer, two overlapping renders would still each
   * register a cleanup while only the last one gets drained. */
  check('renderTab is serialised through a queue',
    /let renderQueue = Promise\.resolve\(\)[\s\S]*?renderQueue\.then\(runRenderTab/.test(appJsText),
    'app.js still re-enters renderTab concurrently — a view can register two cleanups')
  check('the render queue drains leavers inside the serialised body',
    /async function runRenderTab\(\)[\s\S]{0,200}leavers\.splice/.test(appJsText),
    'app.js drains leavers outside the queued body')
  const traversal = await fetch(`${base}/assets/../../cmd/dashboard.js`)
  check('static server refuses traversal', traversal.status === 404, `got ${traversal.status}`)

  /* --- diagnostics shape ------------------------------------------------ */
  /* The UI renders `c.label`; an earlier API returned `name`, so the whole
     first column of the Diagnostics table came out blank. Assert the field the
     UI actually reads, so the two cannot drift apart again. */
  const diag = await jsonOf(await call('/api/diagnostics'))
  const diagChecks = diag.checks ?? []
  check('diagnostics returns checks', diagChecks.length > 0, 'empty checks')
  check('every diagnostic has a label the UI can render',
    diagChecks.every((c) => typeof c.label === 'string' && c.label.length > 0),
    JSON.stringify(diagChecks.map((c) => c.label)))
  check('every diagnostic has a valid status',
    diagChecks.every((c) => ['pass', 'warn', 'fail'].includes(c.status)),
    JSON.stringify(diagChecks.map((c) => c.status)))

  /* --- the panel reports its OWN version, not a placeholder ---------------
   *
   * `manifestInfo().version` falls back to '0.0.0' when the manifest cannot be
   * read, and the header showed a bare "v0.0.0" with no explanation. The cause
   * was a path mismatch: the panel defaults MANIFEST to
   * `/var/apps/{appname}/manifest`, but on fnOS that directory is only a
   * symlink — the manifest itself lives under TRIM_APPDEST
   * (`/vol{n}/@appcenter/{appname}`), which `cmd/main` passes but never exports
   * as MANIFEST. Verified against the real layout:
   *   default path -> readFileSync ENOENT -> {} -> "0.0.0"
   *   TRIM_APPDEST path -> version parsed correctly
   */
  const versioned = await jsonOf(await call('/api/status'))
  check('the panel reports a real version, not 0.0.0',
    versioned.panel?.version && versioned.panel.version !== '0.0.0',
    `panel.version=${JSON.stringify(versioned.panel?.version)} — manifest not read?`)
  const manifestText = readFileSync(join(ROOT, 'manifest'), 'utf8')
  const declared = /^version=(.+)$/m.exec(manifestText)?.[1]?.trim()
  check('the reported version matches the shipped manifest',
    declared && versioned.panel.version === declared,
    `manifest says ${JSON.stringify(declared)}, API said ${JSON.stringify(versioned.panel.version)}`)

  /* --- WebSocket push channel --------------------------------------------
   *
   * These are the assertions whose absence let a fatal bug ship: the /ws
   * handshake used `crypto.createHash`, which throws on Node (the global
   * `crypto` is WebCrypto and has no createHash). Because the throw happened
   * inside the server's `upgrade` event with no try/catch, it killed the panel
   * process — and `ui/assets/app.js` opens /ws unconditionally on load, so
   * merely opening the panel killed it. `node --check` cannot see that (the
   * file is in SYNTAX_ONLY, and the code is syntactically valid), and no test
   * touched /ws, so CI stayed green.
   *
   * So: assert the handshake really completes, and assert the panel is STILL
   * ALIVE afterwards. The liveness half is the one that matters.
   */
  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws`)
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    check('the /ws handshake completes', opened, 'no 101 within 5s')

    // An RFC6455 server must complete the handshake and keep the socket open.
    check('the /ws socket stays open after the handshake', ws.readyState === 1, `readyState=${ws.readyState}`)

    // A second, concurrent socket must also be served (the client reconnects
    // on a timer, so more than one panel tab is normal).
    const second = await new Promise((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws`)
      const timer = setTimeout(() => resolve(false), 5000)
      s.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
      s.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    check('a second /ws socket is accepted', second, 'second handshake failed')
    ws?.close()
  } catch (error) {
    check('the /ws handshake completes', false, String(error?.message ?? error))
  }

  // The decisive assertion: the panel must still be serving after /ws traffic.
  // Before the fix this returned nothing at all — the process was gone.
  const alive = await call('/api/status').catch((error) => ({ status: `dead: ${error.message}` }))
  check('the panel SURVIVES the /ws handshake', alive.status === 200, `got ${alive.status}`)
  check('the panel survives a second request too', (await call('/api/status')).status === 200)

  // A garbage /ws request must be refused without taking the panel with it.
  // Raw-socket rather than fetch(): fetch() refuses to speak an upgrade, so it
  // would only prove that the client gave up, not that the server coped.
  const garbageStatus = await new Promise((resolve) => {
    const socket = connect(PANEL_PORT, '127.0.0.1', () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PANEL_PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    const finish = (value) => { try { socket.destroy() } catch { /* ignore */ } resolve(value) }
    socket.on('data', (chunk) => {
      const line = String(chunk).split('\r\n')[0] ?? ''
      const code = Number(/HTTP\/1\.1 (\d{3})/.exec(line)?.[1] ?? 0)
      finish(code || 'no-status-line')
    })
    socket.on('error', () => finish('threw'))
    setTimeout(() => finish('timeout'), 3000)
  })
  check('a malformed /ws handshake is answered, not fatal', /^4|^5/.test(String(garbageStatus)), `got ${garbageStatus}`)
  check('the panel survives a bad /ws request', (await call('/api/status')).status === 200)

  /* --- the panel's server→client WS frames must never carry the mask bit ---
   *
   * RFC6455 §5.1: a client MUST mask, a server MUST NOT. The ping/pong/close
   * frames used to be written as `[0x89, 0x80, 0,0,0,0]` — the `0x80` is the
   * mask bit, so the browser rejected every one of them with "A server must not
   * mask any frames that it sends to the client" and dropped the /ws push
   * channel. The undici WebSocket client above never sends pings, so the
   * handshake assertions stayed green while real browsers failed. Assert the
   * frame bytes directly so this cannot regress.
   */
  const serverJsText = readFileSync(join(ROOT, 'cmd', 'dashboard-server.js'), 'utf8')
  check('server→client control frames are unmasked',
    !/\[0x8[89a],\s*0x80\]/.test(serverJsText) && !/0x8[89a],\s*0x80,/.test(serverJsText),
    'dashboard-server.js still emits a masked ping/pong/close frame')
  check('server→client text frames are unmasked (0x81)',
    /0x81/.test(serverJsText), 'encodeWsText lost its unmasked text opcode')

  /* --- config parsing resilience -----------------------------------------
   * The installer used to write a `//`-commented console-config.json, which
   * JSON.parse rejects; loadConfig swallowed the error and fell back to
   * DEFAULTS, so every install-time setting silently vanished.
   *
   * Note: this is asserted in-process, in a child that imports
   * dashboard-config.js fresh. Rewriting the file under the running panel would
   * NOT exercise the fix — loadConfig memoises for the process lifetime by
   * design, and a restart is the only thing that re-reads it. That is also
   * precisely why the original failure was so confusing: the settings had to
   * survive a panel restart to come back, and nothing said so.
   */
  const commentProbe = mkdtempSync(join(tmpdir(), 'fnos-dsh-manager-cfg-'))
  const commentDir = join(commentProbe, 'data')
  mkdirSync(commentDir, { recursive: true })
  writeFileSync(join(commentDir, 'console-config.json'),
    '{\n  // an operator left this behind\n  "versions": { "keep": 7 },\n}\n', 'utf8')
  // A tiny child that imports the panel's own loader with DATA_DIR pointed at
  // the comment-bearing config — the real code path, not a reimplementation.
  const probeScript = `
    process.env.DATA_DIR = ${JSON.stringify(commentDir)}
    const url = require('url').pathToFileURL(${JSON.stringify(join(ROOT, 'cmd', 'dashboard-config.js'))}).href
    import(url).then((m) => {
      const c = m.loadConfig()
      process.stdout.write(JSON.stringify({ keep: c.versions.keep, err: c.__parseError ?? '' }))
    }).catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e && e.message) })) })
  `
  const probeOut = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', probeScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', () => { /* keep quiet; stdout carries the verdict */ })
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(''))
  })
  let probed = {}
  try { probed = JSON.parse(probeOut || '{}') } catch { probed = {} }
  check('a commented config does not fall back to defaults', probed.keep === 7, `keep=${probed.keep} (want 7) ${probed.fatal ?? ''}${probeOut && !probed.keep ? ` raw=${probeOut.slice(0, 120)}` : ''}`)
  check('a commented config reports no parse error', probed.err === '', `err=${probed.err}`)
  rmSync(commentProbe, { recursive: true, force: true })
  check('the panel is unaffected by the config probe', (await call('/api/status')).status === 200)

  /* --- regression guards for the audited fixes ----------------------------
   *
   * Run in a child process with its own throwaway DATA_DIR, so they can import
   * the real modules without ever touching a live install. Each one pins a bug
   * that was found by reading the code rather than by watching it fail, which
   * is exactly the kind that silently comes back.
   */
  const guardDir = join(sandbox, 'guard')
  mkdirSync(guardDir, { recursive: true })
  const guardScript = `
    process.env.DATA_DIR = ${JSON.stringify(guardDir)}
    process.env.DSH_HOME = ${JSON.stringify(join(guardDir, 'dsh_home'))}
    const load = (p) => import(require('url').pathToFileURL(${JSON.stringify(ROOT)} + '/cmd/' + p).href)
    Promise.all([
      load('dashboard-plugins.js'),
      load('dashboard-config.js'),
      load('dashboard-resources.js'),
      load('dashboard-session.js'),
      load('dashboard-server.js'),
    ])
      .then(([plugins, config, resources, session, server]) => {
        const out = {
          validName: plugins.isValidPackageName('dshmarket'),
          scopedName: plugins.isValidPackageName('@deepseek-ai/dsh'),
          traversalRejected: !plugins.isValidPackageName('../../../../../../etc'),
        }
        // removeBundle 后面是 rmSync(dir, { recursive: true, force: true })；
        // 路径穿越的名字必须在碰到文件系统之前就被拒。
        return plugins.removeBundle('../../../../../../etc').then((r) => {
          out.removeRejected = r.ok === false && r.error === 'invalid-package-name'

          // 行缓冲上限：截断必须发生在"拆完行"之后。先喂一条含 token 的完整行，
          // 再喂一段 128KB 不含换行的垃圾 —— token 必须仍然被捕获到，否则反代
          // 会持续 401。
          session.CaptureLaunchToken('dsh web: http://127.0.0.1:28000/?token=abc123\\n')
          out.tokenAfterHugeNoise = session.GetCurrentLaunchToken() === 'abc123'
          session.CaptureLaunchToken('x'.repeat(128 * 1024))
          out.bufferBounded = true // 能走到这里就说明没有 OOM/抛错

          // ---- 会话代持持久化（v1.0.41）----
          // 面板重启（fnOS 每次升级都会）若把 token/cookie 冲掉，而 dsh 还活着，
          // 反代就没有凭据：HTTP 401、前端 WS 等满 60 秒超时。凭据必须落盘。
          const sessionFile = require('path').join(process.env.DATA_DIR, 'dsh-session.json')
          const persisted = JSON.parse(require('fs').readFileSync(sessionFile, 'utf8'))
          out.tokenPersisted = persisted.token === 'abc123'

          // ---- 启动地址（v1.0.42）----
          // 首页要展示 dsh 启动打印的那条地址：只留 token 就只能拼出一个"大概是
          // 这个"的 URL，端口/主机一变就指错地方，所以整条 URL 一起捕获并落盘。
          out.launchUrlCaptured = session.GetLaunchUrl() === 'http://127.0.0.1:28000/?token=abc123'
          out.launchUrlPersisted = persisted.url === 'http://127.0.0.1:28000/?token=abc123'
          // 那条地址的主机是 dsh 自己的回环，照着点会连到浏览器所在机器：面板
          // 必须把它改写成"当前域名下的代理路径"，且不能重复加前缀（/p/p/）。
          out.entryRewritten = server.stripLoopbackLocation('http://127.0.0.1:28000/?token=abc123', '/p') === '/p/?token=abc123'
          out.entryKeepsPrefix = server.stripLoopbackLocation('http://127.0.0.1:28000/p/login', '/p') === '/p/login'
          out.entryLeavesForeignHost = server.stripLoopbackLocation('http://nas.local/login', '/p') === 'http://nas.local/login'
          // 面板手里没凭据时绝不能剥掉浏览器自己的那份（否则 100% 401）。
          out.cookiePassthrough = session.appendDshSessionCookie('dsh-auth-a=1; foo=2', '') === 'dsh-auth-a=1; foo=2'
          // 有凭据时才替换，且旧的 dsh-auth-* 必须被剥离，不能两份并存。
          out.cookieReplaced = session.appendDshSessionCookie('dsh-auth-a=1; foo=2', 'dsh-auth-b=9') === 'foo=2; dsh-auth-b=9'

          // 停/重启 dsh 传的是空 token：旧地址必须一起清掉，否则首页会一直
          // 展示一条已经失效的 token。
          session.SetCurrentLaunchToken('')
          out.launchUrlCleared = session.GetLaunchUrl() === ''

          // 校验与写入必须同一个名字：入参带空格时若写入原始值，package.json 里
          // 会留下一个和 npm 实际装的包对不上的条目。
          return plugins.setBundleEnabled('  dshmarket  ', true).then((r2) => {
            out.trimmedWrite = r2.ok === true && r2.name === 'dshmarket'
            const pkg = JSON.parse(require('fs').readFileSync(plugins.profilePackagePath(), 'utf8'))
            out.bundleRecorded = (pkg.dsh?.profile?.bundles ?? []).includes('dshmarket')

            const list = ['0.2.1', '0.2.1-rc.1', '0.2.1-alpha.2']
            out.order = [...list].sort(config.compareVersions).reverse().join(',')
            const t0 = Date.now()
            const res = resources.readResources()
            out.diskMs = Date.now() - t0
            out.diskTotal = (res.disks[0] || {}).total || 0

            // ---- config home 兜底（v1.0.39）----
            // workspace.active 指向版本 home，而凭据只写在默认 home（历史版本
            // 留下的）时，路径必须兜底回默认 home —— 否则升级后表现为"配置全丢"
            // （1.0.37 的行为）。active home 也有一份时必须以 active 为准，那才是
            // dsh 启动参数 HOME/DSH_HOME/USERPROFILE 指向的位置（1.0.38 的正确行为）。
            const fs = require('fs')
            const join = require('path').join
            const defaultHome = process.env.DSH_HOME
            const versionHome = join(process.env.DATA_DIR, 'versions', '9.9.9', 'home')
            fs.mkdirSync(versionHome, { recursive: true })
            fs.mkdirSync(defaultHome, { recursive: true })
            fs.writeFileSync(join(defaultHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: x\\n')
            fs.writeFileSync(join(process.env.DATA_DIR, 'workspace.active'), versionHome + '\\n')
            out.credFallsBackToDefault = config.credentialsPath() === join(defaultHome, '.credentials.yaml')
            fs.writeFileSync(join(versionHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: y\\n')
            out.credPrefersActive = config.credentialsPath() === join(versionHome, '.credentials.yaml')
            out.proxyConfDefaultsToActive = config.proxyConfPath() === join(versionHome, 'proxy.conf')
            // 受信主机只存在于默认 home 时，写入必须落到默认 home（与 1.0.37 一致），
            // 且不能在 active home 里留下第二份。
            fs.writeFileSync(join(defaultHome, 'trusted_hosts.conf'), 'a.example.com\\n')
            config.writeTrustedHosts(['b.example.com'])
            out.trustedWriteFollowsFallback =
              fs.readFileSync(join(defaultHome, 'trusted_hosts.conf'), 'utf8').trim() === 'b.example.com' &&
              !fs.existsSync(join(versionHome, 'trusted_hosts.conf'))
            fs.unlinkSync(join(process.env.DATA_DIR, 'workspace.active'))
            process.stdout.write(JSON.stringify(out))
          })
        })
      })
      .catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e && e.message) })) })
  `
  const guardOut = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', guardScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', () => { /* keep quiet; stdout carries the verdict */ })
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(''))
  })
  let guard = {}
  try { guard = JSON.parse(guardOut || '{}') } catch { guard = {} }

  check('a normal package name is accepted', guard.validName === true && guard.scopedName === true, JSON.stringify(guard))
  check('a traversal package name is rejected', guard.traversalRejected === true, JSON.stringify(guard))
  check('removeBundle refuses traversal before any recursive delete',
    guard.removeRejected === true, JSON.stringify(guard))
  check('the launch-token line survives a huge newline-free burst',
    guard.tokenAfterHugeNoise === true, `token=${guard.tokenAfterHugeNoise}`)
  check('bundle enable/disable records the trimmed package name',
    guard.trimmedWrite === true && guard.bundleRecorded === true, JSON.stringify(guard))
  check('version sorting puts a release above its own prerelease',
    guard.order === '0.2.1,0.2.1-rc.1,0.2.1-alpha.2', `got ${guard.order}`)
  check('the resource sampler answers without forking a subprocess',
    guard.diskTotal > 0 && guard.diskMs < 1000, `total=${guard.diskTotal} in ${guard.diskMs}ms ${guard.fatal ?? ''}`)
  check('config paths fall back to the default home when the active one lacks the file',
    guard.credFallsBackToDefault === true, JSON.stringify(guard))
  check('config paths prefer the active home when it has the file',
    guard.credPrefersActive === true, JSON.stringify(guard))
  check('a file in neither home resolves to the active home',
    guard.proxyConfDefaultsToActive === true, JSON.stringify(guard))
  check('trusted-host writes follow the fallback path',
    guard.trustedWriteFollowsFallback === true, JSON.stringify(guard))
  check('the launch token survives a panel restart (persisted to disk)',
    guard.tokenPersisted === true, JSON.stringify(guard))
  check('the browser cookie is passed through when the panel holds none',
    guard.cookiePassthrough === true, JSON.stringify(guard))
  check('the panel cookie replaces instead of joining the browser one',
    guard.cookieReplaced === true, JSON.stringify(guard))
  check('the launch URL is captured whole, not just the token',
    guard.launchUrlCaptured === true, JSON.stringify(guard))
  check('the launch URL is persisted alongside the token',
    guard.launchUrlPersisted === true, JSON.stringify(guard))
  check('the launch URL is rewritten into a proxy path under the panel',
    guard.entryRewritten === true, JSON.stringify(guard))
  check('an already-prefixed redirect does not get the prefix twice',
    guard.entryKeepsPrefix === true, JSON.stringify(guard))
  check('a foreign host is left alone',
    guard.entryLeavesForeignHost === true, JSON.stringify(guard))
  check('stopping dsh clears the stale launch URL',
    guard.launchUrlCleared === true, JSON.stringify(guard))
} finally {
  panel.kill('SIGTERM')
  stub.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (!panel.killed) panel.kill('SIGKILL')
  if (process.env.KEEP_SMOKE_SANDBOX) {
    console.log(`sandbox kept at ${sandbox}`)
  } else {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log('panel output tail:')
  console.log(panelOutput.split('\n').slice(-25).join('\n'))
  process.exit(1)
}
