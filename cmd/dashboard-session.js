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

import { request as httpRequest } from 'node:http'
import { managedPort, webserverHost } from './dashboard-config.js'

// Launch Token：dsh 启动打印 `dsh web: .*?[?&]token=<token>`（Go launchTokenRe）。
const LAUNCH_TOKEN_RE = /dsh web: .*?[?&]token=([A-Za-z0-9_-]+)/

// 捕获 stdout 时的行缓冲：分块到达时拼出完整行再匹配 token。
let lineBuffer = ''
let currentLaunchToken = ''
let cachedCookie = ''
let lastTryAt = 0

/** 记录（或清空）当前 Launch Token；变化即失效已缓存的会话凭据（Go SetCurrentLaunchToken）。 */
export function SetCurrentLaunchToken(token) {
  const trimmed = String(token ?? '').trim()
  if (currentLaunchToken !== trimmed) {
    currentLaunchToken = trimmed
    InvalidateDshSession()
  }
}

export function GetCurrentLaunchToken() {
  return currentLaunchToken
}

/** 清空缓存的会话凭据（Go InvalidateDshSession）。 */
export function InvalidateDshSession() {
  cachedCookie = ''
  lastTryAt = 0
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
    if (m) SetCurrentLaunchToken(m[1])
  }
}

/**
 * 获取（或按需换取）会话凭据。有缓存直接用；无缓存且距上次尝试 <2s 则静默返回
 * 空（Go GetDshSessionCookie 的节流）；否则用当前 token 换取。
 */
export function GetDshSessionCookie() {
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
          if (cookie) cachedCookie = cookie
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
