#!/usr/bin/env node
/**
 * Panel entrypoint. Started by the fnOS lifecycle script and by `npm start`.
 *
 * It deliberately does as little as possible: bind the port, log where it is,
 * and hand control to the server module. Anything that can fail at boot is
 * reported on stdout so the suite's log has something to show.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { CONSOLE_PORT, LAN_PROXY_PORT, DATA_DIR, nowIso, stamp } from './dashboard-utils.js'
import { CONSOLE_LOG } from './dashboard-config.js'
import { createConsoleServer, createLanProxyServer, closeAllWebSockets, StartWebSocketHeartbeat } from './dashboard-server.js'
import { listenPort, StartWatchdog, startDsh } from './dashboard-process.js'
import { StartUsageSampler } from './dashboard-usage.js'
import { GetLastRunState, StatusRunning, StatusStarting } from './dashboard-state.js'

const PANEL_LOG = CONSOLE_LOG

function log(line) {
  const text = `[${stamp()}] ${line}`
  console.log(text)
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(PANEL_LOG, `${text}\n`)
  } catch { /* a read-only data dir must not stop the panel */ }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })
  const server = createConsoleServer()

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log(`port ${CONSOLE_PORT} already in use; another panel is probably running`)
    } else {
      log(`server error: ${error.message}`)
    }
    process.exit(1)
  })

  await new Promise((resolvePromise) => {
    server.listen(CONSOLE_PORT, '0.0.0.0', resolvePromise)
  })

  log(`panel listening on http://0.0.0.0:${CONSOLE_PORT}/ (dsh target port ${listenPort()}) at ${nowIso()}`)

  // Supervise dsh: a 1s watchdog adopts orphaned children and clears stale
  // "running" state when the process dies, so the panel never reports a
  // process that is actually gone.
  StartWatchdog()

  // Ping idle push sockets and reap dead ones, so a long uptime cannot
  // accumulate sockets for browsers that went away without a FIN.
  StartWebSocketHeartbeat()

  // A last-resort net. Every real work path is already guarded individually;
  // this only catches a genuinely unexpected throw, and it must NOT exit —
  // this process is the dsh supervisor, so dying here would take down the very
  // service the user is trying to reach. Log loudly and keep going; the
  // watchdog self-heals the actual dsh process.
  process.on('uncaughtException', (error) => {
    log(`uncaughtException: ${error?.stack ?? error}`)
  })
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason?.stack ?? reason}`)
  })

  // 采样 dsh 进程树 CPU/内存（无订阅者时 0 成本空转，对齐 Go 版 StartUsageSampler）。
  StartUsageSampler()

  // 按上次运行状态自启（对齐 Go 版 InitHarness 的 GetLastRunState 分支）：
  // 面板重启前若 dsh 在 running/starting，则自动拉起，否则跳过。
  const last = GetLastRunState()
  if (last === StatusRunning || last === StatusStarting) {
    log(`恢复上次运行状态 (${last})，自动拉起 dsh`)
    startDsh().then((result) => {
      if (!result.ok) log(`自启失败: ${result.error ?? 'unknown'}`)
    })
  } else {
    log(`上次运行状态为 ${last}，跳过自启`)
  }

  // Dedicated LAN proxy: a second listener on :28002 that only forwards to dsh,
  // so a same-network client can open http://<NAS-IP>:28002 and land straight in
  // the suite. Best-effort: if the port is taken, the panel must still run.
  const lanProxy = createLanProxyServer()
  lanProxy.on('error', (error) => {
    log(`lan-proxy on :${LAN_PROXY_PORT} error: ${error.code === 'EADDRINUSE' ? 'port in use' : error.message}`)
  })
  try {
    await new Promise((resolvePromise) => {
      lanProxy.listen(LAN_PROXY_PORT, '0.0.0.0', resolvePromise)
    })
    log(`lan-proxy listening on http://0.0.0.0:${LAN_PROXY_PORT}/ -> dsh (direct, no /p/ prefix)`)
  } catch (error) {
    log(`lan-proxy failed to bind :${LAN_PROXY_PORT}: ${error?.message ?? error}`)
  }

  const shutdown = (signal) => {
    log(`received ${signal}; closing`)
    // Drop push sockets first: the browser is waiting on them, and holding
    // them open through the close window only produces reconnect storms.
    closeAllWebSockets()
    lanProxy.close(() => {})
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  log(`fatal: ${error?.stack ?? error}`)
  process.exit(1)
})
