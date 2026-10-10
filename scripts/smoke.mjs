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
let stubHits = 0
const stub = createServer((request, response) => {
  stubHits += 1
  const url = request.url ?? '/'
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
function call(path, { method = 'GET', key = PASSWORD, headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } }
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
  check('status exposes an access-log summary', typeof status.access?.lines === 'number', JSON.stringify(status.access))
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
  const before = await jsonOf(await call('/api/access?limit=5'))
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

  /* Records are queued and flushed on a timer (see dashboard-access.js), so a
     read taken immediately after the request can still be empty. Poll instead
     of asserting instantaneously — that is the real contract. */
  const after = await waitFor(
    async () => {
      const body = await jsonOf(await call('/api/access?limit=5'))
      return (body.stats?.lines ?? 0) > (before.stats?.lines ?? 0) ? body : null
    },
    { timeoutMs: 4000, description: 'access record to appear' },
  )
  check('proxy recorded the visit', after !== null,
    `${before.stats?.lines} -> ${after?.stats?.lines ?? 'unchanged'}`)
  /* Order-independent: the HTML-injection assertions above make their own proxied
     request, so `/html` may be the newest entry. Look for OUR request by path
     rather than assuming position 0. */
  const entries = after?.entries ?? []
  const hello = entries.find((entry) => entry.path === '/hello')
  check('recorded entry carries method and path', hello?.method === 'GET', JSON.stringify(entries.slice(0, 3)))

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
    body: { shortcuts: [{ label: 'Docs', url: 'https://example.com/docs' }], access: { max: 42 } },
  }))
  check('settings persist shortcuts', saved.settings?.shortcuts?.[0]?.label === 'Docs', JSON.stringify(saved.settings?.shortcuts))
  check('settings persist the access cap', saved.settings?.access?.max === 42, String(saved.settings?.access?.max))

  const onDisk = JSON.parse(readFileSync(join(dataDir, 'console-config.json'), 'utf8'))
  check('settings hit the disk', onDisk.access?.max === 42, JSON.stringify(onDisk.access))

  /* --- shortcuts --------------------------------------------------------- */
  const shortcuts = await jsonOf(await call('/api/shortcuts'))
  check('shortcuts include a loopback entry', (shortcuts.entries ?? []).some((entry) => entry.url.includes('127.0.0.1')),
    JSON.stringify(shortcuts.entries))
  check('shortcuts include the pinned ones', (shortcuts.custom ?? []).some((entry) => entry.label === 'Docs'),
    JSON.stringify(shortcuts.custom))

  /* --- service control is safe to call against the stub ------------------ */
  const stopped = await jsonOf(await call('/api/service/stop', { method: 'POST' }))
  check('stop reports success', stopped.ok === true, JSON.stringify(stopped))

  /* --- patches ----------------------------------------------------------- */
  /* The settings host-mode patch edits dsh's own client bundles, so a fake
     version dir is all it needs: the module scans `${VERSIONS_DIR}` by name and
     never imports anything from the version. */
  const fakeVersion = '0.0.0-smoke'
  const fakeClient = join(dataDir, 'versions', fakeVersion, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings', 'lib', 'client.js')
  mkdirSync(join(dataDir, 'versions', fakeVersion), { recursive: true })
  mkdirSync(join(dirname(fakeClient)), { recursive: true })
  writeFileSync(fakeClient, 'window.__ModuleLoader__ = { t: ctx.remote.$host.isLoopback ? "host" : "memory" };\n', 'utf8')

  const patchStateBefore = await jsonOf(await call('/api/patches'))
  check('patches report an install before the fix', (patchStateBefore.versions ?? [])
    .flatMap((v) => v.files).some((f) => f.state === 'pending'), JSON.stringify(patchStateBefore))

  const applied = await jsonOf(await call('/api/patches/apply', { method: 'POST' }))
  check('patch apply reports success', applied.ok === true, JSON.stringify(applied).slice(0, 200))
  check('patch apply reports it changed a file', (applied.versions ?? [])
    .flatMap((v) => v.files).some((f) => f.state === 'patched'), JSON.stringify(applied).slice(0, 200))
  const patchedText = readFileSync(fakeClient, 'utf8')
  check('the ternary is gone from the bundle', !/isLoopback \? "host" : "memory"/.test(patchedText), patchedText.slice(0, 120))
  check('the bundle carries the marker comment', patchedText.startsWith('/* dsh-console: settings host-mode patch */'),
    patchedText.slice(0, 60))

  const appliedAgain = await jsonOf(await call('/api/patches/apply', { method: 'POST' }))
  check('re-applying is a no-op, not a double patch', (appliedAgain.versions ?? [])
    .flatMap((v) => v.files).filter((f) => f.state === 'patched').length === 0,
    JSON.stringify(appliedAgain).slice(0, 200))

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
  const script = await fetch(`${base}/assets/app.js`)
  check('the UI bundle is served', script.status === 200, `got ${script.status}`)
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
