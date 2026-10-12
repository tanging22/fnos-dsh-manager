/**
 * Shared UI helpers: fetch wrapper, escaping, toasts, and the small DOM
 * builder used by every view. No framework — this file is the whole toolkit.
 */

/**
 * Prefix every absolute path with the app's mount point.
 *
 * fnOS serves the suite through its unified gateway at `/app/<appname>/`, and
 * an absolute `/api/...` would escape that prefix and miss the app entirely.
 * The gateway strips the prefix before the panel sees the request, so the
 * panel's own routing stays absolute — the browser just has to say it right.
 */
const BASE = (() => {
  const match = /^(\/app\/[^/]+)/.exec(window.location.pathname)
  return match ? match[1] : ''
})()

export function url(path) {
  return String(path).startsWith('/') ? `${BASE}${path}` : path
}

/** Every backend call goes through here so errors are handled once. */
export async function api(path, options = {}) {
  const init = {
    credentials: 'same-origin',
    headers: { ...(options.headers ?? {}) },
    ...options,
  }
  if (options.body !== undefined && typeof options.body !== 'string') {
    init.body = JSON.stringify(options.body)
    init.headers['content-type'] = 'application/json'
  }

  let response
  try {
    response = await fetch(url(path), init)
  } catch (error) {
    throw new Error(`network: ${error.message}`)
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!response.ok) {
    const detail = payload?.detail ? ` — ${payload.detail}` : ''
    throw new Error(`${payload?.error ?? response.status}${detail}`)
  }
  return payload
}

/** Escape before any interpolation into innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function el(html) {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild
}

let toastHost = null
export function toast(message, kind = 'info', timeoutMs = 4200) {
  if (!toastHost) toastHost = document.getElementById('toast-host')
  if (!toastHost) return
  const node = el(`<div class="toast toast-${kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'info'}">${esc(message)}</div>`)
  toastHost.appendChild(node)
  setTimeout(() => node.remove(), timeoutMs)
}

export function bytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return String(iso)
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function localTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(iso)
}

/**
 * Open a reconnecting WebSocket to the panel's `/ws` push channel and hand
 * parsed JSON events to `onEvent`. Returns a close() that tears it down.
 * Falls back silently when WS is unavailable (older fnOS gateway) — the
 * existing poll keeps the UI correct in that case.
 *
 * `onState(connected)` fires on every open/close. Callers need it because the
 * server pushes `usage` every second: while the push channel is live, an HTTP
 * poll of the same numbers is duplicate traffic, and the poll must resume the
 * moment the channel drops. See overview.js's usage timer.
 */
export function ws(onEvent, onState) {
  let socket = null
  let closed = false
  let timer = null
  const report = (connected) => { try { onState?.(connected) } catch { /* ignore */ } }

  const connect = () => {
    if (closed) return
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const target = `${proto}//${window.location.host}${url('/ws')}`
    try {
      socket = new WebSocket(target)
    } catch {
      return
    }
    socket.onopen = () => report(true)
    socket.onmessage = (event) => {
      try { onEvent(JSON.parse(event.data)) } catch { /* ignore malformed frame */ }
    }
    socket.onclose = () => {
      report(false)
      if (closed) return
      timer = setTimeout(connect, 2000)
    }
    socket.onerror = () => {
      try { socket.close() } catch { /* already closing */ }
    }
  }

  connect()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    try { socket?.close() } catch { /* ignore */ }
  }
}

export function on(target, event, handler) {
  target.addEventListener(event, handler)
  return () => target.removeEventListener(event, handler)
}

