/**
 * dsh 浏览器会话代持（对齐 Go 版 harness.go 的服务端会话代持）。
 *
 * dsh 0.1.2+ 启动时打印一次性 Launch Token：`dsh web: http://.../?token=…`，
 * 浏览器用它换取 30 天的 `dsh-auth-*` Cookie。面板无法让浏览器自动完成这个
 * 换 Cookie 流程（反代是服务端行为），所以由面板自己代持：
 *   1. 捕获 dsh stdout 里的 `?token=`（CaptureLaunchToken）；
 *   2. 需要时用 token 向 dsh 换取 `dsh-auth-*` Cookie（exchangeDshSessionCookie）；
 *   3. 反代转发时把该 Cookie 注入请求（GetDshSessionCookie + appendDshSessionCookie）。
 *
 * 这替代了旧版「直接改上游 isAuthenticated 返回 true」的 patch 方案——patch 会在
 * dsh 升级导致源码字符串不匹配时静默失效（token gate 恢复 → 反代 401），而代持
 * 不碰上游代码，升级安全。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { managedPort, webserverHost } from './dashboard-config.js'
import { DATA_DIR } from './dashboard-utils.js'

// Launch Token：dsh 启动打印 `dsh web: .*?[?&]token=<token>`（Go launchTokenRe）。
const LAUNCH_TOKEN_RE = /dsh web: .*?[?&]token=([A-Za-z0-9_-]+)/

// 整条启动地址：同一行里的 URL 本体（含 `?token=…`）。面板只用它做展示与
// 「一键打开」，不做任何请求 —— 那是 exchangeDshSessionCookie 的职责。
const LAUNCH_URL_RE = /dsh web:\s*(\S+)/

// 捕获 stdout 时的行缓冲：分块到达时拼出完整行再匹配 token。
/** 行缓冲硬上限（见 CaptureLaunchToken 里的说明）。 */
const LINE_BUFFER_CAP = 64 * 1024
let lineBuffer = ''
let currentLaunchToken = ''
let currentLaunchUrl = ''
let cachedCookie = ''
let lastTryAt = 0

/**
 * 会话代持状态的落盘位置。
 *
 * 没有这层持久化，Launch Token 与换来的 `dsh-auth-*` Cookie 只活在模块内存里，
 * 面板**每次重启都会丢**——而 fnOS 每次升级/重装套件都会重启面板。偏偏 dsh
 * 此时往往还活着（`startDsh()` 的「已有活进程直接复用」分支不重新 spawn，自然
 * 也不会重新打印 token），于是反代再没有凭据可注入：
 *
 *   - HTTP → 被 dsh 的 token gate 直接 401（面板上表现为各种接口失败）；
 *   - WebSocket（remote.mux）→ 握手能过，但对端永不回话，前端等满 60 秒后抛
 *     `Connection timed out after 60000ms`，页面就"废了"。
 *
 * 这正是「升级完就不正常」的成因：不是代码变了，是重启把凭据冲掉了。
 * 写盘后面板重启可原样恢复代持，与 dsh 是否跟着重启无关。
 */
const SESSION_FILE = join(DATA_DIR, 'dsh-session.json')
let sessionLoaded = false

function loadPersistedSession() {
  if (sessionLoaded) return
  sessionLoaded = true
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    if (!currentLaunchToken && typeof raw?.token === 'string') currentLaunchToken = raw.token.trim()
    if (!currentLaunchUrl && typeof raw?.url === 'string') currentLaunchUrl = raw.url.trim()
    if (!cachedCookie && typeof raw?.cookie === 'string') cachedCookie = raw.cookie.trim()
  } catch {
    // 首次启动没有该文件；文件损坏也当作没有，绝不让它拖垮反代。
  }
}

function persistSession() {
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    const tmp = `${SESSION_FILE}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ token: currentLaunchToken, url: currentLaunchUrl, cookie: cachedCookie }, null, 2)}\n`, 'utf8')
    renameSync(tmp, SESSION_FILE)
    // 这是 dsh 的登录凭据，权限必须收紧（同 .credentials.yaml 的处理）。
    chmodSync(SESSION_FILE, 0o600)
  } catch {
    // 落盘失败不该影响代持本身：内存里的凭据本轮仍然可用。
  }
}

/**
 * 记录（或清空）当前 Launch Token —— 顺带记下它所在的那条启动地址。
 *
 * `launchUrl` 缺省时不改已有地址：本函数的另两个调用点（停止/重启 dsh）传的是
 * 空 token，那时必须连地址一起清掉（旧地址会让人点到一条已经失效的 token）；
 * 而只更新 token 的场景不该把地址抹掉。
 */
export function SetCurrentLaunchToken(token, launchUrl) {
  loadPersistedSession()
  const trimmed = String(token ?? '').trim()
  if (currentLaunchToken !== trimmed) {
    currentLaunchToken = trimmed
    InvalidateDshSession()
  }
  if (typeof launchUrl === 'string') currentLaunchUrl = launchUrl.trim()
  else if (!trimmed) currentLaunchUrl = ''
  persistSession()
}

export function GetCurrentLaunchToken() {
  loadPersistedSession()
  return currentLaunchToken
}

/** dsh 最近一次启动打印的完整地址（含 `?token=…`）；未捕获则为空串。 */
export function GetLaunchUrl() {
  loadPersistedSession()
  return currentLaunchUrl
}

/** 清空缓存的会话凭据（Go InvalidateDshSession）。 */
export function InvalidateDshSession() {
  cachedCookie = ''
  lastTryAt = 0
  persistSession()
}

/**
 * 会话代持是否就位 —— 给状态接口与前端诊断用。
 *
 * `cookie: false` 且 dsh 在跑，就是上面那个「HTTP 401 / WS 60 秒超时」的状态，
 * 一眼能看出来，不用再去翻日志猜。
 */
export function sessionHoldState() {
  loadPersistedSession()
  return { token: Boolean(currentLaunchToken), cookie: Boolean(cachedCookie), url: currentLaunchUrl }
}

/**
 * 喂入 dsh stdout 的原始分块，按行提取 Launch Token。
 * 对应 Go tokenCaptureWriter：把流拼成行，逐行跑 launchTokenRe。
 */
export function CaptureLaunchToken(chunk) {
  if (!chunk) return
  lineBuffer += String(chunk)
  let idx
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    const line = lineBuffer.slice(0, idx)
    lineBuffer = lineBuffer.slice(idx + 1)
    const m = LAUNCH_TOKEN_RE.exec(line)
    if (m) {
      // 地址与 token 同一行，一起取：只存 token 的话前端只能拼出一个
      // 「大概是这个」的 URL，端口/主机一变就指错地方。
      const u = LAUNCH_URL_RE.exec(line)
      SetCurrentLaunchToken(m[1], u ? u[1] : '')
    }
  }
  // 无上限修复：dsh 若长时间输出不含换行的二进制/进度条，lineBuffer 会无界
  // 增长（一个从不换行的进程可以在几小时内吃光内存）。
  //
  // **必须在拆行循环之后**截断：循环结束后 lineBuffer 只剩最后一条不完整的行，
  // 此时丢头部是安全的。若在拼行之前就 slice，可能把一条完整的
  // `dsh web: http://...?token=…` 行从中间切断 —— token 永远捕获不到，反代
  // 会持续 401，而这种现象极难和"上游改了启动输出"区分开。
  // token 行本身远小于 64KB，所以"丢头部"不可能丢到 token。
  if (lineBuffer.length > LINE_BUFFER_CAP) {
    lineBuffer = lineBuffer.slice(lineBuffer.length - LINE_BUFFER_CAP)
  }
}

/**
 * 获取（或按需换取）会话凭据。有缓存直接用；无缓存且距上次尝试 <2s 则静默返回
 * 空（Go GetDshSessionCookie 的节流）；否则用当前 token 换取。
 */
export function GetDshSessionCookie() {
  loadPersistedSession()
  if (cachedCookie) return cachedCookie
  if (lastTryAt && Date.now() - lastTryAt < 2000) return ''
  const token = currentLaunchToken
  if (!token) return ''
  return exchangeDshSessionCookie(token)
}

/** 用 Launch Token 向 dsh 换取 `dsh-auth-*` Cookie（Go exchangeDshSessionCookie）。 */
function exchangeDshSessionCookie(token) {
  lastTryAt = Date.now()
  const port = managedPort()
  const host = webserverHost() || '127.0.0.1'
  const authority = `${host}:${port}`
  const path = `/?token=${encodeURIComponent(token)}`

  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host,
        port,
        path,
        method: 'GET',
        headers: {
          host: authority,
          'sec-fetch-site': 'same-origin',
          accept: '*/*',
        },
      },
      (res) => {
        res.resume() // drain body; we only care about Set-Cookie
        res.on('end', () => {
          const cookie = findDshAuthCookie(res.headers['set-cookie'])
          if (cookie) {
            cachedCookie = cookie
            // 换到就落盘：这是下一次面板重启后唯一的凭据来源。
            persistSession()
          }
          resolve(cookie)
        })
        // 响应流的 'error' 与 'end' 是互斥的：连接重置时只有前者到达，
        // 之前没有监听 → Promise 永不 settle，且 lastTryAt 已置位导致
        // 随后 2s 内静默拿空 cookie，表现为反代间歇 401 且无日志。
        res.on('error', () => resolve(''))
      },
    )
    req.setTimeout(5000, () => {
      req.destroy()
      resolve('')
    })
    req.on('error', () => resolve(''))
    req.end()
  })
}

/** 从 Set-Cookie 头里找 `dsh-auth-*` 凭据（Go 遍历 resp.Cookies 找前缀）。 */
function findDshAuthCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const raw of list) {
    if (!raw) continue
    const nameValue = raw.split(';')[0].trim()
    const eq = nameValue.indexOf('=')
    if (eq < 0) continue
    const name = nameValue.slice(0, eq).trim()
    const value = nameValue.slice(eq + 1).trim()
    if (name.startsWith('dsh-auth-') && value) return `${name}=${value}`
  }
  return ''
}

/**
 * 组装发往 dsh 的 Cookie：剥离客户端旧 `dsh-auth-*` 凭据，注入面板代持的凭据
 * （Go appendDshSessionCookie）。
 */
export function appendDshSessionCookie(clientCookie, sessionCookie) {
  // 面板手里没有凭据时**绝不能剥离浏览器的凭据**：那样等于把唯一还能用的一道
  // 认证也拆掉，dsh 必然 401 / WS 无回话。原样透传，浏览器自己那份还能生效。
  if (!sessionCookie) return clientCookie ?? ''
  const kept = []
  if (clientCookie) {
    for (const part of clientCookie.split(';')) {
      const p = part.trim()
      if (!p || p.startsWith('dsh-auth-')) continue
      kept.push(p)
    }
  }
  if (sessionCookie) kept.push(sessionCookie)
  return kept.join('; ')
}
