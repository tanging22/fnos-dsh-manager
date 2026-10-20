# DSH 管理器（fnos-dsh-manager）
管理器属于原汤化原食了，管理器全部代码都是用DeepSeek harness写的，有些部分也是参考同类型GitHub项目实现。修修补补到现在达到勉强可以用的版本。我不懂代码的，勉强做到这样了。

给 **fnOS（飞牛 NAS）** 用的 DeepSeek Harness（DSH）管理面板套件。

一个 fpk 装好之后，在浏览器里就能：看 DSH 状态、看日志、**从 npm 下载并切换 DSH 版本**、看最近访问来源 IP、配置快捷入口——**不需要碰命令行，也不需要预装 DSH 本体**。

---

## 它是什么

DSH 本体是一个 node 服务。这个套件**不内置 DSH**，而是在后台帮你从 npm 下载、安装、切换版本。套件自身带一个轻量的管理面板 + 反向代理：

```
浏览器 ──▶ fnOS 统一网关(/app/fnos-dsh-manager) 或  直接端口
              │
              ▼
        DSH 管理器面板（本套件，端口 28001）
         ├── 管理界面（状态/日志/版本/访问 IP/快捷入口）
         └── 反向代理 ──▶ 本机的 DSH 实例（端口 28000）
```

**为什么面板自带反代**：DSH 自身的 browser-trust 栅栏会按 Host/Origin 拒绝外部访问，且它自己看不到真实来源 IP。面板的反代是唯一一条既能正常转发、又能**观测访问来源 IP** 的路径。

---

## 功能

- **状态**：DSH 运行/停止、端口、启动时间、访问日志摘要。状态由显式五态状态机
  （`stopped / starting / running / building / snapshotting`）驱动，顶栏胶囊与概览页
  徽章按五态精确展示（启动中 / 运行中 / 已停止 / 部署中 / 快照中），不再只是「读 pid
  临时猜」。
- **系统资源**：首页实时监控 CPU 占用（仪表条）、负载三项（1/5/15 分钟）、内存
  已用/总量/可用/缓存、系统运行时长、各磁盘挂载点用量，每 3 秒自动刷新。
- **🐳 dsh 进程资源**：单独展示 DSH **进程树**（含子进程）的常驻内存与相对整机算力的
  CPU 占用——读 `/proc/<pid>/task/<pid>/children` 递归聚合，两次采样差值算 CPU，防时钟
  回跳 / 进程重启突刺，结果钳位 [0,100]。区别于上面的「整机资源」。
- **日志**：列表 + 尾部读取 `dsh.log`。
- **版本切换**：列出已安装版本、从 npm 安装新版本、切换当前版本、**单个删除**（当前
  使用的版本禁止删除）、保留最近 N 个。
- **工作区**：列出 dsh 的会话工作区（标题/路径/会话数/时间），支持**打开文件夹**（调
  fnOS 文件管理器 SDK `trimSdk.openFileManager` 直接定位）、**复制路径**与**只读浏览目录**
  （子目录可点进、可返回上级，越界 403）。
- **最近访问 IP**：面板记录每次经反代的访问（IP/方法/路径/状态/耗时/UA），可过滤、可清空。
- **快捷入口**：自动发现 + 手动固定常用链接。
- **诊断**：一项项检查配置是否就绪。
- **环境修复**：检测 node / npm / git；「一键修复环境」能在 npm 未与当前 node 放一起时
  自动建软链（修 `spawn npm ENOENT` 根因）；node/git 缺失时诚实提示需重装套件。
- **安全**：登录密码 + HttpOnly 会话 Cookie；Host/Origin 受信栅栏（防 DNS rebinding / CSRF）。

## 可靠性（对齐 Go 版成熟参考实现）

v1.0.18 起，进程监督层整体对齐了 Go 版参考实现（`deepseek.harness.fnos`）的可靠性模型：

- **进程组三段式停止**：dsh 以 `detached` 拉起成为进程组组长，停止时 SIGTERM 整个进程组
  → 3 秒轮询 → SIGKILL 整个进程组，再清扫端口残留、等待端口真正释放——根治「孤儿子进程
  占端口 → 下次启动 EADDRINUSE」。
- **看门狗巡检自愈**：每秒巡检，托管进程死亡但端口仍有 dsh 子进程时自动接管
  （`adoptedPid`）；连续 3 次确认死亡则清掉 pid 文件与状态，UI 不再对已死进程谎报「运行中」。
- **启动自愈幂等化**：chown 主目录前先比对属主，已是目标账号则跳过 `chown -R`（旧逻辑
  每次启动重写全部 ACL 并阻塞约 30 秒）；修 nologin shell 只针对 dsh 运行账号、不再因
  root 提前 return 而跳过浏览器 token 门补丁。
- **面板重启按上次状态自启**：上次是 `running/starting` 则自动拉起 dsh（持久化到
  `run-state.json`），否则跳过。

---

## 安装

在 fnOS 的「应用中心」安装本套件（`.fpk`）。安装向导会问：

| 字段 | 说明 |
| --- | --- |
| DeepSeek API Key | 面板登录密码默认取它；留空则随机生成 |
| 代理 IP / 端口 | 可选，需要代理访问 npm 时才填 |
| fnOS ID | 可选，自动把 `<id>.fnos.net` 加入受信主机 |
| 自定义域名 | 可选，额外受信域名 |
| 预装 DSH 版本 | 可选，安装时从 npm 下载指定版本 |

装完后：

- 直接访问：`http://<NAS-IP>:28001/`
- 经统一网关：`http://<NAS>/app/fnos-dsh-manager/`

首次登录用向导里设置的 API Key（或随机生成的密码）。

---

## 数据文件

运行时数据都在套件的数据目录（`@appdata/fnos-dsh-manager/`）下：

- `console-config.json` —— 面板配置
- `.credentials.yaml` —— 登录凭据（`chmod 600`）
- `trusted_hosts.conf` —— 受信主机（一行一个）
- `versions/` —— 已下载的 DSH 版本
- `run-state.json` —— 上次运行状态（面板重启自启决策用）
- `console.log` / `proxy.log` / `dsh.log` —— 日志
- `dsh.pid` —— dsh 进程 pid 文件
- `dsh_home/` —— DSH 的 home（profiles 等）

卸载套件**不会**删这个目录，重装后配置与已下载版本还在。若要在卸载时一并删除全部数据，
可在设置页开启「卸载时删除全部数据」开关（写入 `wizard_purge_data`）。

---

## 从源码构建

本地构建需要 fnpack 1.2.3 二进制；本仓库也支持 **GitHub Actions 在线构建**——推送
`v*` tag 或在 Actions 页手动触发 `build-fpk` 工作流，即可自动下载 fnpack、生成图标、
跑语法/导入门禁 + 冒烟测试、打出 `.fpk` 并（tag 推送时）挂到对应 Release。

```bash
node scripts/make-icons.mjs   # 生成 PNG 图标（零依赖）
node scripts/check.mjs        # 语法 + 导入门禁
node scripts/smoke.mjs        # 端到端冒烟
bash scripts/build-fpk.sh     # 打 fpk 包（需 fnpack 1.2.3）
```

详见 [CHANGELOG.md](CHANGELOG.md) 与各脚本头部注释。

---

## 许可证

[Apache License 2.0](LICENSE)
