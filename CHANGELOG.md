# Changelog

## v1.0.41 - 2026-10-12

修复「升级后 dsh 前端连不上」：`Connection timed out after 60000ms` 的根因。

**根因**：面板代持的 dsh 登录凭据（Launch Token + 换来的 `dsh-auth-*` Cookie）
此前只活在模块内存里，而 fnOS 每次升级/重装套件**都会重启面板**——凭据随之
清空。偏偏 dsh 此时通常还活着（`startDsh()` 命中「已有活进程直接复用」分支，
不重新 spawn，自然也不会重新打印 token），于是反代再没有凭据可注入：

- HTTP 请求被 dsh 的 token gate 直接 401；
- WebSocket（remote.mux）握手能过，但对端永不回话，前端等满 60 秒后抛
  `Connection timed out after 60000ms`，页面就此"废了"。

这与代码改动无关，纯粹是重启把凭据冲掉了 —— 也就是「之前正常、升级完就坏」。

**修复**

- 凭据落盘：token 与 cookie 写入 `${DATA_DIR}/dsh-session.json`（权限 0600，
  原子写 + rename），面板重启后自动恢复代持，与 dsh 是否跟着重启无关。
- Launch Token 也从 dsh 的 **stderr** 捕获（此前只盯 stdout）：不少 CLI 把服务
  横幅走 stderr，漏掉就永远换不到 cookie。
- 面板手里没有凭据时**不再剥离浏览器自己的 `dsh-auth-*`**：那样等于把唯一还能
  用的一道认证也拆掉，必然 401。原样透传。
- 可观测：复用已有 dsh 进程且缺凭据时，日志明确记一行；`/api/status` 新增
  `session: { token, cookie }`；概览新增「会话代持」卡，缺凭据时直接告警并提示
  重启 dsh（重启会重新打印 Launch Token）。

**升级后首次需要手动点一次「重启 dsh」**：本版的持久化只能保住**之后**的凭据，
当前这一轮已经丢失的凭据仍要靠重启 dsh 重新捕获。之后每次面板重启都能自动恢复。

### 门禁

- smoke 新增 4 条断言：token 落盘后可读回、无凭据时浏览器 cookie 原样透传、
  有凭据时替换而非拼接、`/api/status` 暴露 session 状态。check 28/15/0、smoke 99/99。

## v1.0.40 - 2026-10-12

按需求做的功能收敛瘦身版：删除三个页面与对应后端，只减不增。

### 补丁自动内置（删除「补丁」管理页）

- 客户端 bundle 的 host-mode 补丁从「手动点按钮应用」改为**全自动**：`startDsh()` 每次启动 dsh 前自动应用（幂等，已打过的跳过），覆盖手动启动 / 重启 / 版本切换后启动 / 面板开机自启全部路径；面板启动时再对所有已安装版本补一遍，覆盖「dsh 在面板外已运行、走 already 分支」的场景（`cmd/dashboard-process.js`、`cmd/dashboard.js`）。
- 删除 `GET /api/patches`、`POST /api/patches/apply` 路由与 `patchState()`；`dashboard-patches.js` 只保留 `applyPatches()`。
- 删除 `ui/assets/views/patches.js` 页面与导航入口。

### 访问记录瘦身（删除「访问记录」页，主页只保留最近访问者 IP）

- `dashboard-access.js` 整文件重写：JSONL 访问日志（队列/落盘/裁剪/统计）与 login.log 只读器全部删除，改为单个内存槽记录最近一次访问者 `{ip, ts}`——零磁盘 I/O，代理热路径只剩一次赋值。
- 删除 `GET /api/access`、`DELETE /api/access`、`GET /api/access/login` 路由；`/api/status` 不再返回 `access`（日志统计）与 `recentLogin`，`recentVisit` 改由内存槽供给。
- 删除 `ui/assets/views/access.js` 页面与导航入口；主页「最近访问」卡只显示来源 IP 一行，「面板」卡去掉访问量行。
- 设置页「访问日志」卡收敛为「访问来源」：只保留「信任 X-Forwarded-For」开关（它决定 IP 取值口径，与记录功能无关）；`access.enabled` / `access.max` 配置项退役。

### 删除「快捷入口」

- 删除 `GET /api/shortcuts` 路由、`settingsView` 与 `POST /api/settings` 的 `shortcuts` 字段、config 默认值与 install_callback 写入的 `"shortcuts": []`。
- 删除 `ui/assets/views/shortcuts.js` 页面与导航入口。

### 修复

- **侧栏折叠后图标不可点**（`ui/assets/app.css`、`ui/index.html`）。旧规则对折叠态的 `.sider-top` / `.sider-bottom` 整块 `opacity:0; pointer-events:none`，菜单连图标一起看不见、也点不动，等于把导航废掉。菜单文字改包在 `.mi-label` 里，折叠时只隐藏文字（`.mi-label` / `.brand-text`），按钮本体保持可交互并居中；每个菜单项补 `title`，折叠态有悬浮提示。
- **HTML 响应里的重定向 Location 未剥离回环地址**（`cmd/dashboard-server.js`）。上游以为自己住在 `127.0.0.1:3080`，任何 302 都带这个 authority。此前只有「非 HTML」分支做剥离；而 302 常带 HTML body，于是走 `proxyHtml` 分支被漏掉——浏览器被送去**它自己**的 `127.0.0.1:3080`，没有服务监听，表现就是「打开内置反代 :28000 一片空白」。现在 `proxyHtml` 同样重写 Location，且按 `pathPrefix` 补回前缀（`/p/` 下跳 `/p/login`，不会跳出前缀 404）；非 HTML 分支同步改为前缀感知。

### 门禁

- smoke 断言同步重写：旧路由一律断言 404；补丁改由「停 dsh → 构造未打补丁的假版本 → 启动 → 断言 bundle 已打 marker」验证自动内置；最近访问改经 `/api/status.recentVisit` 断言；设置持久化改验 `access.trustProxyHeaders`；新增「HTML 302 的 Location 必须留在代理前缀内」一条。check 28/15/0、smoke 95/95。

## v1.0.39 - 2026-10-12

v1.0.38 发布后收到反馈：升级后 dsh 客户端连接异常（插件接口 404、WS 60s 超时、控制台报错）。逐行复查 1.0.38 全部 738 行 diff 后，未发现必然破坏连接的缺陷；但确认该版本一次性改动了配置目录、插件安装、HTML 代理、端口扫描、进程时序五类与连接相关的路径，且只在开发机过 smoke、未经真实 fnOS 升级验证。本版不引入新功能，只把两处“优化可能变成回归”的行为改为带兜底的形态：**任何单文件场景下，行为都是 1.0.37 与 1.0.38 的并集，不会比任何一版更差**。

### 兜底（回归防御）

- **config 路径增加默认 home 回退**（`cmd/dashboard-config.js`）。1.0.38 把 `.credentials.yaml` / `.env` / `proxy.conf` / `trusted_hosts.conf` 全部改为跟随 `activeDshHome()`（与 dsh 启动参数 HOME/DSH_HOME/USERPROFILE 一致，修掉了“自愈修 A 目录、dsh 读 B 目录”的不一致）。但用户切换过 dsh 版本时，`workspace.active` 指向版本目录下的 home，而这些文件是历史版本写在**默认 home** 里的——1.0.38 会去一个空目录里找它们，表现为“升级后配置全丢、连不上”。现对每个文件独立判定：active home 有该文件 → 用 active（1.0.38 的正确行为，那才是 dsh 会读的那份）；只有默认 home 有 → 用默认 home（1.0.37 及之前的行为，“之前是好的”）；两边都没有 → active home（写入目标 = dsh 读取处）。`writeTrustedHosts()` 的 mkdir 跟着兜底解析后的路径走，避免写进未创建的目录。
- **registry 查询在 npm view 失败后增加直连兜底**（`cmd/dashboard-utils.js`）。1.0.38 为让代理生效把 registry 查询改走 `npm view`。npm 失败有两种完全不同的原因：registry 真的不通（旧实现同样失败，不是回归），和**这台机器上 npm 自身配置坏了**（`.npmrc` 指向死代理/镜像等——这类机器上 1.0.37 的直连 fetch 是能用的，不兜底，“优化”就变成了回归）。现 npm view 非 0 退出后再给直连一次机会（15s 短超时，快速失败）；两边都不通才上报 `registry-unreachable`，detail 同时携带两边的错误（npm 的 stderr 往往就是“哪个代理连不上”的答案）。
- smoke 新增 4 条断言钉住兜底语义：guard 脚本内构造 `workspace.active` 指向版本 home 的场景，验证“只在默认 home 有 → 回退”、“active 也有 → 优先 active”、“两边都没有 → 落 active”、“受信主机写入跟随兜底路径”。

## v1.0.38 - 2026-10-12

本次为稳定性与性能维护版，聚焦三件事：**去掉周期性阻塞事件循环的同步子进程**、**降低长跑期全量 `/proc` 扫描的 CPU 开销**、**修掉审计发现的功能 bug**。共改动 9 个文件。

### 性能（长跑稳定性）

- **`/api/resources` 每 3 秒同步 fork 一次 `df`**：概览页 3 秒轮询，`diskUsage()` 里是 `spawnSync('df', ['-k','-P'])`。`spawnSync` 会**完全阻塞** Node 主线程 —— 期间所有 HTTP 请求、WebSocket 推送、看门狗 tick 全部停摆；NAS 上磁盘繁忙（USB/阵列唤醒）时一次 fork+exec 可达数百毫秒，而读的只是一个分钟级才变化的数字。讽刺的是同项目 `dashboard-process.js` 早已因为完全相同的理由把 `ss -ltnp` 换成了读 `/proc`（那里有大段注释论证过）。现改用 `fs.statfsSync()`（statvfs(2) 绑定）：零子进程、零阻塞，字段与 `df -k -P` 一一对应（total=blocks×bsize，used=(blocks−bfree)×bsize，available=bavail×bsize）。仅在 statfs 不可用时降级到 `df`，并被 30 秒缓存兜住。实测同样 50 次采样：62ms（旧实现要 fork 50 次）。
- **端口→PID 反查每秒全量扫 `/proc`**：`pidsForInodes()` 是 O(进程数 × fd 数)，200 进程 / 平均 20 fd 的 NAS 就是约 4000 次系统调用；而看门狗 1s tick、usage 采样、stop/start 序列叠加调用，缓存 TTL 却只有 750ms —— 基本每秒真扫 1~2 次，是面板空闲时 CPU 占用的主要来源。两处改进：①TTL 750ms → 3000ms（所有"端口即将易主"的调用点都已显式 `invalidatePortScan()`，3 秒陈旧窗口不会误判）；②新增 inode→pid 增量核对 —— 稳态下先花 O(命中数 × fd)（通常 1 个进程、十几个 readlink）核对外层缓存，只有核对失败（进程换了/端口被抢占）才回到全量扫描。约 4000 次系统调用降到约 20 次。
- **`access.log` 每次 flush 全量重写**：`trimLog()` 在每个 flush（每 20 条记录或 1 秒，取先到者）都 read 全文件 + write 全文件 + rename。改成超过上限 120% 才裁，把 O(n) 重写摊薄：500 条上限下从"每秒一次 500 行重写"变成"每 100 条记录一次 600 行重写"。
- `readResources()` 里 `cpus()` 被调用两次（每次都要重新组装数组、解析 model 字符串），改为一次。

### 修复

- **【P0】插件删除接口路径穿越 → 可递归删除任意目录**（`cmd/dashboard-plugins.js`）。`removeBundle()` 的 `name` 直接来自请求体，拼进 `join(profileDir(), 'node_modules', pkg)` 后用 `rmSync(dir, { recursive: true, force: true })` 删除；`join()` 会规范化 `..`，于是 `"../../../../../../etc"` 解析成 `/var/apps/etc` 被整个删掉，且 `force: true` 会吞掉失败。此前唯一挡住它的是**隐式保护**（`npm remove <非法名>` 通常返回非 0 提前 return），那是依赖 npm 的行为、不是校验，换版本/换 registry 就可能失效。现加两道显式防线：npm 官方包名正则 `^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$`（同时拒绝 `..`），以及解析后必须在 `node_modules` 内的包含校验；`installBundle`/`setBundleEnabled` 同口径校验，`installedDir()` 对非法名返回 `null` 而不是一个危险路径。
- **插件开关写入 YAML 注入**：`setPluginEnabled()` 逐行拼 `cordis.patch.yml`，`id`/`name` 里的换行会变成新的 YAML 条目。现拒绝含换行/控制字符的值。
- **版本列表把预发布版排在正式版前面**（`cmd/dashboard-versions.js`）。导入的是 `dashboard-utils.js` 的 `compareVersions`，其用 `split(/[.+-]/)` 把 `-` 也当分隔符，**丢失了 prerelease 语义**；`dashboard-config.js` 里另有一个语义正确的 semver 实现。实测旧序 `0.2.1-rc.1 , 0.2.1-alpha.2 , 0.2.1-alpha.1 , 0.2.1` —— 用户容易从下拉顶部误装不稳定版本。改导入源后为 `0.2.1 , 0.2.1-rc.1 , 0.2.1-alpha.2 , 0.2.1-alpha.1`。
- **超 8MB 的 HTML 被静默截断**：注释写的是"超限直接放弃注入、原样透传"，实际是 `if (buffered <= CAP) chunks.push(c)` —— 超限后停止收集，返回被截断的前 8MB，并且用 `content-length = body.length` 把这个截断长度**声明成完整长度**，客户端拿到残缺页面却不报错。现改为真正的管道直通：已声明长度超限则从第一个字节起 pipe（连缓冲都不建）；chunked 中途超限则写出已收部分后继续 pipe，并**删掉 content-length** 交给分块编码。
- **registry 查询不走代理**：`fetch()`（undici）**不读 `HTTP_PROXY`/`HTTPS_PROXY`**，而 npm 读。于是设置了代理的机器上会出现「`npm install` 能成功，但可用版本列表 / 插件查询永远 `registry-unreachable`」这种自相矛盾的故障。现统一走新增的 `registryDoc()`（`npm view <pkg> --json`），复用 npm 的 registry/代理/证书配置；仅当 npm 本身不可用（spawn 失败、code 127）时才降级回原 fetch 路径，不会让真实的网络故障白等一遍超时。
- **`startDsh()` 异常分支泄漏 fd**：`openSync(DSH_LOG)` 在 try 内，而 catch 分支没有 `closeSync`（`exit`/`error` 分支都有关闭 —— 本模块专门修过这个泄漏，这是同一函数的遗漏路径）。fd 已提到 try 外，catch 分支归还。
- **`signalGroup()` 返回值语义不明且有一处笔误**：`return error && error.code === 'EPERM' ? false : false` 两分支相同，且函数成功发信号后返回 `false`（实为"组还在不在"，与函数名相反）。当前无调用方使用返回值，但极易误导维护；笔误已修正并在注释里写明真实语义。
- **杀掉残留 dsh 后不等端口释放就 spawn**：`preStartSelfHeal()` 步骤 1 对残留进程发 `SIGTERM` 后立即返回，`startDsh()` 紧接着 spawn → SIGTERM 是异步的，新进程可能撞上 `EADDRINUSE`。`stopDsh()` 有 `waitForPortFree()`，启动路径此前缺这一步，现已补上（仅在真的杀了残留时才等）。
- **受信主机 / 凭据 / proxy.conf 写到与 dsh 实际 home 不一致的目录**：`CREDENTIALS_PATH`、`ENV_PATH`、`PROXY_CONF`、`TRUSTED_CONF` 在模块加载时按常量 `DSH_HOME` 固定，而 `preStartSelfHeal()` / `dshLaunch()` / `profileDir()` 用的是 `activeDshHome()`（读 `workspace.active`，可能指向版本目录下的另一个 home）。结果是 chmod/chown 自愈修 A 目录、配置写 B 目录，权限自愈与受信主机配置双双失效。四个常量改为按 `activeDshHome()` 实时解析的函数（`credentialsPath()` / `envPath()` / `proxyConfPath()` / `trustedConfPath()`）。
- **Launch Token 行缓冲无上限**（`cmd/dashboard-session.js`）：`lineBuffer += chunk`，若 dsh 长时间输出不含换行则无界增长。加 64KB 上限（保留尾部，避免把含 token 的行切走）。
- **工作区「返回上级」比较类型不一致**（`cmd/dashboard-workspace.js`）：`allowed === target` 比较的是 `workspace.json` 里的原始字符串与 `resolve()` 后的绝对路径，几乎不可能相等 → 根工作区时 parent 仍指向 `..`，前端「上级」按钮跳到一个必然被 403 拒绝的路径。改为 `resolve(allowed) === target`。（不是安全漏洞：越界检查本身是可靠的。）
- **静态目录前缀判断补分隔符**：`serveStatic` 的 `startsWith(UI_DIR)` 对 `/ui` 与 `/ui-other` 会误判。抽出 `withinDir()`，统一按 `dir + sep` 判断（词法路径与 realpath 两处都用）。

### 复查修正（发布前自审，其中 3 项是上一轮修改引入的）

- **`proxyHtml` 超限直通分支没有挂 `error` 监听**（本轮引入）：`content-length` 已声明且超限时函数提前 `return`，而 `upstream.on('error')` 挂在函数末尾 —— IncomingMessage 的 `'error'` 没有监听器就是 uncaughtException，且 `pipe()` 只负责解绑、不会结束 response，客户端会一直挂到超时。现把 `'error'` 监听提到任何提前 return 之前，三条路径全覆盖。
- **行缓冲上限截断顺序错误**（本轮引入）：`CaptureLaunchToken` 原来在拼行**之前**就 `slice()` 到后 64KB。若一个 chunk 里同时含一条完整的 `dsh web: http://…?token=…` 行和一大段无换行输出，截断会把含 token 的整行从中间切掉 → token 永远捕获不到、反代持续 401，而这种现象极难和"上游改了启动输出"区分开。改为先跑完拆行循环、只对残留的那一条不完整行设上限。
- **`inodeOwnerCache` 曾为全系统每个 socket 建记录**（本轮引入）：慢路径顺手把**所有** socket 的 inode→pid 都记进缓存，而 `findPidsOnPort()` 永远只查 dsh 一个端口 —— 繁忙 NAS 上几万条纯占内存的 Map 记录换不来任何命中。改为只记本次查询的 inode（1~3 个），缓存规模被查询集封顶且每次整体替换，不随重启次数累积陈旧条目。
- **`setBundleEnabled` / `removeBundle` 校验与写入用了不同的名字**（本轮引入）：入口用 trim 后的 `pkgName` 校验，函数体却仍用原始 `name` 读写 bundles 数组。入参带空格时校验通过、写进 `package.json` 的却是带空格的名字，与 npm 实际装的包对不上。两处统一为 `pkgName`。`removeBundle` 另有一个算完就没用过的 `target` 死变量，已删。
- **`waitForPortFree` 预算 500ms 过短**：两处调用都在刚刚 SIGTERM 过之后，而优雅关闭的 dsh 要 flush 日志/会话。放宽到 1500ms（端口真释放时循环立刻返回，只影响失败路径），否则新加的 `preStartSelfHeal` 可能带着一个将死的监听去 spawn、撞 EADDRINUSE。
- **诊断项的 credentials 检查漏掉 `.env`**：循环里第一个存在的文件就 `return`，所以 `.credentials.yaml` 存在时 `.env` 的权限问题永远查不出来（dsh 对两者都要求 600）。改为逐个看完所有文件再下结论。
- `dashboard-resources.js` 清掉 4 个已无引用的导入（`existsSync`/`readdirSync`/`statSync`/`join`），降级路径不再重复读一次 `/proc/mounts`。

### 说明

- 面板与 LAN 直连口监听 `0.0.0.0`、局域网内无凭据可访问，是**有意的设计**（依赖 fnOS 网关鉴权 + Host/Origin 信任栅栏），本版未改动。README 第 48 行「登录密码 + HttpOnly 会话 Cookie」的描述与实现不符，建议后续单独订正文档。

### 验证

- `check.mjs` 31 parsed / 15 imported / 0 failure；`smoke.mjs` 83 → **92/92** 全通过。
- smoke 新增 9 条断言钉住本次修复：超 8MB HTML 必须原样透传不截断、代理大响应后面板仍存活、包名校验接受正常/scope 名而拒绝穿越名、`removeBundle` 在任何递归删除之前拒绝穿越名、版本排序正式版高于自身预发布版、资源采样不 fork 子进程（有容量且 <1000ms）、**含 token 的完整行不被随后的巨量无换行输出挤掉**、**bundle 启停写入 trim 后的包名**。

## v1.0.37 - 2026-10-11

### 修复

- 安装带 postinstall 生命周期脚本的插件（如 `dsh-workbuddy-connect@0.7.2` 依赖的 `protobufjs@7.6.6`）时报 `Failed to spawn lifecycle script ... No such file or directory (os error 2)`、`pnpm add` exit 1。根因：面板被 fnOS 套件框架降权启动，自身环境里**没有 `PATH`**，spawn dsh 时原样 `...process.env` 把残缺环境传给了 dsh；dsh 内部装插件时 pnpm 要执行依赖的 postinstall 脚本，spawn shell 靠 `PATH` 找 `node` 却找不到 → ENOENT。此前面板 spawn npm 已经用 `nodeDirEnv()` 补过 PATH，唯独 spawn dsh 漏了这步。现改为 `nodeDirEnv({ ...process.env, ... })`，把 node 的 bin 目录 + 系统目录补进 PATH，带生命周期脚本的插件可正常安装。

### 验证

- `node --check` 0 失败；`check.mjs` 31 parsed / 15 imported / 0 failure；`smoke.mjs` 83/83 全通过。

## v1.0.36 - 2026-10-11

### 修复

- 经 fnOS 网关访问时，面板 `/ws` 推送通道握手被信任栅栏判 `origin-host-mismatch` 拒绝（403），浏览器反复报 `WebSocket connection failed`，UI 只能靠 15 秒轮询兜底。根因是 `proxy.py` 的 `_ws_proxy` 把 `Host` 重写为 `127.0.0.1` 却原样透传了浏览器的 `Origin`（`http://<网关host>:5666`），两者不一致被 `isTrustedRequest` 拒绝；而 `_http_proxy` 早就有 `headers.pop("Origin")`，`_ws_proxy` 漏了这步对称处理。现已对齐：WS 握手的头转发同样剥掉 `origin`，经网关访问时推送通道恢复正常。
- 面板发往客户端的 WS 控制帧（ping/pong/close）误带 mask 位：`[0x89, 0x80, 0,0,0,0]` 里第二个字节 `0x80` 是 mask 位（RFC 6455 规定服务端→客户端**绝不能** mask），浏览器据此报 `A server must not mask any frames that it sends to the client` 并丢弃推送通道。改为正确的空控制帧 `[0x89, 0x00]` 等三处。此 bug 为原有问题，之前经网关 `/ws` 握手就被 403 挡在帧阶段之前，从未暴露。

### 验证

- smoke 新增 2 条断言：`dashboard-server.js` 的服务端→客户端控制帧不得含 mask 位、文本帧保持 `0x81` 无 mask。81 → 83 项全通过。

## v1.0.35 - 2026-10-11

### 修复

本次为深度审计后的系统化加固，覆盖四路审计（核心服务端 / cmd 其余模块 / 网关代理 / 前端）发现的所有 bug、拥堵与内存泄漏。共改动 13 个文件。

#### 核心服务端（cmd/dashboard-server.js、dashboard-process.js）

- **反代升级崩溃链**：`proxyUpgradeToDsh` 是 async 函数却没有任何 `.catch`，上游在握手期间抛错会变成未处理的 Promise rejection 直接崩掉面板进程。现在两个调用点（lan-proxy 与 console）都走 `proxyUpgradeToDshSafe` 包装，出错时销毁 socket 并记录，面板不再因此退出。
- **socket 无 error 监听的崩溃窗口**：升级请求在 `await` 换取 dsh 会话 Cookie 的间隙里，客户端 socket 若中途断开，`socket.on('error')` 未注册会抛出未捕获异常。现在在 await 之前就挂上兜底监听。
- **隧道无超时 + 无对称清理**：握手加 10 秒超时（超时销毁上游并回 504）；升级成功后双向绑定 `close` → 销毁对端，半死连接不再永久挂留。
- **`/plugins/??` 折叠还原过窄（偶发 404 直接原因）**：原来只在 query 含 `client.js` 时才还原折叠，其他插件文件会被原样透传导致 404。改为仅凭 `!rawQuery.startsWith('?')` 判断，对齐 Go 参考实现。
- **DSH_LOG fd 永不关闭**：每次 start/restart 都新开一个日志 fd 且从不 close，长跑耗尽进程 fd 上限后 spawn 静默失败、日志全丢。现在子进程 exit/error 时归还 fd。
- **服务操作互斥**：start/stop/restart 之前无并发互斥，双击或看门狗竞态会交错读写 `managed` 与 pidfile（一个 stop 可能清掉并发 start 刚写的 pid，或两个 dsh 同时存活）。三个操作现在走 `serializeServiceOp` 串行链；`restartDsh` 复用 stop/start 的锁、不再重复入链（避免自死锁）。
- **外层 catch 对已结束响应二次写入**：createConsoleServer 的兜底 catch 之前无论响应是否已发送都再写一次状态行，污染已发送的流。现在判 `headersSent/writableEnded`，且每请求补 `response.on('error')` 兜底。
- **HTML 注入缓冲无上限**：给注入缓冲加 8MB 上限，超限跳过注入、原样透传。
- **serveStatic 符号链接逃逸**：静态文件服务加 `realpathSync` 前缀校验。

#### 网关代理（cmd/proxy.py）

- **全链路读超时**：`Handler.timeout = 60`，堵住半开/空闲连接永久占用 ThreadingHTTPServer 线程（线程只增不减，耗尽即整网关停摆）。
- **WS 半死连接线程泄漏**：`_relay` 原来要等两端都 EOF 才返回，一条半死 WS 永久泄漏 2 线程 + 2 socket。改为任一路结束即通过 Event 通知并关闭两端，同时加 TCP keepalive 主动发现半死对端。
- **非 101 升级失败分支**：升级被拒（401/403）时显式关连接，避免 keep-alive 帧失步。
- **HEAD 响应误写 body**：HEAD 现在只回状态行 + 头。
- **响应流二次写防护**：`fail()` 判 `_response_started`，状态行已发出后不再污染流。
- **带 query 的前缀漏剥**：`strip_prefix` 先剥离 query 再匹配前缀，带 query 的请求不再 404。
- **chunked/CL 解析加固**：非数字 Content-Length 与非法 chunk size 标记关连接，避免帧失步；完整消费 trailer。
- **残缺响应头防护**：上游提前断开时不再把残缺 buf 当头透传。
- **HTML 重写引号加固**：绝对路径重写改用单引号包裹并支持单双引号两种引号形式。

#### 信任围栏（cmd/dashboard-trust.js）

- **X-Forwarded-Host 伪造绕过（高危）**：原来无条件优先采信 `X-Forwarded-Host`，LAN 客户端自设 `X-Forwarded-Host: localhost` 即可绕过 `isTrustedRequest`。现在仅在网关之后才采信，否则强制用 `headers.host`。
- **X-Forwarded-For 伪造**：clientIp 只在网关之后且未显式关闭 `trustProxyHeaders` 时才信任。
- **Origin 端口校验**：`isTrustedRequest` 新增 Origin 端口校验，非面板监听端口（28001/28000）的跨端口 Origin 被拒。

#### 面板入口（cmd/dashboard.js）

- **lan-proxy 端口被占时永久挂起（高危）**：error 事件原先只 log 不 settle Promise，端口被占时 `await` 永久挂起、后面的 SIGTERM/SIGINT 注册永不执行。现在绑定失败会 reject，信号处理始终注册。

#### 插件 / 会话 / 访问 / 工作区（dashboard-plugins.js、dashboard-session.js、dashboard-access.js、dashboard-workspace.js）

- **插件安装旧快照回写**：npm install 后改从磁盘重读 package.json，不再用 install 前的旧快照覆盖 npm 写入的依赖。
- **插件读-改-写无互斥**：四个插件操作函数包进 `withPluginWriteLock` 串行化。
- **换 Cookie 响应流缺 error 监听**：连接重置时 Promise 不再永不 settle（避免随后 2 秒静默空 cookie 引发的间歇 401）。
- **access 队列无界 requeue（内存泄漏）**：写失败时硬上限 1000 条、丢最旧并计数，加 5 秒退避重试。
- **listDirectory 符号链接逃逸**：词法边界检查后加 `realpathSync` 真实路径校验。

#### 前端（ui/assets/app.js、views/versions.js、views/plugins.js、views/access.js）

- **WS visit/access 高频事件无节流**：一次代理请求推一条 visit 事件，突发流量会排队一整串整页重渲。改为 800ms 尾沿去抖。
- **版本/插件安装轮询重入**：`setInterval(watch)` 直调 async watch，某次请求 >2s 即并发重叠。加 in-flight 守卫 + 串行自续。
- **访问页自动刷新竞态**：10s 轮询加 in-flight 守卫，避免刷新超过 10s 时堆积。

### 验证

- check.mjs：31 parsed / 15 imported / 0 failure（含 proxy.py 编译、manifest 字节校验、crypto 误用扫描）。
- smoke.mjs：81/81 通过。

## v1.0.34 - 2026-10-10

### 修复

- 概览页的 `/api/usage` 轮询定时器不再泄漏。旧代码先 `await` 首次采样、再注册 `clearInterval` 清理；这段窗口里若 WS 推送（`status`/`visit`/`access` 事件都会触发重渲染）打进来，并发的那次渲染会把尚未入列的清理函数漏掉。每漏一次就永久多留一个 3 秒定时器，请求量呈指数增长——实测 `/api/api/usage` 累计 6959 次、稳定在每秒 20~29 次，而设计值是每 3 秒一次。
- 三处加固：轮询定时器同步创建并在任何 `await` 之前注册清理；`renderTab()` 整体串行化（`renderQueue`），杜绝并发重入导致的重复注册；清理函数加停止守卫，迟到的响应不再写入已卸载的视图。

### 验证

- smoke 新增 5 条断言：定时器同步创建、清理注册早于 `await`、停止守卫存在、`renderTab` 走队列、`leavers` 回收发生在串行体内。

### 已知上游问题（不在本包修复范围）

- dsh `0.2.0-rc.2` 的 `index.html` 把 `@deepseek-ai/dsh-client-ui-locale/client.js` 写进了预加载清单，但该包并未随该版本分发（`node_modules/@deepseek-ai` 共288 个包，独缺这一个）。dsh 对多路复用插件请求是「全有或全无」，因此整串 60 余个插件一起 404，页面白板。需 dsh 上游修复。
## v1.0.33 - 2026-10-10

### 修复

- 面板主页打开后一片空白、必须手动刷新才有数据。`ui/assets/app.js` 在 `boot()` 之前的一行调用了 `state.onLeave(() => {})`，而 `onLeave` 定义在 `ctx` 上、`state` 只是 `{ tab, logFile }`，于是抛出 `Uncaught TypeError: state.onLeave is not a function`，`boot()` 永远不执行，一个 API 请求都不会发出。该行本身是无意义的空钩子（推送通道由 `closeWs` 在 `beforeunload` 释放），已删除。页面 HTML 是静态的，所以界面看起来一切正常，这也是它长期没被发现的原因。

### 验证

- smoke 新增两条断言：`app.js` 不得出现 `state.onLeave`；且必须保留 `beforeunload` 到 `closeWs` 的绑定。
## v1.0.32 - 2026-10-10

### 修复

- 网关代理 `cmd/proxy.py` 回写上游 101 响应头时，不再把 `connection` 当作 hop-by-hop 一丢了之。`Connection: Upgrade` 只曾被补往上游方向，从未补回客户端，于是经 fnOS 统一网关（:5666）的 101 只带 `Upgrade`、不带 `Connection`，违反 RFC 6455：浏览器判定握手非法、丢弃 socket、循环重试，而面板日志一路记录 101，故障完全不可见。面板自身是相反方向的缺陷（同一段逻辑补重了），v1.0.31 已修。
- 现在 `connection`/`upgrade` 各只透传一次，且仅在 101 缺失时补齐，面板主页的实时推送（`/ws`）与 dsh 隧道（`/p/api/remote.mux`）经网关均能正常建立。

### 验证

- smoke 新增网关 101 覆盖：启动真实 `proxy.py` 监听 unix socket，断言握手 101、`connection`/`upgrade` 各恰好一次、子协议保留、上游帧能穿隧道回来、且普通 HTTP 反代不受影响。本机 python 缺 `AF_UNIX` 时跳过这 6 项，CI（Linux）实际执行。
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
