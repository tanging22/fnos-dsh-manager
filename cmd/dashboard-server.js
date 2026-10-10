/**
 * The panel's HTTP surface: its own REST API, its static UI, and a reverse
 * proxy in front of dsh that doubles as the visitor recorder.
 *
 * Why a proxy at all: dsh keeps no access records, so "who visited recently"
 * has to be observed somewhere. Routing the entry through here means every hit
 * is attributable while adding nothing to dsh itself. See dashboard-access.js.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, normalize, extname } from 'node:path'

import { cleanLine, lanAddresses, localHost, nowIso, LAN_PROXY_PORT } from './dashboard-utils.js'
import {
  CONSOLE_PORT,
  DATA_DIR,
  applyLanBinding,
  preferredPatchHost,
  saveConfig,
  loadConfig,
  logFiles,
  manifestInfo,
  proxyUrl,
  webserverHost,
  activeDshVersion,
  effectiveMode,
  writeTrustedHosts,
} from './dashboard-config.js'
import { dshStatus, listenPort, restartDsh, startDsh, stopDsh, PID_FILE, DSH_LOG } from './dashboard-process.js'
import { GetCachedUsage, SubscribeUsage } from './dashboard-usage.js'
import { SubscribeState, snapshot as stateSnapshot, GetStatus } from './dashboard-state.js'
import {
  currentVersion,
  installVersion,
  switchVersion,
  versionState,
  pruneVersions,
  removeVersion,
} from './dashboard-versions.js'
import { accessLogStats, clearVisitors, recordVisit, recentVisitors, recentLogins } from './dashboard-access.js'
import { isTrustedRequest, clientIp, requestHost } from './dashboard-trust.js'
import { runDiagnostics } from './dashboard-diagnostics.js'
import { environmentState, repairEnvironment } from './dashboard-env.js'
import { workspaceState, listDirectory } from './dashboard-workspace.js'
import { readResources } from './dashboard-resources.js'
import {
  pluginState,
  inspectPackage,
  installBundle,
  removeBundle,
  setBundleEnabled,
  setPluginEnabled,
  MARKET_PACKAGE,
} from './dashboard-plugins.js'
import { GetDshSessionCookie, appendDshSessionCookie } from './dashboard-session.js'

const UI_DIR = process.env.CONSOLE_UI
  ? join(process.env.CONSOLE_UI)
  : fileURLToPath(new URL('../ui', import.meta.url))

/** One in-flight install at a time; `null` when idle. */
let installJob = null

/** One in-flight plugin install at a time; `null` when idle. */
let pluginJob = null

/**
 * Connected WebSocket clients (raw sockets upgraded via `/ws`). Every client
 * receives the same push events, so status/log/access changes reach all open
 * panels without polling. Kept as plain sockets so no third-party ws lib is
 * needed — we speak the minimal RFC6455 handshake + unmasked text frames only.
 */
const wsClients = new Set()

/** Guards the process-wide state/usage subscriptions (see createConsoleServer). */
let subscribersRegistered = false

/**
 * Push a JSON event to every connected WebSocket client.
 *
 * Never throws: a dead socket must not take the request that triggered the
 * broadcast down with it. Slow clients are dropped rather than buffered —
 * `socket.write` returning false means the kernel buffer is full, and letting
 * an idle browser tab accumulate megabytes is a leak, not a feature.
 */
function broadcast(event) {
  const frame = encodeWsText(JSON.stringify(event))
  for (const socket of wsClients) {
    if (socket.destroyed || socket.writableEnded) {
      wsClients.delete(socket)
      continue
    }
    // A socket that has already missed too many pushes is not keeping up (a
    // backgrounded tab, a stalled network). Drop it; the client reconnects and
    // re-reads the current state through the REST API.
    if (socket.__dropped >= WS_MAX_DROPPED) {
      try { socket.destroy() } catch { /* already gone */ }
      wsClients.delete(socket)
      continue
    }
    try {
      if (!socket.write(frame)) socket.__dropped = (socket.__dropped ?? 0) + 1
      else socket.__dropped = 0
    } catch {
      wsClients.delete(socket)
    }
  }
}

/**
 * WebSocket limits. All three bound memory on a long-lived panel: the client
 * set, a single socket's reassembly buffer, and how many consecutive pushes a
 * slow client may miss before it is dropped. Without them a browser tab left
 * open overnight behind a flaky link is a slow OOM of the NAS.
 */
const WS_MAX_CLIENTS = 16
const WS_MAX_MESSAGE_BYTES = 64 * 1024
const WS_MAX_DROPPED = 8
const WS_PING_INTERVAL_MS = 30000
/** No frame (not even a ping) for this long → the peer is gone. */
const WS_IDLE_TIMEOUT_MS = 90000

/** Encode one text frame (server→client MUST NOT mask, per RFC6455). */
function encodeWsText(payload) {
  const text = Buffer.from(payload, 'utf8')
  let header
  if (text.length < 126) {
    header = Buffer.from([0x81, text.length])
  } else if (text.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(text.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(text.length), 2)
  }
  return Buffer.concat([header, text])
}

/**
 * Parse ONE client frame from `buffer`.
 *
 * Returns `{ frame, rest }` where `frame === null` means "need more bytes", and
 * `rest` is whatever follows the consumed frame. The previous version returned
 * `null` for both cases and threw the partial buffer away — so a frame split
 * across two TCP reads (which browsers do routinely for anything over one MTU)
 * was silently discarded, and a ping could be lost forever.
 *
 * A client MUST mask (RFC6455 §5.1); an unmasked frame is a protocol error and
 * is reported so the caller can close the connection instead of guessing.
 */
function decodeWsFrame(buffer) {
  if (buffer.length < 2) return { frame: null, rest: buffer, needMore: true }
  const b0 = buffer[0]
  const b1 = buffer[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const rsv = b0 & 0x70
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2

  if (rsv !== 0) return { frame: { error: 'rsv-set' } , rest: buffer, needMore: false }
  // Control frames must be FIN and carry <= 125 bytes.
  if (!fin && opcode >= 0x8) return { frame: { error: 'fragmented-control' }, rest: buffer, needMore: false }

  if (len === 126) {
    if (buffer.length < 4) return { frame: null, rest: buffer, needMore: true }
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return { frame: null, rest: buffer, needMore: true }
    const big = buffer.readBigUInt64BE(2)
    // Refuse anything past the cap before allocating for it.
    if (big > BigInt(WS_MAX_MESSAGE_BYTES)) {
      return { frame: { error: 'too-large' }, rest: buffer, needMore: false }
    }
    len = Number(big)
    offset = 10
  }

  if (len > WS_MAX_MESSAGE_BYTES) return { frame: { error: 'too-large' }, rest: buffer, needMore: false }
  if (!masked) return { frame: { error: 'unmasked-client-frame' }, rest: buffer, needMore: false }

  if (buffer.length < offset + 4) return { frame: null, rest: buffer, needMore: true }
  const maskKey = buffer.subarray(offset, offset + 4)
  offset += 4

  if (buffer.length < offset + len) return { frame: null, rest: buffer, needMore: true }

  const masked2 = buffer.subarray(offset, offset + len)
  const payload = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) payload[i] = masked2[i] ^ maskKey[i & 3]

  return { frame: { fin, opcode, payload }, rest: buffer.subarray(offset + len), needMore: false }
}

/**
 * A `Sec-WebSocket-Key` is 16 random bytes, base64-encoded → always 24 chars
 * ending in `==` (RFC6455 §4.1). Validating it is not pedantry: without the
 * check, any HTTP client that merely sets the header gets a `101` and is
 * treated as a push client it never negotiated, so the panel hands out its
 * status stream to things that are not WebSockets.
 */
function validWebSocketKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key)
}

/**
 * Perform the RFC6455 server handshake and wire the socket to this panel's push
 * channel.
 *
 * Returns false when the request is not a valid WebSocket upgrade (the caller
 * answers 400). It never throws: everything is best-effort, because this runs
 * inside the server's `upgrade` event where an uncaught exception would kill the
 * whole panel — which is exactly the bug this function used to have.
 */
function acceptWebSocket(request, socket, head) {
  try {
    const key = request.headers['sec-websocket-key']
    if (!validWebSocketKey(key)) return false
    if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket') return false

    // Capacity is checked BEFORE the handshake: writing 101 and then refusing
    // would tell the client it is connected and then close it, which is worse
    // than an honest refusal (the browser retries either way, but only one of
    // the two can be diagnosed from the client side).
    if (wsClients.size >= WS_MAX_CLIENTS) {
      try {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } catch { /* ignore */ }
      socket.destroy()
      return true
    }

    // RFC6455 §4.2.2: the accept value is base64(sha1(key + GUID)). The hash
    // comes from node:crypto — the *global* `crypto` is WebCrypto and has no
    // createHash, so writing `crypto.createHash` here threw a TypeError that
    // took the entire panel process down (createHash is imported at the top).
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)
    // A socket the peer already abandoned must not be tracked.
    if (socket.destroyed) return false

    wsClients.add(socket)
    socket.__dropped = 0
    socket.__aliveAt = Date.now()

    // `head` is bytes the HTTP parser already read past the handshake.
    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)

    const fail = (reason) => {
      try { socket.destroy() } catch { /* ignore */ }
      wsClients.delete(socket)
      console.log(`[ws] closing socket: ${reason}`)
    }

    socket.on('data', (chunk) => {
      socket.__aliveAt = Date.now()
      try {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      } catch {
        fail('buffer-concat-failed')
        return
      }

      // Drain every complete frame the buffer holds.
      for (;;) {
        const { frame, rest, needMore } = decodeWsFrame(buffer)
        if (needMore) {
          // Guard against a peer streaming an endless un-finished frame.
          if (buffer.length > WS_MAX_MESSAGE_BYTES) fail('oversized-incomplete-frame')
          return
        }
        buffer = rest
        if (frame.error) {
          fail(frame.error)
          return
        }

        if (frame.opcode === 0x8) {
          // Close: echo a close frame back, then let `end` flush it.
          try { socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])) } catch { /* ignore */ }
          socket.end()
          wsClients.delete(socket)
          return
        }
        if (frame.opcode === 0x9) {
          try { socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])) } catch { /* ignore */ }
          continue
        }
        if (frame.opcode === 0xa) continue // pong: liveness already recorded
        // Data frames (0x0 continuation / 0x1 text / 0x2 binary): this panel is
        // push-only, so there is nothing to do with a payload. The loop simply
        // keeps parsing, which is what reassembly amounts to for us.
      }
    })

    socket.on('error', () => wsClients.delete(socket))
    socket.on('close', () => wsClients.delete(socket))
    return true
  } catch (error) {
    // Defensive: a failure here must cost one socket, not the panel.
    console.log(`[ws] handshake failed: ${error?.message ?? error}`)
    try { socket.destroy() } catch { /* ignore */ }
    return false
  }
}

/**
 * Heartbeat: ping every idle socket and reap the ones that stopped answering.
 *
 * Without this, a client that vanished without a FIN (a killed browser, a
 * dropped Wi-Fi link) stays in `wsClients` forever — the panel keeps formatting
 * frames for a dead peer and grows its socket set across a long uptime.
 */
export function StartWebSocketHeartbeat() {
  const timer = setInterval(() => {
    if (wsClients.size === 0) return
    const now = Date.now()
    for (const socket of wsClients) {
      if (socket.destroyed || socket.writableEnded) {
        wsClients.delete(socket)
        continue
      }
      if (now - (socket.__aliveAt ?? 0) > WS_IDLE_TIMEOUT_MS) {
        try { socket.destroy() } catch { /* ignore */ }
        wsClients.delete(socket)
        continue
      }
      try { socket.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0])) } catch { /* ignore */ }
    }
  }, WS_PING_INTERVAL_MS)
  timer.unref()
  return timer
}

/** Cap on a log read, so a 200 MB dsh.log cannot exhaust memory. */
const MAX_TAIL_BYTES = 2 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function badRequest(response, message, status = 400) {
  json(response, status, { error: message })
}

async function readBody(request, limitBytes = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('payload-too-large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid-json')
  }
}

/**
 * Authentication has been removed by design.
 *
 * The panel is served exclusively through fnOS's unified gateway, which already
 * performs its own authentication and authorization before a request ever
 * reaches this process. A second password gate here would be redundant and —
 * worse — would ask the user for a secret fnOS already verified. The only gate
 * that remains is the Host/Origin trust fence (dashboard-trust.js), which is a
 * DNS-rebinding/CSRF defence, not an authentication layer. See isTrustedRequest.
 */

/** Settings never echo a secret; presence is reported instead. */
function settingsView() {
  const config = loadConfig()
  return {
    mode: effectiveMode(),
    // Tri-state going out as well as coming in. Old configs — and the installer
    // — seed the boolean `true`, so it is folded into auto here; leaving it as
    // `true` would make the address <select> silently disagree with reality.
    lanBind: config.lanBind === false || config.lanBind === 'false'
      ? false
      : (typeof config.lanBind === 'string' && config.lanBind.trim() && config.lanBind.trim() !== 'true' ? config.lanBind.trim() : ''),
    // What the next apply writes into the patch; `null` means loopback-by-removal.
    lanBindResolved: config.lanBind === false || config.lanBind === 'false' ? null : preferredPatchHost(),
    lanCandidates: lanAddresses(),
    proxyEnabled: config.proxy?.enabled !== false,
    trustedHosts: config.trustedHosts ?? [],
    trustedHostsFile: config.trustedHostsFile ?? [],
    access: {
      enabled: config.access?.enabled !== false,
      max: config.access?.max ?? 500,
      trustProxyHeaders: config.access?.trustProxyHeaders !== false,
    },
    install: {
      npmRegistry: config.install?.npmRegistry || 'https://registry.npmjs.org',
      proxy: config.install?.proxy || '',
    },
    versions: { keep: config.versions?.keep ?? 3 },
    shortcuts: config.shortcuts ?? [],
    proxyUpstream: proxyUrl(),
  }
}

const routes = {
  'GET /api/status': async (request, response) => {
    const status = await dshStatus()
    json(response, 200, {
      ...status,
      // 显式状态机相位（五态）+ 完整快照，覆盖 dshStatus 里的简化字段。
      phase: stateSnapshot().status,
      state: stateSnapshot(),
      panel: {
        version: manifestInfo().version,
        port: CONSOLE_PORT,
        dataDir: DATA_DIR,
        pidFile: PID_FILE,
        logFile: DSH_LOG,
        uiProxy: loadConfig().proxy?.enabled !== false,
        proxyUrl: proxyUrl(),
      },
      access: accessLogStats(),
      version: currentVersion(),
      time: nowIso(),
      recentLogin: recentLogins(1)[0] ?? null,
      recentVisit: recentVisitors(1)[0] ?? null,
    })
  },

  'GET /api/logs': async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const name = url.searchParams.get('file') || 'dsh.log'
    const lines = Math.min(Number(url.searchParams.get('lines')) || 300, 5000)
    const files = logFiles()
    const target = files.find((entry) => entry.name === name || entry.path === name)
    if (!target) return badRequest(response, 'log-not-found', 404)

    let text = ''
    try {
      text = await tailFile(target.path, MAX_TAIL_BYTES)
    } catch (error) {
      return badRequest(response, `unreadable: ${error.message}`, 403)
    }
    const all = text.split('\n').map(cleanLine)
    const body = all.slice(Math.max(0, all.length - lines))
    json(response, 200, {
      file: target.name,
      path: target.path,
      sizeBytes: target.sizeBytes,
      modifiedAt: target.modifiedAt,
      truncated: all.length > lines,
      lines: body,
    })
  },

  'GET /api/logs/list': async (request, response) => {
    json(response, 200, { files: logFiles() })
  },

  'GET /api/versions': async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const state = await versionState({ force: url.searchParams.get('refresh') === '1' })
    json(response, 200, state)
  },

  'POST /api/versions/install': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const version = String(body.version || '').trim()
    if (!version) return badRequest(response, 'missing-version')
    if (installJob) return badRequest(response, 'install-in-progress', 409)

    installJob = { version, startedAt: Date.now(), status: 'running' }
    json(response, 202, { ok: true, version, job: installJob })
    installVersion(version, {
      onProgress: (event) => Object.assign(installJob, event),
    })
      .then((result) => {
        installJob = result.ok
          ? { ...installJob, status: 'done', version: result.version }
          : { ...installJob, status: 'failed', error: result.error, detail: result.detail }
      })
      .catch((error) => {
        installJob = { ...installJob, status: 'failed', error: error?.message ?? String(error) }
      })
  },

  'GET /api/versions/job': async (request, response) => {
    const job = installJob
    json(response, 200, { job })
    // A terminal job is delivered once, then cleared. Keeping it forever makes
    // the UI toast + re-render on every poll (an infinite refresh loop), and
    // blocks the next install with a stale "install-in-progress".
    if (job && job.status !== 'running') installJob = null
  },

  'POST /api/versions/switch': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const version = String(body.version || '').trim()
    const result = switchVersion(version)
    if (!result.ok) return badRequest(response, result.error, 404)
    // Pick up the new binaries: stop first, then let the caller start again.
    await stopDsh()
    json(response, 200, result)
  },

  'POST /api/versions/remove': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const version = String(body.version || '').trim()
    const result = removeVersion(version)
    // 409 = the version is still in use; the UI tells the user to switch first.
    if (!result.ok) return badRequest(response, result.error, result.error === 'in-use' ? 409 : 404)
    // If the panel was about to launch the deleted version, stop so it does
    // not respawn into a missing directory.
    if (result.version === activeDshVersion()) await stopDsh()
    json(response, 200, result)
  },

  'POST /api/versions/prune': async (request, response) => {
    const removed = await pruneVersions()
    json(response, 200, { ok: true, removed })
  },

  'POST /api/service/start': async (request, response) => {
    // LAN reachability lives in the profile patch, so re-apply before launch:
    // dsh regenerates that file and edits elsewhere must not win.
    const binding = applyLanBinding()
    const result = await startDsh()
    json(response, result.ok ? 200 : 500, { ...result, binding })
    broadcast({ type: 'status', ...(await dshStatus()) })
  },

  'POST /api/service/stop': async (request, response) => {
    await stopDsh()
    json(response, 200, { ok: true, stopped: true })
    broadcast({ type: 'status', ...(await dshStatus()) })
  },

  'POST /api/service/restart': async (request, response) => {
    await stopDsh()
    await restartDsh()
    json(response, 200, { ok: true, restarted: true })
    broadcast({ type: 'status', ...(await dshStatus()) })
  },

  'GET /api/access': async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500)
    json(response, 200, {
      enabled: loadConfig().access?.enabled !== false,
      entries: recentVisitors(limit),
      stats: accessLogStats(),
    })
  },

  'DELETE /api/access': async (request, response) => {
    clearVisitors()
    json(response, 200, { ok: true, cleared: true })
    broadcast({ type: 'access' })
  },

  'GET /api/access/login': async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
    json(response, 200, { entries: recentLogins(limit) })
  },

  'GET /api/settings': async (request, response) => {
    json(response, 200, settingsView())
  },

  'POST /api/settings': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const config = loadConfig()
    const next = { ...config }

    for (const key of ['mode', 'shortcuts']) {
      if (body[key] !== undefined) next[key] = body[key]
    }
    // `lanBind` is tri-state and validated before it reaches disk:
    // false → loopback, '' → auto, a concrete literal IP → that NIC. dsh >=
    // 0.2.1-alpha.2 rejects wildcards outright, so never let one through.
    if (body.lanBind !== undefined) {
      const raw = body.lanBind
      if (raw === false || raw === null) next.lanBind = false
      else if (typeof raw === 'string' && raw.trim() && raw.trim() !== '0.0.0.0' && raw.trim() !== '::') {
        next.lanBind = lanAddresses().includes(raw.trim())
          ? raw.trim()
          : (lanAddresses()[0] || '')
      } else next.lanBind = ''
    }
    if (body.trustedHosts !== undefined) {
      next.trustedHosts = writeTrustedHosts(body.trustedHosts)
    }
    if (body.proxy !== undefined) next.proxy = { ...next.proxy, ...body.proxy }
    if (body.access !== undefined) next.access = { ...next.access, ...body.access }
    if (body.install !== undefined) next.install = { ...next.install, ...body.install }
    if (body.versions !== undefined) next.versions = { ...next.versions, ...body.versions }

    saveConfig(next)
    // Persist first, then apply: applyLanBinding() reads loadConfig(), so doing
    // it before saveConfig() would write the *previous* setting's patch.
    if (body.lanBind !== undefined) {
      const binding = applyLanBinding()
      if (!binding.ok) {
        return json(response, 200, { ok: true, bindingError: binding.error, settings: settingsView() })
      }
      // The address just moved; a running dsh is still bound to the old one.
      await restartDsh()
    }
    json(response, 200, { ok: true, settings: settingsView() })
  },

  'GET /api/diagnostics': async (request, response) => {
    json(response, 200, runDiagnostics())
  },

  'GET /api/env': async (request, response) => {
    json(response, 200, environmentState())
  },

  'POST /api/env/install': async (request, response) => {
    json(response, 200, repairEnvironment())
  },

  'GET /api/resources': async (request, response) => {
    json(response, 200, readResources())
  },

  // dsh 进程树资源（区别于 /api/resources 的整机资源）：CPU + 常驻内存。
  'GET /api/usage': async (request, response) => {
    json(response, 200, GetCachedUsage())
  },

  'GET /api/workspace': async (request, response) => {
    json(response, 200, workspaceState())
  },

  'GET /api/workspace/browse': async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = url.searchParams.get('path') || ''
    const result = listDirectory(path)
    json(response, result.ok ? 200 : (result.status ?? 400), result)
  },

  'GET /api/shortcuts': async (request, response) => {
    const port = listenPort()
    const lan = lanAddresses()
    const bound = webserverHost()
    json(response, 200, {
      entries: [
        { label: 'Loopback', url: `http://127.0.0.1:${port}/`, note: bound === '127.0.0.1' ? 'what dsh is bound to' : 'unreachable: dsh is bound to one address only' },
        { label: 'Loopback (panel proxy)', url: `http://127.0.0.1:${CONSOLE_PORT}/p/`, note: 'recorded' },
        ...lan.map((ip) => ({ label: `LAN ${ip}`, url: `http://${ip}:${port}/`, note: ip === bound ? 'what dsh is bound to' : 'needs this address selected in Settings' })),
        { label: 'Hostname', url: `http://${localHost()}:${port}/`, note: 'mDNS may be needed' },
      ],
      custom: loadConfig().shortcuts ?? [],
    })
  },

  'GET /api/plugins': async (request, response) => {
    json(response, 200, pluginState())
  },

  'POST /api/plugins/inspect': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const spec = String(body.spec || '').trim()
    if (!spec) return badRequest(response, 'missing-package')
    const result = await inspectPackage(spec)
    json(response, result.ok ? 200 : 400, result)
  },

  'POST /api/plugins/install': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const spec = String(body.spec || '').trim()
    if (!spec) return badRequest(response, 'missing-package')
    if (pluginJob) return badRequest(response, 'install-in-progress', 409)

    pluginJob = { spec, startedAt: Date.now(), status: 'running' }
    json(response, 202, { ok: true, spec, job: pluginJob })
    installBundle(spec, {
      onProgress: (event) => Object.assign(pluginJob, event),
    })
      .then((result) => {
        pluginJob = result.ok
          ? { ...pluginJob, status: 'done', name: result.name, version: result.version }
          : { ...pluginJob, status: 'failed', error: result.error, detail: result.detail }
      })
      .catch((error) => {
        pluginJob = { ...pluginJob, status: 'failed', error: error?.message ?? String(error) }
      })
  },

  'GET /api/plugins/job': async (request, response) => {
    const job = pluginJob
    json(response, 200, { job })
    // Same consume-once rule as /api/versions/job: a terminal job is cleared
    // after it is handed back, so the Plugins tab stops re-toasting/re-rendering
    // and a future install is not rejected as "install-in-progress".
    if (job && job.status !== 'running') pluginJob = null
  },

  'POST /api/plugins/remove': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const name = String(body.name || '').trim()
    if (!name) return badRequest(response, 'missing-package')
    const result = await removeBundle(name)
    json(response, result.ok ? 200 : 400, result)
  },

  'POST /api/plugins/enable': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const name = String(body.name || '').trim()
    const enabled = body.enabled !== false
    if (!name) return badRequest(response, 'missing-package')
    json(response, 200, setBundleEnabled(name, enabled))
  },

  'POST /api/plugins/row': async (request, response) => {
    let body
    try {
      body = await readBody(request)
    } catch (error) {
      return badRequest(response, error.message)
    }
    const id = String(body.id || '').trim()
    const name = String(body.name || '').trim()
    const enabled = body.enabled !== false
    if (!id) return badRequest(response, 'missing-id')
    json(response, 200, setPluginEnabled(id, name, enabled))
  },
}

/** Read the tail of a file without loading the whole thing. */
async function tailFile(path, maxBytes) {
  const stat = statSync(path)
  const start = Math.max(0, stat.size - maxBytes)
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start, encoding: 'utf8' })
    let text = ''
    stream.on('data', (chunk) => { text += chunk })
    stream.on('error', reject)
    stream.on('end', () => resolve(text))
  })
}

/**
 * Forward one request to dsh and record it.
 *
 * This is the Go reference's `fngateway.go` Rewrite/ModifyResponse ported to
 * Node: it does NOT just forward bytes. dsh's browser-trust fence refuses the
 * privileged API (config read/write, model discovery → 403) and degrades the
 * plugin config panel to memory mode unless the request looks same-origin AND
 * the page declares `window.__DSH_TRANSPORT__.ownsHost`. The reference solved
 * this by rewriting Host/Origin/Sec-Fetch-Site to the loopback upstream and
 * injecting the transport shim into every HTML response. Without those, the
 * gateway serves the suite shell but "data is unreachable" — exactly the
 * symptom reported. See deepseek.harness.fnos/REVERSE_PROXY_ADAPTATION.md
 * problems #1 (403) and #4 (blank plugin config).
 *
 * WebSocket upgrades and SSE survive: only `text/html` bodies are buffered for
 * injection (HTML is small); everything else, and all streams, pipe straight
 * through.
 *
 * The upstream address is read back from the patch dsh was launched with rather
 * than assumed to be loopback: dsh binds exactly one address, so the moment it
 * is bound to a LAN IP it stops answering 127.0.0.1 — a hard-coded loopback
 * here would silently break LAN binding. See webserverHost().
 */

/** Injected into every HTML `<head>`: hide the desktop "open config" button and
 *  declare the native-host privilege branch (REVERSE_PROXY_ADAPTATION #4/#5). */
const DSH_HTML_SHIM = '<style>[data-slot="settings.action"] { display: none !important; }</style>' +
  '<script>try{window.__DSH_TRANSPORT__=Object.assign(window.__DSH_TRANSPORT__||{},{ownsHost:true});}catch(_){}</script>'

/** Insert `shim` right after `<head...>` (or prepend when there is no head). */
function injectDshHtml(body, shim) {
  const lower = body.toString('latin1').toLowerCase()
  const idx = lower.indexOf('<head')
  if (idx !== -1) {
    const close = body.indexOf(0x3e /* '>' */, idx) // first '>' after <head
    if (close !== -1) {
      return Buffer.concat([body.subarray(0, close + 1), Buffer.from(shim), body.subarray(close + 1)])
    }
  }
  return Buffer.concat([Buffer.from(shim), body])
}

/** Strip a loopback authority from a redirect Location so the client stays on
 *  the gateway host instead of drifting to 127.0.0.1 (Go `rewriteGatewayLocation`). */
function stripLoopbackLocation(loc) {
  if (!loc) return loc
  try {
    const u = new URL(loc, 'http://localhost')
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') {
      u.protocol = ''
      u.host = ''
      return u.pathname + (u.search || '') + (u.hash || '')
    }
  } catch {}
  return loc
}

/** Inject `crossorigin="use-credentials"` into `<link rel="manifest">` so the
 *  gateway auth cookie rides the manifest request (Go `rewriteFnGatewayHtml` step 1). */
function injectManifestCredentials(body) {
  const re = /<link\b[^>]*\brel=["']manifest["'][^>]*>/gi
  return body.replace(re, (match) => {
    if (!/crossorigin/i.test(match)) {
      return match.replace(/<link/i, '<link crossorigin="use-credentials"')
    }
    return match
  })
}

async function proxyToDsh(request, response, { pathPrefix }) {
  const target = listenPort()
  const upstreamHost = webserverHost()
  const authority = `${upstreamHost}:${target}`
  const headers = { ...request.headers }
  for (const hop of ['host', 'connection', 'upgrade', 'proxy-connection', 'te', 'trailers', 'transfer-encoding']) {
    delete headers[hop]
  }
  // 回环 Host：上游计算的 authority 恒定（Go Rewrite 阶段）。
  headers.host = authority
  // 改写为回环同源 Origin，过 dsh browser-trust fence 的特权 API 403（问题 #1）。
  headers.origin = `http://${authority}`
  // same-origin，防止跨站/iframe 标记被上游拦截。
  headers['sec-fetch-site'] = 'same-origin'
  // 禁用压缩，保证下面能对 HTML 做注入（Go 版同款）。
  headers['accept-encoding'] = 'identity'

  const realIp = clientIp(request.socket, request.headers)
  if (realIp) headers['x-forwarded-for'] = realIp

  // 会话代持：面板已从 dsh 的 Launch Token 换取 `dsh-auth-*` Cookie，
  // 转发时注入，剥离客户端旧凭据（对齐 Go 版 fngateway Rewrite 的 appendDshSessionCookie）。
  // 这是过 dsh 第二道闸（token gate 401）的关键，替代旧版 patch 上游 isAuthenticated。
  const sessionCookie = await GetDshSessionCookie()
  if (sessionCookie) {
    headers.cookie = appendDshSessionCookie(request.headers.cookie, sessionCookie)
  }

  // 还原被折叠的 /plugins/?? 多路复用请求（问题 #7：连续问号折叠）。
  // 对齐 Go 版 fngateway.go：`pr.Out.URL.Path == "/plugins/" && !HasPrefix(RawQuery,"?")`。
  // 关键：RawQuery 是不含前导 `?` 的查询串。`/plugins/??client.js` 解析后
  // RawQuery = `?client.js`（以 `?` 开头，说明 `??` 完好，不还原）；
  // 被某层折叠成 `/plugins/?client.js` 时 RawQuery = `client.js`（不以 `?` 开头），
  // 补一个 `?` 还原成 `??client.js`。绝不能对完好的 `??` 再加 `?`（会变 `???` 404）。
  let upstream = request.url.slice(pathPrefix.length) || '/'
  const qIdx = upstream.indexOf('?')
  const upPath = qIdx >= 0 ? upstream.slice(0, qIdx) : upstream
  const rawQuery = qIdx >= 0 ? upstream.slice(qIdx + 1) : '' // 不含前导 `?`（对应 Go RawQuery）
  if (upPath === '/plugins/' && !rawQuery.startsWith('?') && rawQuery.includes('client.js')) {
    upstream = `${upPath}?${rawQuery}` // '/plugins/' + '?' + 'client.js...' == '/plugins/??client.js...'
  }

  const startedAt = Date.now()
  const visit = (status) => {
    recordVisit({
      ip: realIp,
      method: request.method,
      path: upstream,
      status,
      tookMs: Date.now() - startedAt,
      userAgent: request.headers['user-agent'],
      auth: 'passthrough',
    })
    broadcast({ type: 'visit', ip: realIp, path: upstream, method: request.method, status })
  }

  const proxied = httpRequest(
    { host: upstreamHost, port: target, path: upstream, method: request.method, headers },
    (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502
      const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase()
      const out = { ...upstreamResponse.headers }
      delete out['connection']
      delete out['transfer-encoding']

      // SSE：流式直通，只修缓冲/压缩头，不读 body（Go ModifyResponse 同款）。
      if (contentType.startsWith('text/event-stream')) {
        out['cache-control'] = 'no-cache, no-transform'
        out['x-accel-buffering'] = 'no'
        delete out['content-length']
        response.writeHead(status, out)
        upstreamResponse.pipe(response)
        visit(status)
        return
      }

      // HTML：读完整 body，移除 CSP、注入 __DSH_TRANSPORT__ 补丁、禁用强缓存。
      if (contentType.includes('text/html')) {
        const chunks = []
        upstreamResponse.on('data', (c) => chunks.push(c))
        upstreamResponse.on('end', () => {
          // 对齐 Go 版 rewriteFnGatewayHtml：先给 manifest 注入 crossorigin
          // （网关鉴权 Cookie 携带），再注入特权声明 + 样式隐藏补丁。
          const raw = Buffer.concat(chunks)
          let body = injectDshHtml(injectManifestCredentials(raw), DSH_HTML_SHIM)
          delete out['content-security-policy']
          delete out['content-security-policy-report-only']
          out['cache-control'] = 'no-store, no-cache, must-revalidate, max-age=0'
          out['pragma'] = 'no-cache'
          out['expires'] = '0'
          delete out['etag']
          delete out['last-modified']
          out['content-type'] = 'text/html; charset=utf-8'
          out['content-length'] = body.length
          response.writeHead(status, out)
          response.end(body)
          visit(status)
        })
        upstreamResponse.on('error', () => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        })
        return
      }

      // 其它（JS/CSS/图片/JSON/字体）：原样转发，仅剥重定向里的回环主机。
      if (out['location']) out['location'] = stripLoopbackLocation(out['location'])
      delete out['content-length']
      response.writeHead(status, out)
      upstreamResponse.pipe(response)
      visit(status)
    },
  )
  proxied.on('error', (error) => {
    if (response.headersSent) {
      response.end()
      return
    }
    json(response, 502, {
      error: 'dsh-unreachable',
      detail: error.code === 'ECONNREFUSED' ? `nothing listening on ${upstreamHost}:${target}` : error.message,
    })
  })
  if (request.headers.upgrade) {
    // Upgrade requests need the socket wired through, not piped bodies.
    request.on('data', (chunk) => proxied.write(chunk))
    request.on('end', () => proxied.end())
  } else {
    request.pipe(proxied)
  }
}

/**
 * A dedicated LAN-only reverse proxy: it forwards every request straight to
 * dsh (same upstream resolution as `/p/`), so a client on the same network can
 * open `http://<NAS-IP>:28002` and land directly in the suite — no `/p/` path,
 * no panel UI, no `/api/` surface. Session holding (dashboard-session.js)
 * supplies the `dsh-auth-*` cookie upstream, so this port needs no token.
 *
 * It still passes the Host/Origin trust fence: the panel's trusted-host list
 * (loopback + local LAN addresses) governs who may reach it, identical to the
 * main console server. Session holding (dashboard-session.js) supplies the
 * `dsh-auth-*` cookie upstream, so this port needs no token either.
 */
export function createLanProxyServer() {
  return createServer((request, response) => {
    const startedAt = Date.now()

    // Same trust fence as the console server, so a stranger's Host header
    // can't drive the proxy (DNS rebinding) any more than it can the UI.
    const trust = isTrustedRequest(request.headers)
    if (!trust.ok) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`403 untrusted host (${requestHost(request.headers) || 'none'}: ${trust.reason})\n`)
      return
    }

    // Everything that isn't rejected goes upstream to dsh verbatim.
    proxyToDsh(request, response, { pathPrefix: '' })

    response.once('finish', () => {
      const ms = Date.now() - startedAt
      if (ms > 2000) console.log(`[lan-proxy] slow ${request.method} ${request.url} ${ms}ms`)
    })
  })
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = join(UI_DIR, normalize(relative).replace(/^(\.\.[/\\])+/, ''))
  if (!full.startsWith(UI_DIR) || !existsSync(full) || !statSync(full).isFile()) {
    return badRequest(response, 'not-found', 404)
  }
  response.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  const stream = createReadStream(full)
  stream.pipe(response)
}

export function createConsoleServer() {
  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    const url = new URL(request.url, 'http://localhost')
    const pathname = url.pathname

    // The trust fence runs first: an untrusted Host never reaches routing.
    // Deliberately Host/Origin-based, not socket-peer-based — see
    // dashboard-trust.js for why the peer check would let DNS rebinding in.
    const trust = isTrustedRequest(request.headers)
    if (!trust.ok) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`403 untrusted host (${requestHost(request.headers) || 'none'}: ${trust.reason})\n`)
      return
    }

    try {
      if (pathname.startsWith('/api/')) {
        const key = `${request.method} ${pathname}`
        const handler = routes[key]
        if (!handler) return badRequest(response, 'no-such-endpoint', 404)
        // Authentication was removed: fnOS's gateway already authenticated the
        // caller. Every route is served once it passes the trust fence above.
        await handler(request, response)
        return
      }

      const proxyEnabled = loadConfig().proxy?.enabled !== false
      const prefix = loadConfig().proxy?.pathPrefix || '/p'
      if (proxyEnabled && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        await proxyToDsh(request, response, { pathPrefix: prefix })
        return
      }

      if (pathname.startsWith('/assets/') || pathname === '/' || /\.(?:js|css|png|svg|ico|woff2)$/.test(pathname)) {
        await serveStatic(request, response, pathname)
        return
      }

      badRequest(response, 'not-found', 404)
    } catch (error) {
      json(response, 500, { error: 'internal', detail: String(error?.message ?? error) })
    } finally {
      response.once('finish', () => {
        const ms = Date.now() - startedAt
        if (ms > 2000) console.log(`[console] slow ${request.method} ${pathname} ${ms}ms`)
      })
    }
  })

  // WebSocket upgrade: `/ws` becomes a push channel for status/log/access.
  // The trust fence applies here too — an untrusted Host can't open a socket.
  //
  // The whole handler is wrapped: an exception thrown inside an `upgrade`
  // listener is an uncaught exception, and this process supervises dsh, holds
  // the panel's only watchdog, and is restarted by fnOS at best every few
  // minutes. One bad frame must never be able to take the panel down.
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const trust = isTrustedRequest(request.headers)
      if (!trust.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (!acceptWebSocket(request, socket, head)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
      }
    } catch (error) {
      console.log(`[ws] upgrade handler failed: ${error?.message ?? error}`)
      try { socket.destroy() } catch { /* ignore */ }
    }
  })

  // 状态机变更 → 推送 status 事件（对齐 Go 版 SubscribeState）。
  // usage 变化 → 推送 usage 事件（对齐 Go 版 SubscribeUsage）。
  //
  // These live inside createConsoleServer but push state for the whole process,
  // so they are registered only once. A second createConsoleServer() (the smoke
  // test builds one) would otherwise double every broadcast and leak the
  // previous server's closure for the lifetime of the process.
  if (!subscribersRegistered) {
    subscribersRegistered = true

    SubscribeState(() => {
      if (wsClients.size === 0) return
      // A rejecting dshStatus() must not become an unhandled rejection here.
      dshStatus()
        .then((status) => {
          broadcast({ type: 'status', ...status, phase: stateSnapshot().status, state: stateSnapshot() })
        })
        .catch((error) => console.log(`[ws] status push failed: ${error?.message ?? error}`))
    })
    SubscribeUsage((usage) => {
      if (wsClients.size === 0) return
      broadcast({ type: 'usage', ...usage })
    })
  }

  return server
}

/**
 * Close every push socket. Called on SIGTERM/SIGINT so a restarting panel does
 * not leave the browser holding sockets the server will never answer — the
 * client would otherwise sit in its 2s reconnect loop through the whole
 * restart window and each attempt logs a failure.
 */
export function closeAllWebSockets() {
  for (const socket of wsClients) {
    try { socket.destroy() } catch { /* ignore */ }
  }
  wsClients.clear()
}

/** How many push sockets are currently attached (diagnostics/tests). */
export function webSocketClientCount() {
  return wsClients.size
}

export { routes, UI_DIR, broadcast }
