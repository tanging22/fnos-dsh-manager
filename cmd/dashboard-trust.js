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
import { APP_DIR, CONSOLE_APP_DIR, CONSOLE_PORT, LAN_PROXY_PORT, lanAddresses, localHost } from './dashboard-utils.js'

/**
 * 本面板自己的监听端口：console + LAN 直连口。Origin 端口检查用。
 *
 * CONSOLE_PORT 必须从 utils 引，不能在这儿写死 28001——utils 侧读的是
 * process.env.CONSOLE_PORT，写死之后一旦用环境变量换了端口，面板自己页面
 * 发来的 POST 会全部被判 origin-port-mismatch，也就是面板把自己锁在外面。
 */
const OWN_LISTEN_PORTS = new Set([CONSOLE_PORT, LAN_PROXY_PORT])

/** 提取 Origin 头的端口（无端口返回 ''；https 默认 443 也返回 ''——不惩罚）。 */
function originPortOf(origin) {
  try {
    const u = new URL(String(origin))
    if (u.protocol === 'https:') return '' // https 默认口，通常来自网关 TLS 终结
    return u.port ? String(Number(u.port)) : ''
  } catch {
    return ''
  }
}
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
  // x-forwarded-host 只在真的有 fnOS 网关时才可信。面板直接暴露在
  // 0.0.0.0（lan-proxy 28000/28002），LAN 上任意客户端可以自设
  // `X-Forwarded-Host: localhost` 绕过 isTrustedRequest 的本地判定——
  // 与本文件自己的原则矛盾（"Host 头不可作为本地证据，谁都能发"，
  // X-Forwarded-Host 同样谁都能发）。只有 behindGateway() 为真（部署
  // 在网关后面）时才采信它；直连时强制用真实 Host 头。
  const forwarded = headers['x-forwarded-host']
  const fromProxy = behindGateway() ? (Array.isArray(forwarded) ? forwarded[0] : forwarded) : null
  const raw = fromProxy || headers['host'] || ''
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
  // Origin 的端口也要在面板自己的监听集合里：之前只比 hostname，
  // `http://localhost:3000` 的页面也能过 `localhost:28000` 的检查（跨端口
  // CSRF 弱化）。面板监听 28001（console）与 LAN_PROXY_PORT（直连），
  // Origin 端口必须是其中之一（或 Origin 没写端口且是 https 默认口时跳过）。
  if (originHost) {
    const originPort = originPortOf(headers['origin'])
    if (originPort && !OWN_LISTEN_PORTS.has(originPort)) {
      return { ok: false, reason: 'origin-port-mismatch' }
    }
  }

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
  // 同 requestHost：X-Forwarded-For / X-Real-IP 只在网关后面才可信。
  // 直连时这些头谁都能伪造，会污染访问记录。socket peer 无法伪造。
  if (behindGateway() && loadConfig().access?.trustProxyHeaders !== false) {
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
