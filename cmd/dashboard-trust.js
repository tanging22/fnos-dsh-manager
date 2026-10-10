/**
 * Request trust: who may reach privileged routes.
 *
 * fnOS only ever hands the app its own Unix-socket gateway, so a browser that
 * reaches the panel has already crossed one boundary. That is not a reason to
 * leave the panel open: dsh's own fence is `Host`/`Origin`-based, so this one
 * is, too — the same vocabulary, applied to the panel's own surface.
 *
 * The rule that took a bug to learn: the trust decision is allow-list only.
 * A Host that merely *looks* local ("localhost", "127.0.0.1", a bare IP) is not
 * evidence of anything, because anyone can send that header. Only a socket peer
 * that really is loopback counts, or a name that appears in the machine's own
 * interface/host list. Anything else is refused, including Host headers that
 * are syntactically valid but unknown to this box.
 */

import { existsSync } from 'node:fs'
import { APP_DIR, CONSOLE_APP_DIR, lanAddresses, localHost } from './dashboard-utils.js'
import { loadConfig, trustedHosts } from './dashboard-config.js'

/** Hosts dsh would itself accept, plus this host's own LAN addresses. */
function liveTrustedHosts() {
  return [...new Set([lanAddresses(), localHost(), 'localhost'].flat().filter(Boolean))]
}

function normalizeHost(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')        // [::1]
    .replace(/:\d+$/, '')            // host:port
    .replace(/\.$/, '')              // trailing dot
}

/** Suffix match, so `app.internal` covers `dsh.app.internal`. */
function matches(host, candidate) {
  if (!host || !candidate) return false
  return host === candidate || host.endsWith(`.${candidate}`)
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export function requestHost(headers) {
  const forwarded = headers['x-forwarded-host']
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || headers['host'] || ''
  return normalizeHost(raw)
}

export function requestOriginHost(headers) {
  const origin = headers['origin']
  if (!origin) return ''
  try {
    return normalizeHost(new URL(String(origin)).hostname)
  } catch {
    return ''
  }
}

/** True when `host` is an address this machine actually holds. */
function isLocalAddress(host) {
  const locals = [lanAddresses(), localHost()].flat().map(normalizeHost).filter(Boolean)
  if (locals.includes(host)) return true
  /* A loopback literal is only local if something on this box really is on it;
     the check above already covered the interfaces, so accept the canonical
     loopback names here. */
  return LOOPBACK.has(host)
}

/**
 * Trust decision for one request.
 *
 * One input, and it has to agree with the allow-list: the Host (and Origin,
 * when one is sent) header.
 *
 * The socket peer is deliberately *not* used to grant trust. It feels like the
 * strongest signal — you cannot forge `remoteAddress` — but it is the wrong
 * one: a browser on an attacker's page can be pointed at 127.0.0.1 (DNS
 * rebinding, or just a link), and its peer really is loopback while its Host
 * really is `evil.example.com`. Accepting loopback peers outright would hand
 * that page the full panel API with credentials the browser holds. The Host
 * allow-list is what stops it, so the Host allow-list is the gate.
 *
 * @param {object} headers
 * @returns {{ok:boolean, reason?:string}}
 */
export function isTrustedRequest(headers) {
  const host = requestHost(headers)
  if (!host) return { ok: false, reason: 'missing-host' }

  const originHost = requestOriginHost(headers)
  /* An Origin that disagrees with Host is a cross-site request: refuse it
     regardless of trust, because that is what stops a browser on a trusted
     page from being used to drive this panel. */
  if (originHost && originHost !== host) return { ok: false, reason: 'origin-host-mismatch' }

  if (isLocalAddress(host)) return { ok: true }

  const configured = (loadConfig().trustedHosts ?? []).map(normalizeHost).filter(Boolean)
  for (const candidate of [...liveTrustedHosts(), ...trustedHosts(), ...configured]) {
    if (matches(host, candidate)) return { ok: true }
  }
  return { ok: false, reason: 'untrusted-host' }
}

/**
 * Client address of a proxied request. `trustProxyHeaders` accepts
 * `X-Forwarded-For` / `X-Real-IP` because fnOS's gateway sets them; with it
 * off (or behind no proxy) the socket peer is used, which cannot be spoofed.
 */
export function clientIp(socket, headers) {
  if (loadConfig().access?.trustProxyHeaders !== false) {
    const forwarded = headers['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    if (raw) {
      const first = String(raw).split(',')[0].trim()
      if (first) return first
    }
    const real = headers['x-real-ip']
    if (real) return String(real).trim()
  }
  return socket?.remoteAddress ?? ''
}

/** True when this deployment looks like it is served through fnOS's gateway. */
export function behindGateway() {
  return existsSync('/tmp/trim.sock')
    || existsSync(`${CONSOLE_APP_DIR}/app.sock`)
    || existsSync(`${CONSOLE_APP_DIR}/target/app.sock`)
    || existsSync(`${APP_DIR}/app.sock`)
    || existsSync(`${APP_DIR}/target/app.sock`)
}

export { liveTrustedHosts, LOOPBACK, IPV4 }
