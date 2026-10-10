# Changelog

## v1.0.31 - 2026-10-10

### 修复

- 面板反代回给浏览器的 101 握手不再重复发送 `Connection`/`Upgrade`。上游 Node 返回的头是小写，反代又补了一份大写，同名头出现两次；浏览器据此判定握手非法、丢弃 socket 并循环重试 `connection lost, retry #1..#4`。服务端口志全程记录 101，因此该故障此前完全不可见。现在按头名去重写出，且仅在上游缺失时才补。
- 影响 1.0.29/1.0.30 的全部入口：局域网直连 `:28000`、面板 `/p/` 反代，以及经 fnOS 网关 `5666` 的 `app/fnos-dsh-manager/p/`。

### 验证

- smoke 新增 WS 反代覆盖：stub 的 upgrade handler 刻意用小写头（Node 的真实行为），断言握手成功、`connection`/`upgrade`/`sec-websocket-protocol` 各只出现一次、accept key 与子协议原样保留、隧道能带回上游帧、上游拒绝升级时不得伪装成 101。
## v1.0.30 — 2026-10-10

### 新增

- **「补丁」面板：把 dsh settings 的 host-mode 判定强制改为 `host`**
  局域网通过面板访问 dsh 时，插件与模型设置整页空白，根因在 dsh 自己的客户端 bundle：
  `dsh-client-ui-settings/lib/client.js` 里有一行
  `const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";`
  而 `$host.isLoopback` 是**浏览器端**根据 `location.hostname` 判定的
  （`dsh-client-connection` 的 `installConnection()`：
  `transport?.ownsHost === true || isLoopbackHostname(pageLocation.hostname)`），
  所以 `10.11.12.13:5666` 必然为 `false`，dsh 判定你不是本机 → 设置落回内存 → 刷新即丢、页面读不到。
  反代改不动这个值（它在浏览器里算），所以只能改 bundle。

  新增 `cmd/dashboard-patches.js`，只做这一件事：
  - 扫 `VERSIONS_DIR` 下**所有**含 `node_modules/@deepseek-ai` 的版本目录
    （面板支持多版本切换，只补 `current` 一切换就掉）
  - 对 `dsh-client-ui-settings/lib/client.js` 与 `dsh-client-ui-settings-models/lib/client.js`
    把 `[\w.$]+\.isLoopback \? "host" : "memory"` 替换为 `"host"`
  - 首行写入 marker `/* dsh-console: settings host-mode patch */` 作为幂等锚点与溯源依据
  - 状态机 `already` / `pending` / `missing` / `error`：
    `missing` = 上游已不需要此补丁（dsh 自己改了写法），此时面板**不报错**，
    只是显示「上游已不需要」；重复应用是 no-op，不会叠补丁。

  面板侧：新增 `GET /api/patches`（只读上报）与 `POST /api/patches/apply`
  （应用后 `await restartDsh()`，因为 bundle 是 dsh 启动时读进内存的，不重启不生效），
  UI 新增「🩹 补丁」标签页，逐版本逐文件列出状态，一个按钮完成应用与重启。

  **代价（写进代码注释，别当成无害改动）**：这等于解除了 dsh 有意的回环限制，
  把「哪些前端算本机」的信任面从 dsh 内部搬到面板围栏上。

## v1.0.29 — 2026-10-10

### 修复

- **dsh web「模型加载不出 → 断开连接」（P0，本条是真正的根因）**
  浏览器 Console 一直报：
  `ws://.../p/api/remote.mux  WebSocket is closed before the connection is established`
  加上 `GET /p/plugins/events  502 (Bad Gateway)`。
  根因是**面板的反代根本没有 WebSocket 通路**，两处都漏了：
  - `proxyToDsh()` 把 `upgrade` / `connection` 当成逐跳头删掉了。升级请求的握手头必须原样送上游，
    剥掉之后 dsh 把它当成普通 HTTP 请求，路由不匹配 → 404。
  - 更根本的是：升级请求**不会进普通 HTTP handler**，Node 把它单独派发到 `server.on('upgrade')`，
    而 `createConsoleServer()` 的 upgrade 监听器只放行 `/ws`（面板自己的推送通道），
    其余一律 `HTTP/1.1 404` + destroy；`createLanProxyServer()` 更是**压根没有 upgrade 监听器**，
    Node 默认直接销毁 socket（连接被静默关闭，没有任何响应）。
    所以即使把 `proxyToDsh()` 的头修好，WS 也依然连不上——必须在 upgrade 事件里做 socket 级转发。

  新增 `proxyUpgradeToDsh(request, socket, head, { pathPrefix })`：完成上游握手后把 101 响应头原样回写
  （跳过 `transfer-encoding`，补 `Connection` / `Upgrade`），两端 `setNoDelay(true)` + `setTimeout(0)`
  （继承的 socket 超时会把长期空闲的隧道掐断），双向 pipe 并互相关联 error。
  上游以普通响应拒绝升级时（401 / 404 / 400）原样把状态码回给客户端，不假装成功。
  对照物是同项目的 `cmd/proxy.py`——它早就显式重建 `Connection: Upgrade` 并把 socket timeout
  设回阻塞模式，作者懂 WS，只是 `dashboard-server.js` 漏了这条路径。

- **dsh 的 `webserver` 覆盖彻底移除，dsh 原封不动（P1）**
  过去每次启动前 `applyLanBinding()` 都会整体重写 `- id: webserver` 块（host + port），
  这有三个问题：
  1. `webserver.host` 的 schema 在 dsh 各版本之间**不相交**（<= 0.2.1-alpha.1 只收
     `"127.0.0.1" | "0.0.0.0"`，>= 0.2.1-alpha.2 只收具体 IP 字面量且直接拒通配），
     这个覆盖因此成了**换版本时必须手工迁移的遗留物**。
  2. 它锁死端口，跟 dsh 自己的默认值打架——面板把 dsh 从 3080 拽到了 28000，
     一旦面板重启而 dsh 独立存活，端口就对不上。
  3. 它是「dsh 起来就白屏 / 连不上」的经典诱因，且失败信息只落在没人打开的日志里。

  现在 `applyLanBinding()` 只做清理（删掉历史版本可能写下的 webserver 块）。
  **dsh 永远只听自己的原生默认值 `127.0.0.1:3080`，只信任本机，一行配置都不用改**，
  切换任意 dsh 版本都不需要任何配置迁移。

- **局域网直连入口从 :28002 改到 :28000**
  直连口是一个**带 token 的入口**：监听 `0.0.0.0`，转发时把面板刚换到的启动 token
  （`dsh.log` 末行 `dsh web: http://127.0.0.1:3080/?token=...`）换成 `dsh-auth-*`
  会话 cookie 注入上游（dashboard-session.js），所以内网客户端打开
  `http://<NAS-IP>:28000/` **免 token 直达 dsh**，而 dsh 本身仍然只信任回环——
  等价于「我就是 `127.0.0.1:3080/tokenxxx` 在访问」。
  端口号沿用历史直连入口；面板自己的 :28001 不受影响。

### 变更

- **面板 :28001 不动**（路由、端口、UI 全不变）。LAN 访问仍走 `:28001/p/`（有访问记录）
  或 `:28000`（免 token 直连）。
- **设置页移除「LAN 直连 dsh / LAN 绑定地址」**：dsh 恒为回环绑定，该选项已无实际作用，
  留着只会让人以为「开了就等于让 dsh 绑网卡」。`lanBind` 保留为 `false` 供旧配置兼容。

## v1.0.28 — 2026-10-10

按用户实机反馈修复四个问题：**首屏白屏十几秒**、**面板版本显示 v0.0.0**、
**dsh web 页面频繁重连**、**终端无法运行**。

### 修复

- **首屏白屏：首帧没有任何内容（P1）**
  `#view` 在 `index.html` 里是**完全空的**。而 `app.js` 是 module（天然 defer），
  首屏渲染还要 `await /api/status`，所以从浏览器画出外壳到内容出现之间存在一段
 真空期——经 fnOS 网关时被拉长到肉眼可见的程度，观感就是「白屏十几秒」。
  现在占位内容直接写进 `index.html`：**第一帧就有东西可画，不依赖任何脚本**，
  `boot()` 完成后整体替换。骨架屏颜色全部取自现有主题变量，
  断点与 `.metric-grid` 的860px 对齐（避免切换时列数跳动），
  并尊重 `prefers-reduced-motion`。

- **面板版本显示 `v0.0.0`（P1）**
  `manifestInfo().version` 读不到 manifest 时回落到 `'0.0.0'`，界面上就是一个
  光秃秃的徽章，**没有任何报错**。根因是路径不一致：面板默认
  `MANIFEST=/var/apps/{appname}/manifest`，但 fnOS 上`/var/apps/{appname}`
  只是一个**软链**，manifest 实体在 `TRIM_APPDEST`
  （`/vol{n}/@appcenter/{appname}`）下——而 `cmd/main` 传了 `TRIM_APPDEST`
  却**从未 export `MANIFEST`**。已验证：默认路径 ENOENT → `{}` → `0.0.0`；
  正确路径 → 解析出真实版本。
  修法：`cmd/main` 显式传 `MANIFEST`；`readManifest` 读不到时**打印一次告警**
  （含真实路径与 errno），下次再犯看一眼日志就知道。
  关键教训：**smoke 测试也没传 `MANIFEST`**，所以这个问题在测试里根本测不出来，
  现在补上了。

- **dsh web 页面频繁重连（P1）**
  `proxy.py` 里`socket.create_connection(BACKEND, timeout=30)` 设置的 socket
  超时**会一直附着在这个 socket 上**，作用于之后所有的 `recv`/`send`。
  而 `_relay()` 正是用 `recv()` 等下一帧的——WebSocket 空闲 30 秒完全正常
  （面板 15s 轮询一次、或用户只是停在页面上）。于是每次空闲满 30 秒 `recv`
  就抛 `socket.timeout`，被 `except: pass` 吞掉，紧接着 `finally` 的
  `shutdown(SHUT_WR)` 把连接关掉。**前端表现为反复重连，日志里却什么都看不到**，
  因为那个超时被当成了正常结束。
  修法：`_relay()` 开头把两个 socket 都 `settimeout(None)` 切回阻塞模式。
  协议保活交给心跳（面板每 30s ping），不该用读超时去代替。

- **终端无法运行（P1）**
  面板是被 `nohup` 拉起的守护进程，**没有控制终端**，所以 `TERM` 压根不存在。
  node-pty 会把 `undefined` 传给终端初始化程序，terminfo 查找随之失败，
  表现为终端一进去就异常。现显式设置 `TERM=xterm-256color`，
  并补上参考实现同样设置的 `CI=true` 与 `DSH_AGENTS_HOME`。

- **「打开文件夹」没有调用 fnOS 文件管理器**
  原实现只查 `window.trimSdk || window.parent?.trimSdk`，而 fnOS 注入 SDK 的位置
  随版本/嵌套深度而变，多一层 iframe 就找不到，于是**静默退化成复制路径**，
  看起来像"点了没反应"。现在沿父窗口链上溯最多 6 层查找；
  兜底分支的提示也改诚实了——原来在"没打开"之后紧跟一句"路径已复制"，
  会让人以为两步都成功了。

### 门禁

- **`check.mjs` 新增 Python 与Shell 语法检查**：`cmd/proxy.py` 和
  `cmd/*` 这些脚本属于交付物，但 `targets` 只收集 `.js/.mjs`——也就是说
  **改`proxy.py` 完全不受任何检查**，语法错误只会在装机时表现为"桌面图标点不开"。
  现在 `bash -n` 校验 8 个生命周期脚本、`py_compile` 校验 proxy.py；
  解释器缺失或因环境限制无法 spawn 时**明确打印 SKIP 原因**，不静默放过。
  （本机沙箱对非 node 程序 `spawnSync` 一律 `EBUSY`，已实测同一段 `py_compile`
  在 bash 下能正确捕获 `SyntaxError`，逻辑本身有效，NAS 上会正常执行。）

### 测试

- `smoke.mjs` 57 → **59 项**：断言面板版本不是 `0.0.0`、且与随包 manifest 一致；
  并给测试进程补上 `MANIFEST`（此前缺失，正是版本问题测不出来的原因）。
  已验证：把 `MANIFEST` 去掉立刻 FAIL 57/59 并明确指出「manifest not read?」。

## v1.0.27 — 2026-10-10

**改名 `fnos-dsh-manager`，并修复「实时刷新无效」与首页版本号显示。**

### 改名

- **套件改名为 `fnos-dsh-manager`**（含 `appname`，即安装路径、网关前缀、数据目录
  一并改变）。`manifest` / `package.json` / `ui/config` / `app/ui/config` / 桌面图标
  入口 / 代码内日志前缀全部同步；显示名改为「DSH 管理器」。
- **旧数据自动迁移**：改名会让 fnOS 启用新的 `@appdata/fnos-dsh-manager` 目录，
  原本存在于 `@appdata/dsh-console` 的配置、已下载的 dsh 版本、凭据（600 权限）、
  工作区会看起来「消失」。`install_callback` 现在会检测旧目录，
  **仅在新目录为空时**用 `cp -an` 搬过来（`-n` 不覆盖），并保留权限。
  新目录已有内容则完全不搬，避免把用户在改名后新配的设置覆盖回旧值。
  重复安装安全。凭据的 600 权限是 dsh 启动的硬性要求，所以权限必须一起搬。

### 修复

- **实时刷新无效、要手动刷新（P1）**：`index.html` 的 `#app` 一直带 `hidden`
  属性，而**没有任何代码移除它**。这个属性在视觉上是空操作
  （`.shell { display: flex }` 的优先级高于 UA 的 `[hidden] { display: none }`），
  所以页面看起来完全正常——这也正是它一直没被发现的原因。但 JS 读
  `element.hidden` 恒为 `true`，而两条实时更新路径都判断了它：
  15秒轮询的 `if (... && !app.hidden) renderTab()` 永远不成立，
  WebSocket 处理器的 `if (app.hidden) return` 第一行就返回，
  **所有推送事件被静默丢弃**。只有手动点「刷新」才有效，因为它直接调`renderTab()`。
  现移除该属性，并把判断改为真实的 `document.visibilityState`
  ——只有标签页切到后台才停止重绘。后者不可能像 HTML 属性一样被遗忘。

- **`boot()` 失败会白屏**：`boot()` 是即发即忘的，首屏渲染一旦抛错就是
  unhandled rejection，页面只剩空白、控制台里一条错误——正是「白屏无内容」。
  现在捕获它并把原因显示在页面上；`#refresh` 的事件绑定也改为可选链，
  元素缺失不再连带整个模块失败。

- **首页版本号同步**：顶部标题旁原先显示的是 **dsh 本体版本**，
  与「管理器版本」混淆。现标题旁显示**管理器版本**（`v<面板版本>`），
  并在状态卡新增一行显示**正在运行的 DeepSeek Harness 版本 + 端口**——
  这样从「版本」页升级 dsh 后能立刻看出变化。

### 测试

- `smoke.mjs` 54 → **57 项**：断言 `#app` 不带 `hidden`、`app.js` 不再读
  `app.hidden`、且确实使用 `visibilityState`。已验证把 `hidden` 加回去会被当场拦下。

## v1.0.26 — 2026-10-10

**修「dsh 启动成功但打不开后端 web」。** 根因有四处，都不是表面症状。

### 根因

- **传给 dsh 的参数里有它不认识的 `--trusted-host`（主因）**
  `buildArgs()` 之前会追加 `--trusted-host <h1> <h2> ... <hN>`。核对
  `@deepseek-ai/dsh` 0.2.0-rc.2 的真实CLI（`lib/bin.js`）后确认：dsh 只有六个
  option（`--profile` / `--patch` / `--from-default-profile` / `--dump-config` /
  `--dump-config-schema` / `--dump-default-config`），**根本没有 `--trusted-host`**。
  而 `parseDshArgs` 走commander 的 `allowUnknownOption()` + 位置参数 `[args...]`，
  于是这个 flag **连同它后面所有主机名**一起掉进 profile app 的 argv。
  web profile 并不认识这些参数，dsh 要么校验失败、要么带着一条被污染的命令行启动，
  结果就是「进程起来了但 web 打不开」。参考实现
  `yuexps/deepseek.harness.fnos` 的 `harness.go:453` 只传
  `web --port N --no-open`，没有任何 host 参数——受信主机本来就走
  `${DSH_HOME}/trusted_hosts.conf` 这条文件路径，不需要也不能靠命令行传。

- **少传 `--no-open`**：参考实现传了它。无头的 NAS 上 dsh 会尝试拉起浏览器；
  该flag 同样落在 `[args...]` 里，属于 profile app 认识的参数。现已补上。

- **启动前没写 `webserver` patch**：`applyLanBinding()`原先只在
  `/api/service/*` 路由里调用。面板自己的「按上次状态自启」等路径绕过了它，
  于是 dsh 可能带着过期的/缺失的 patch 启动——一旦如此，dsh 会退回自己的内置
  默认值（回环 + 3080），而面板一直去探测 28000，UI 就永远停在「启动中」。
  现在 `startDsh()` 自己在 spawn 前写一次，所有启动路径都被覆盖。

- **HTML 反代注入把 Buffer 当字符串用（这条让页面全白/报错）**
  `injectManifestCredentials()` 对 `injectDshHtml()` 的返回值直接调`.replace()`，
  而后者返回的是 **Buffer**——Buffer 没有 `.replace`。这在响应流的 `end`
  处理器里抛 `TypeError`，属于 uncaughtException，于是**每一个经面板反代的
  HTML 页面都直接失败**（面板靠上一轮加的进程级兜底才没有整体崩溃）。
  现按 UTF-8 文本处理再重新编码；没有 manifest 标签时**原样返回原 Buffer**，
  避免无谓的重新编码破坏非法 UTF-8 字节。注入是便利性补丁（特权声明 + 隐藏按钮），
  不是正确性前提，所以外层再包一层try/catch——失败时降级为「原样转发页面」。

### 诊断能力

- **dsh 启动失败的真实原因现在直接显示在面板上**：原先 dsh 的 stderr 直接写进
  日志文件，坏 flag / schema 不匹配 / 插件缺失这些原因只有翻日志才看得见，
  而 UI 只会显示「已停止」。现在 stderr 走 pipe（仍然原样tee 进同一个日志文件），
  提取关键行写进状态机 `lastMessage`，并在 `child.on('exit')` 里**快速失败**，
  不再拿一个死进程去轮询满 300 秒。实测输出示例：
  `dsh 启动即退出（code=1）：error: unknown option '--trusted-host'`。

- **就绪探测加固**：回环优先（`127.0.0.1` 恒为首选目标，参考实现同样硬编码回环），
  并加入 TCP 兜底——dsh 端口已监听但 HTTP 还没起来时也算「已就绪」，
  交由上层如实报出 HTTP 错误，而不是空转到 300s 超时后误报「启动失败」。

- **健康状态不再抖动**：此前缓存了失败的探测结果，导致一个正常服务的
  `healthy` 在 true/false 之间反复跳（实测 t+1s true、t+3s false、t+7s true，
  而直连一直是 200），UI 上表现为「运行中」与「启动中」闪烁。现在**只缓存成功**：
  正常服务仍享受 1.5s 一次的探测节流，而「未就绪」会重新探测——那恰恰是
  连接立即被拒、代价极低且答案最新鲜的时候。

### 测试

- **`smoke.mjs` 48 → 54 项**：stub 现在会返回**真正的 HTML**（含中文、manifest
  link、`data-slot`）。此前 stub 一律返回 `text/plain`，导致整条 HTML 注入路径
  **零覆盖**——这正是 Buffer bug 能一路发布的原因。新增断言覆盖：HTML 页面可
  服务、manifest 被注入 crossorigin、`__DSH_TRANSPORT__` shim 就位、上游正文
  与多字节中文未被破坏、面板在反代 HTML 后仍存活。已验证：把Buffer bug 注回去，
  测试立刻掉到 52/54 并指认具体失败项。

## v1.0.25 — 2026-10-10

健壮性与性能修复版。修掉一个「打开面板即崩溃」的致命缺陷、一个配置静默失效的缺陷，
并把高频路径上的同步阻塞开销降下来。

### 致命缺陷

- **修复打开面板网页导致面板进程崩溃（P0）**：`acceptWebSocket()` 里写的是
  `crypto.createHash('sha1')`，但本文件只`import { createHash } from 'node:crypto'`。
  Node 虽有全局 `crypto`，但那是 **WebCrypto**（`subtle`/`getRandomValues`/`randomUUID`），
  并没有 `createHash`（那是 `node:crypto` 的 API）→ 握手时抛
  `TypeError: crypto.createHash is not a function`。该调用发生在 HTTP `upgrade`
  事件里且无 try/catch，全项目也没有 `uncaughtException` 兜底，于是**整个面板进程退出**；
  而 `ui/assets/app.js` 在加载时无条件调用 `ws()`，两者叠加的结果是
  **用户点开面板 → 面板立刻死掉 → 网关 Bad Gateway**。
  现改为调用已导入的 `createHash`，并在 `upgrade` 监听器与握手函数内各加一层
  try/catch，另加进程级 `uncaughtException`/`unhandledRejection` 兜底（只记录不退出：
  这个进程是 dsh 的监督者，退出等于把用户想访问的服务一起带走）。

### 配置缺陷

- **修复安装时写出的 `console-config.json` 永远读不到（P2）**：`install_callback` 生成的
  配置里带 `//` 中文注释，而 `loadConfig()` 用裸 `JSON.parse` → 解析失败被 `catch` 吞掉后
  静默回落 `DEFAULTS`，用户安装时设置的 `lanBind` / npm 代理 / 快捷入口**全部丢失且无任何报错**。
  两处同时修：`install_callback` 改为写出严格 JSON（注释留在 shell 里）并在写完后立刻自检、
  把结果记进安装日志；`loadConfig()` 改用容错解析（剥离 `//`、`/* */` 与尾逗号，且尊重字符串
  字面量里的 `//`），无法解析时把原因记进 `__parseError`，并在诊断页以 `fail` 明确报出。

### 健壮性

- **WebSocket 实现加固**：修正帧解析丢弃残帧的问题（原实现无法处理跨 TCP 读到达的帧，
  大于一个 MTU 的帧会被静默吞掉）；新增 RSV 位校验、分片控制帧拒绝、未掩码客户端帧拒绝、
  64KB 单帧上限、16 客户端上限（超限回 503 且在握手前判定）、30s ping 心跳与 90s 空闲回收，
  慢客户端连续丢帧 8 次后主动断开。`Sec-WebSocket-Key` 现在按 RFC6455 校验格式——
  之前任何带该头的 HTTP 客户端都能拿到 `101`。
- **诊断表格首列不再空白**：接口返回 `label`，UI 读的是 `c.name`，导致「运行检查」表格的
  检查项列全是空的。现统一读 `label`（兼容 `name`），并补上此前被丢弃的 `fix` 提示字段。

### 性能与资源占用

- **`listInstalledVersions()` 结果缓存 + 体积改为按需计算**：该函数被 `/api/status`、
  `/api/versions`、`/api/logs`、设置页同时调用，且每次都对每个版本目录做一次全递归
  `dirSize()`。实测 1000 文件时**单次 130ms 的同步阻塞**（真实 dsh 安装体量远大于此），
  会连带阻塞事件循环、watchdog 与所有推送。改为按 `VERSIONS_DIR` 指纹缓存目录列表、
  把体积测量移出热路径只在该视图计算后，**降到 0.2ms（约 300倍）**；`dirSize()` 本身也改为
  用 dirent 判断目录、对符号链接不再跟随（避免 NAS 上指向父目录的软链导致不终止）。
- **端口探测不再每秒 fork `ss -ltnp`**：watchdog 每秒调用一次，而原实现用 `execFileSync`
  起子进程——同步阻塞单线程，且是 NAS 空闲时最贵的动作之一。改为读 `/proc/net/tcp{,6}`
  取监听 socket 的 inode，再用 `/proc/<pid>/fd` 反查属主 pid，并加 750ms 结果缓存；
  `/proc` 不可用时自动回落到原来的 `ss`/`fuser` 路径（且回落也带缓存，不会每调用一次 fork 一次）。
  解析逻辑已用真实 `/proc/net/tcp` 行格式验证（含「仅 ESTABLISHED 的连接不得被当成监听」）。
- **健康探测结果缓存**：`probeHealth()` 在 `/api/status` 每次轮询时都发起真实 HTTP 请求，
  而 dsh 停止时每个不可达目标要耗满 3s 超时——一次状态请求最坏阻塞 9 秒。改为 1.5s 缓存 +
  单目标超时降到 1.5s，启动/重启等待路径强制取新鲜结果。
- **`lanAddresses()` 与 `discoverNodeBins()` 加缓存**：前者被信任栅栏在**每个请求**上调用，
  后者每个候选 node 要 fork 一次 `node -v`（经 `bestNodeBin()` → `dshStatus()` → 每个
  `/api/status`）。分别按 5s / 60s 缓存，并提供 `invalidateLanCache()`、
  `invalidateNodeScan()` 供环境变更后主动失效。
- **访问日志统计改为 O(1) 复用**：`accessLogStats()` 原先每次状态轮询都整读文件只为数行数，
  现按 (size, mtime) 缓存并改为数换行符，避免为一次计数分配每条记录一个字符串。

### 测试与清理

- **`smoke.mjs` 35 → 48 项**：补齐 `/ws` 握手完成、socket 保持、第二连接、**面板在握手后
  仍存活**（这条才是关键）、畸形握手被拒且面板存活；诊断字段断言（`label`/`status`）；
  带注释配置能解析且设置不丢失。`/ws` 此前**一条断言都没有**，这正是致命缺陷能发版的原因。
- **`check.mjs` 新增 crypto 误用门禁**：剥离注释与字符串字面量后扫描 `crypto.<helper>(` 调用，
  凡 `node:crypto` 独有、而全局 WebCrypto 没有的helper（`createHash`/`createHmac`/`randomBytes`/
  `timingSafeEqual` 等）一律报错并使退出码非 0。已验证：把原缺陷注回去能被当场拦下。
  匹配前必须剥离注释——文件自身的注释里就写着「`crypto.createHash` here threw」，
  不剥离会把说明文字当成真实调用点。
- **`check.mjs` 修复 Windows 上整门失效**：`node --check` 密集spawn 在 Windows 上会成片
  `EBUSY`，`npm run check` 曾报出大量假的 SYNTAX 失败。现把 `EBUSY/ENOENT/EPERM/EACCES`
  且不含 `SyntaxError` 的结果判为环境冲突并跳过，不计入失败。
- **移除死代码**：`hashPassword` / `randomToken` / `safeEqual` / `writeCredentials` /
  `pinnedFingerprint` / `getActiveDshPid`（v1.0.20 移除密码认证后的残留），
  以及无人调用的 `recordLogin` 写入路径（读取路径保留，以便老安装的历史记录仍可查）。
- 模块级缓存变量 `cached` 更名为 `configCache`：新增的版本缓存曾误用同名变量导致
  `/api/versions` 500，改名以消除这类混淆。

## v1.0.24 — 2026-10-11

- **反代会话代持对齐 Go 版**：新增 `dashboard-session.js`，捕获 dsh stdout 的 Launch Token
  （`dsh web: ...?token=…`），用 token 换取 `dsh-auth-*` Cookie 并在反代转发时注入（剥离客户端
  旧凭据）。**替代**旧版直接 patch 上游 `isAuthenticated` 的方案——patch 会在 dsh 升级导致源码
  字符串不匹配时静默失效（token gate 恢复 → 反代 401），代持不碰上游代码，升级安全。
- **修复「HTML did not preload client.js」**：`/plugins/??` 问号还原逻辑反转——旧版对完好的
  `??` 也补 `?` 变成 `???` 导致 404。现对齐 Go 版 `!HasPrefix(RawQuery, "?")` 判断，只在被折叠
  成单 `?` 时才还原。
- **HTML 注入 manifest `crossorigin="use-credentials"`**：让网关照旧 Cookie 正确携带 manifest 请求。
- **修复侧栏折叠箭头被裁**：上一版为消滚动条把 `.sider` 改成 `overflow:hidden`，把 `right:-13px`
  伸出的箭头裁掉一半；现恢复 `overflow:visible`（内容不溢出），并给 `.main` 补 `z-index` 层叠。

## v1.0.23 — 2026-10-11

- **反代完整对齐 Go 版 fngateway**：`proxyToDsh` 重写为 Go 版 Rewrite/ModifyResponse 移植——
  改写回环 Origin、`Sec-Fetch-Site: same-origin`、`Accept-Encoding: identity`，HTML 注入
  `__DSH_TRANSPORT__.ownsHost` 补丁 + 移除 CSP + 强禁缓存，SSE 流式直通，Location 剥回环
  主机，`/plugins/??` 问号还原。根治「数据无法访问」（特权 API 403、插件配置面板空白）。
- **dsh 启动注入 `SSH_CONNECTION`**：标记远程无头环境，关闭本地桌面应用探测（会话头部的
  「在 Zed 中打开」等分体按钮不再出现）。
- **修复 nologin 账户终端不可用**：`panelIdentity()` 解析 /etc/passwd 的登录 shell，spawn 时
  注入 `SHELL` 环境变量绕过 nologin，让 dsh 内置终端可用。
- **修复侧栏滚动条**：`.sider` 由 `overflow-y:auto` 改为 `overflow:hidden`，侧栏内容自适应
  视口不再滚动；菜单项紧凑化。
- **修复主页面板信息卡滚动条**：`.view.overview-view` 去掉 flex 嵌套滚动，恢复自然文档流
  统一滚动；紧凑化 hero-card / 指标卡 / 分隔线 / 节标题，尽量一屏放下全部信息。

## v1.0.22 — 2026-10-11

- **工作区「打开文件夹」调 fnOS 文件管理器**：新增「打开文件夹」按钮，调 fnOS 网关注入的
  `trimSdk.openFileManager(path)` 直接定位目录（对齐 Go 版 Workspace.vue）；非网关环境或
  SDK 缺失时自动回退到复制路径。
- **移除「文件授权」选项卡**：删除 `/api/files` 路由、`dashboard-files.js`、`files.js` 视图，
  侧栏菜单去掉「文件授权」项（fnOS 统一网关已处理授权，面板不再重复展示）。
- **修复侧栏折叠箭头适配**：箭头 `right: -13px` 伸出被 `.shell overflow:hidden` 裁剪，改为
  `overflow-x: visible` + 主区 `position: relative` + 箭头 `z-index` 提升并加投影。
- **概览页去掉整页滚动条**：概览页改用自适应视口布局（状态卡固定、面板信息卡在剩余空间内
  自行滚动），不再产生整页滚动条。

## v1.0.21 — 2026-10-11

- **概览页收敛为单页**：运行控制 4 按钮融入状态卡底部按钮栏（停止/启动/重启/打开面板
  入口/版本管理），「进入 Harness」按钮改为 **dsh 状态颜色指示灯**（五态颜色：运行中绿、
  启动中/部署中/快照中黄、已停止红），面板信息卡（安装/面板/最近访问）上移，与状态卡
  同屏显示全部信息。
- **侧栏靠边折叠**：侧栏右缘新增折叠箭头，点击收起为窄条（靠边）、再点展开，折叠状态
  持久化到 localStorage。
- **新增 NAS dsh 全功能体检脚本** `scripts/check-dsh.sh`：逐项体检面板进程/端口、node
  运行时、dsh 安装与二进制、**dsh 用户读配置/工作目录权限（重点）**、凭据 600 权限、
  webserver 补丁、端口占用、dsh 进程树、面板 API 直连探测。支持 `--fix` 对能安全修复的
  权限/属主项自动修复，结尾给 PASS/WARN/FAIL 汇总与退出码。

## v1.0.20 — 2026-10-11

- **修复 dsh 启动 `spawn EPERM`（关键）**：上一版给 spawn 加了 `uid/gid` 试图 setuid 到独立
  `dsh` 账号，但面板以 fnOS「管理器」账号运行（非 root、无 `CAP_SETUID`），`setuid` 被内核
  拒绝 → `spawn EPERM`，且与自启形成「chown → EPERM → 自启 → chown …」死循环。现去掉
  spawn 的 `uid/gid`，dsh 改以面板自身身份运行，主目录 chown 回面板自身属主（`panelIdentity`），
  彻底对齐 Go 版 `process.go` 只设 `Setpgid`、从不 setuid 的模型。原先被误 chown 成独立账号
  属主的主目录会在启动自愈时自动改回正确属主。

## v1.0.19 — 2026-10-11

- **移除面板自身密钥验证**：面板不再要求 `x-console-key` / 会话 cookie，改走 fnOS
  统一网关自带鉴权（对齐 Go 版 `proxy.go` 里 `AccessPassword == ""` 时直接放行的模型）。
  仅保留 Host/Origin trust fence（`dashboard-trust.js`）作为防 DNS rebinding / CSRF 的
  边界，而非鉴权层。删除登录页、logout 按钮、session 管理、失败限流与 `consolePassword()`
  （该函数原误读 `DEEPSEEK_API_KEY` —— 那是 dsh 自用的密钥，不是面板密码）。
- **概览页对齐 Go 版布局**：侧边栏（品牌卡 + 主导航 + 底部分隔设置项）+ 页头核心大卡片
  （应用名 + 版本 + 「进入 Harness」大按钮 + 5 列指标网格：运行状态/运行时间/PID/CPU/内存）
  + 运行控制动作卡（启动或停止/重启/打开面板入口/版本管理）+ 底部 last_message 状态通知
  + 面板信息卡（安装/面板/最近访问）。配色/圆角/阴影沿用 Go 版 theme.ts。

## v1.0.18 — 2026-10-11

- **进程监督层对齐 Go 版可靠性**：dsh 以 `detached` 拉起成为进程组组长，停止改为
  三段式（SIGTERM 进程组 → 3s 轮询 → SIGKILL 进程组），并清扫端口残留、等待端口真正
  释放，根治「孤儿子进程占端口 → 下次启动 EADDRINUSE」。
- **看门狗巡检自愈**：每秒巡检，托管进程死亡但端口仍有 dsh 子进程时自动接管
  （`adoptedPid`）；连续 3 次确认死亡则清掉 pid 文件与状态，UI 不再对已死进程谎报
  「运行中」。
- **显式五态状态机**：`stopped / starting / running / building / snapshotting` 五态
  （对齐 Go 版 `HarnessState`），启动时「启动中」→ 端口就绪翻「运行中」，停止/崩溃
  翻「已停止」；顶栏胶囊与概览页徽章按五态精确展示。
- **dsh 进程树 CPU/内存采样**：读 `/proc/<pid>/task/<pid>/children` 递归聚合子孙进程
  的 utime+stime 与 VmRSS，两次采样差值算 CPU、防时钟回跳/进程重启突刺、钳位 [0,100]；
  概览页新增「🐳 dsh 进程」卡片，实时展示 dsh 自己吃了多少资源（区别于整机资源）。
- **面板重启按上次状态自启**：上次是 `running/starting` 则自动拉起 dsh（持久化到
  `run-state.json`），否则跳过——对齐 Go 版 `InitHarness` 的 `GetLastRunState`。
- **chown 幂等化**：启动自愈先比对主目录属主，已是目标账号则跳过 `chown -R`（旧逻辑
  每次启动重写全部 ACL 并阻塞约 30s）。
- **修复**：概览页资源/dsh 进程两个卡片定时器切走视图时不再清理导致堆积泄漏；
  WS 推送与 3s 轮询的 dsh 资源卡片渲染逻辑统一（含进度条）。

## v1.0.10 — 2026-10-10

- **WebSocket 实时推送（替代轮询）**：面板新增 `/ws` 推送通道（纯 Node 原生 RFC6455，
  无第三方依赖）。dsh 启动/停止/重启、访客访问、访问记录清空时，后端主动把事件推给
  所有打开的面板；前端通过自动重连的 WS 客户端订阅，状态、访问记录实时刷新，不再依赖
  15 秒整页轮询（轮询保留作 WS 被网关剥离时的兜底）。状态变化同步刷新顶栏状态胶囊。

## v1.0.9 — 2026-10-10

- **反代回退纯回环 + 权限自愈**：撤销 v1.0.7 的「dsh 绑 0.0.0.0 局域网直连」，dsh
  重新只绑 `127.0.0.1`（所有版本都接受、最稳定），局域网客户端统一走面板内置反代
  （`:28001/p/` 与专用 `:28002`）。这是根治反代 502/504 断连的最终方案。
- **dsh 主目录权限自愈（核心修复）**：fnOS 上 dsh 主目录属主是「管理器」账号，但 dsh
  进程由管理器以独立的 `dsh` 服务账号拉起、未继承属主权限，导致 dsh 写不进自己的
  主目录（profiles/logs/credentials）而静默退出——这正是「已停止/无法启动、反代 502」
  的根因。启动前自动 `chown -R` 主目录到 dsh 实际运行账号（`DSH_RUN_USER` 可覆盖），
  并 `chmod u+rwX` 保证可写。
- **自动免 token**：沿用启动时的浏览器 token 门补丁（`patchBrowserAuthBypass`），
  dsh 每次启动自动关闭浏览器 token 门，局域网客户端经 `:28002` 免 token 直达。
- **28002 内置反代局域网直连**：`http://NAS的IP:28002` 作为纯转发局域网入口（无面板
  UI、无 `/p/` 前缀），直通 dsh，供同网段客户端直接使用。

## v1.0.8 — 2026-10-10

- **主页卡片整体缩小约 1/3**：首页三列卡片的内边距、标题字号、图标盒、行距、
  按钮、徽章全面收紧，一屏能展示更多内容、更紧凑清爽。
- **直连入口固定 :28000**：dsh 旧版已绑定局域网（0.0.0.0），主页「直连」按钮
  直接连 dsh 本体地址，与网关入口区分（前者直连、后者走面板代理有访问记录）。

## v1.0.7 — 2026-10-10

- **dsh 直接绑定局域网（根治反代断连）**：旧版 dsh（≤0.2.1-alpha.1，含 0.2.0-rc.2）的
  `webserver.host` 改绑 `0.0.0.0`（监听所有网卡），局域网客户端直接访问 `NAS_IP:28000`
  稳定直达 dsh，不再依赖两层反代（fnOS 网关 → 面板 → dsh）导致 502/504、连上就断。
  新版（≥0.2.1-alpha.2）仍走回环 + 具体网卡 IP 逻辑（原样保留）。
- **trusted-host 补齐 FN Connect 域名**：dsh 信任列表加入 `fnos.net`、`5ddd.com` 与
  `127.0.0.1`，远程经飞牛 FN Connect / 局域网直连访问 API 不再 403。
- **首页「直连」入口**：由 `:28002` 改回 `:28000`（dsh 已绑局域网，直接连即可）。
- **首页卡片排版对齐美化**：三列网格改为等高拉伸，卡片内部 flex 列布局、按钮组沉底对齐。
- **局域网直连端口 :28002**：内置代理新增独立监听一个局域网端口（保留，作为免 token 直连备选）。

## v1.0.6 — 2026-10-10

- **首页系统资源监控**：新增「系统资源」卡片，实时展示 CPU 占用（仪表条）、负载三项
  （1/5/15 分钟）、内存已用/总量/可用/缓存、系统运行时长、各磁盘挂载点用量，每 3 秒
  自动刷新。
- **「一键安装环境」→「一键修复环境」（真实作用）**：当 `npm` 在别的 node 目录或
  PATH 里能找到、但没和当前 node 放一起时，自动在 node 同级建软链，让面板稳定命中
  npm——这正是「面板找不到 npm / spawn npm ENOENT」的根因。`node` 本身缺失、`git`
  缺失时诚实提示需重装套件（`install_dep_apps=nodejs_v22` 自动补齐），不再假装能装。
- **文件授权页**：展示 dsh 工作区路径、声明的共享目录（`dsh`/`dsh/data`）与已授权
  路径，并给出可复制的 `trim-cli app openapi ...` 授权命令。面板以应用账号运行、无
  fnOS OAuth 会话，故不代点授权，只给事实与命令（诚实设计）。
- 浏览器 401 鉴权补丁 + 版本列表「删除」按钮 + UI 仪表条样式优化。

## v1.0.5 — 2026-10-10

- **dsh 启动前自愈**（借鉴 techysy/deepseek-harness-fnos 的成熟实践）：
  启动 dsh 前自动检查并修复四类「静默启动失败」——
  - 清理占用 dsh 端口的残留进程（只杀 cmdline 含 `bin.js` 的 node 进程）；
  - 凭据文件（`.credentials.yaml` / `.env` / `proxy.conf` / `trusted_hosts.conf`）权限非 600 时自动修正；
  - root 误建的 `.gitconfig` / `.npmrc` 自动 chown 回服务账号；
  - 服务账号登录 shell 为 `nologin`/`false` 时改为 `/bin/bash`（修 dsh 内置终端秒退）。
- **安装版本时校验 peer 依赖完整性**：npm 装完后遍历整棵依赖树，逐一核对所有非
  optional 的 `peerDependencies` 是否落盘；缺失时自动补装并复检，仍缺则判安装失败并
  删除残目录。此前 cordis loader 等 peer 缺失时 dsh 会「退出码 0 + 零输出」静默失败，
  面板却显示安装成功。
- **双图标**：管理器图标换回比耶鲸鱼娘；「DeepSeek harness web」桌面图标改为
  天青色瞪眼鱼（新增 `assets-src/dsh-web.png` 与 `ui/images/web_icon_*.png`）。
- **卸载可选删除全部数据**：应用设置页新增「卸载时删除全部数据」开关
  （`wizard_purge_data`），开启后卸载同时清空 `dsh_home`、`versions` 与面板数据。

## v1.0.4 — 2026-10-10

- **彻底修复 dsh 启动即崩溃（版本 schema 不兼容）**。根因：`dsh` 的 `webserver.host`
  schema 在版本间**完全相反且不相交**——
  - `<= 0.2.1-alpha.1`（含 0.2.0-rc.2）：只接受 `z.union([z.const("127.0.0.1"), z.const("0.0.0.0")])`
  - `>= 0.2.1-alpha.2`：拒绝通配地址，只接受具体 IP 字面量

  写 `0.0.0.0` 崩 alpha.2，写 LAN IP 崩 rc.2，钉死任一边只是把崩溃搬给另一个版本——
  这就是「修一次崩一次」的原因。**`127.0.0.1` 是唯一全版本接受的值**，现统一钉死：
  dsh 只听 loopback，LAN 客户端一律经面板 28001 反代进入（README 的既定架构，
  也是唯一能看到真实访客 IP 的一跳）。
- **支持 `>= 0.2.1-alpha.2` 的直连开关**：仅在支持具体 IP 的版本上，设置里钉一个网卡地址
  才会让 dsh 直连绑定；老版本一律回落 loopback，不再崩。
- **日志页纳入 dsh 自己的 `startup-*.log`**。此前崩溃详情只写进
  `${DSH_HOME}/logs/startup-<时间戳>-<uuid>.log`（仅在写失败时才回退 stderr），
  而日志页只扫 `${DATA_DIR}`，所以表现为「dsh 无日志输出」。现在能直接看到崩溃原因。
- 应用图标更换。
- **版本控制**：已安装的 dsh 版本可单个删除（当前正在使用的版本禁止删除）。
- **卸载**：新增「同时删除所有数据」选项（版本、dsh_home、日志、配置）。
- **安装版本 / 安装插件**：实时进度输出。
- UI 优化。

## v1.0.3 — 2026-10-10

- **修复 dsh 无法启动（启动即崩溃）**：面板每次启动都会重写 webserver patch，旧版写出的是非法
  YAML（`- id: webserver` 是序列项，其下级键必须从第 3 列开始，实际写成了第 5 列），同时钉死
  `host: 0.0.0.0` —— 而 dsh 0.2.1-alpha.2 起 schema 明确拒绝通配地址。两者叠加导致
  `loadProfile` 解析失败，面板怎么点都拉不起 dsh。现改为整个块重写，缩进正确且幂等。
- **host 改为三态**：`127.0.0.1`（仅本机）/ 指定网卡 IP / 自动（第一个真实网卡地址），
  设置页新增下拉框，可直接挑选网卡。
- **反向代理联动**：实测 dsh 只绑一个具体地址，绑到 LAN IP 后 loopback 即失效，
  原先写死的 `host: 127.0.0.1` 必然 502。现在代理上游跟随 patch 中实际写入的地址。
- **网卡排序**：虚拟网卡（VPN/TUN，如 Clash 虚拟网卡 198.18.0.1：MAC 全零或掩码不短于 /30）
  不再抢占自动选择的第一位——此前会导致「绑上了但谁都连不上」。
- **诊断页 patch 检查项反转并重写**：不引入任何 YAML 库（面板保持零依赖），逐行进栈校验缩进，
  一次列出全部问题；patch 中出现 `0.0.0.0` 现判定为故障态。
- 保存网络设置后立即重启 dsh 并返回实际绑定结果，不再等到下次手动启动才生效。

## v1.0.2 — 2026-10-09

- 修复 npm 安装：绝对路径解析 npm + node 目录进 PATH + 死代理探测跳过 + 缓存/日志指向可写数据目录。
- 修复插件安装后「疯狂刷新报错」：安装/插件任务终态只下发一次即清空，杜绝轮询重渲染循环。
- 日志页默认 10 行、可选 50/100/200/500 行，新增「导出」按钮，跟随轮询内容未变时不再重排 DOM。

## v1.0.0 — 2026-10-09

首个版本。

- 管理面板：状态 / 日志 / 版本切换 / 最近访问 IP / 快捷入口 / 诊断 / 设置。
- DSH 本体不内置，后台从 npm 下载、安装、切换版本，保留最近 N 个。
- 自带反向代理（Unix socket → 面板端口），是唯一能观测访问来源 IP 的路径。
- Host/Origin 受信栅栏（防 DNS rebinding / CSRF）+ 登录密码 + HttpOnly 会话。
- fnOS 生命周期脚本（start/stop/status/restart + install/upgrade/uninstall/config 回调）。
- 零依赖 PNG 图标生成器、语法/导入门禁、39 项端到端冒烟测试。
