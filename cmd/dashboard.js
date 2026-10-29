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
import { applyPatches } from './dashboard-patches.js'
import { rotatePanelLog } from './dashboard-logs.js'

const PANEL_LOG = CONSOLE_LOG

function log(line) {
  const text = `[${stamp()}] ${line}`
  console.log(text)
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    // 写之前先看一眼大小：超过 1MB 就把当前这份改名挪走（console.log →
    // console.1.log，最多留 3 片，多出来的最旧一片删掉）。面板每次 append
    // 都重新 open、不持有常驻 fd，所以 rename 安全、原子、不丢行。
    // 放在 try 内：轮转失败也不能连累「把这一行写下来」这件正事。
    rotatePanelLog(PANEL_LOG)
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

  // 只绑回环：面板前方永远有一个 fnOS 网关（Unix socket，见 cmd/proxy.py），
  // 而 dashboard-server.js 的鉴权正是按「只有网关可达」这个前提整段删掉的。
  // 绑 0.0.0.0 会让局域网里任何人直连 :CONSOLE_PORT 调全部管理 API，
  // 等于把那个前提拆了。局域网用 :LAN_PROXY_PORT（28002）直连 dsh，不经这里。
  const PANEL_HOST = '127.0.0.1'
  await new Promise((resolvePromise) => {
    server.listen(CONSOLE_PORT, PANEL_HOST, resolvePromise)
  })

  log(`panel listening on http://${PANEL_HOST}:${CONSOLE_PORT}/ (dsh target port ${listenPort()}) at ${nowIso()}`)

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

  // 补丁自动内置：面板启动即对所有已安装版本应用客户端 bundle 补丁（幂等）。
  // 覆盖「dsh 在面板外已运行、startDsh 走 already 分支不重新打补丁」的场景——
  // 文件先修好，下次 dsh 重启自然生效。startDsh 内部还有一道同款调用。
  try {
    const patches = applyPatches()
    if (!patches.ok) log('client patch partially failed at boot')
  } catch (error) {
    log(`client patch at boot failed: ${error?.message ?? error}`)
  }

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
  // 绑定失败时 error 事件以异步事件到达，listen() 本身不 throw。之前
  // Promise 的 error 分支只 log 不 settle → main() 永久停在 await，
  // 后面的 SIGTERM/SIGINT 注册永远执行不到，面板无法优雅关停。
  // now: reject 让 await 立刻落到 catch，信号处理照常注册。
  await new Promise((resolvePromise, rejectPromise) => {
    lanProxy.once('error', rejectPromise)
    lanProxy.listen(LAN_PROXY_PORT, '0.0.0.0', () => {
      lanProxy.off('error', rejectPromise)
      // 之后的运行期错误（如 accept 失败）只记日志，不能再影响主流程。
      lanProxy.on('error', (error) => {
        log(`lan-proxy on :${LAN_PROXY_PORT} error: ${error.code === 'EADDRINUSE' ? 'port in use' : error.message}`)
      })
      // 「listening」这句必须从绑定成功回调里打，不能落在 catch 之后——
      // 那样端口被占时日志仍然宣称在监听，和真实状态相反。
      log(`lan-proxy listening on http://0.0.0.0:${LAN_PROXY_PORT}/ -> dsh (direct, no /p/ prefix)`)
      resolvePromise()
    })
  }).catch((error) => {
    // 兜底 error 监听必须保留：解绑 rejectPromise 后再出错会变 unhandled 'error'。
    lanProxy.on('error', () => { /* runtime accept errors are non-fatal */ })
    log(`lan-proxy failed to bind :${LAN_PROXY_PORT}: ${error?.message ?? error}`)
  })

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
