#!/bin/bash
# check-dsh.sh — dsh 全功能体检脚本
#
# 在飞牛 fnOS 上跑(ssh 或 fnOS 终端), 逐项体检 dsh 的运行环境与功能,
# 重点排查「dsh 用户无法读取配置/工作目录」这类权限问题.
#
# 用法:
#   sh /path/to/check-dsh.sh          # 只读体检, 不改任何东西
#   sh /path/to/check-dsh.sh --fix    # 对能安全修复的项(权限/属主/缺失目录)自动修复
#
# 每个检查项输出 [PASS]/[WARN]/[FAIL]/[SKIP], 结尾给汇总与退出码(0=全过, 1=有 FAIL).
set -u

APP_NAME="dsh-console"
FIX_MODE=0
[ "${1:-}" = "--fix" ] && FIX_MODE=1

PASS=0; WARN=0; FAIL=0; SKIP=0
say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  [PASS] $*"; }
warn() { WARN=$((WARN+1)); say "  [WARN] $*"; }
fail() { FAIL=$((FAIL+1)); say "  [FAIL] $*"; }
skip() { SKIP=$((SKIP+1)); say "  [SKIP] $*"; }
hdr()  { say ""; say "===== $* ====="; }

# 定位 DATA_DIR / 面板身份 / dsh home, 全脚本共用.
resolve_paths() {
  # 面板数据目录(TRIM_PKGVAR 优先, 否则遍历卷下 @appdata).
  DATA_DIR=""
  for c in "${TRIM_PKGVAR:-}" "/vol1/@appdata/${APP_NAME}" "/vol2/@appdata/${APP_NAME}" "/vol3/@appdata/${APP_NAME}" "/var/apps/${APP_NAME}/var"; do
    [ -n "${c}" ] && [ -d "${c}" ] && { DATA_DIR="${c}"; break; }
  done

  # dsh home(优先读面板持久化的 workspace.active, 否则 fallback 到数据目录下 home).
  DSH_HOME=""
  if [ -n "${DATA_DIR}" ] && [ -f "${DATA_DIR}/workspace.active" ]; then
    DSH_HOME="$(cat "${DATA_DIR}/workspace.active" 2>/dev/null)"
  fi
  [ -z "${DSH_HOME}" ] && [ -n "${DATA_DIR}" ] && DSH_HOME="${DATA_DIR}/home"
  [ -z "${DSH_HOME}" ] && DSH_HOME="/vol1/@appdata/${APP_NAME}/home"

  # 面板运行身份: 从进程 cmdline 反查(比猜 TRIM_RUN_USERNAME 更可靠).
  PANEL_USER=""
  PANEL_UID=""
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "${p}/cmdline" 2>/dev/null || true)
    case "${c}" in
      *dashboard.js*)
        PANEL_UID=$(awk '/^Uid:/{print $2}' "${p}/status" 2>/dev/null)
        PANEL_USER=$(getent passwd "${PANEL_UID}" 2>/dev/null | cut -d: -f1)
        break
        ;;
    esac
  done
  [ -z "${PANEL_USER}" ] && PANEL_USER="${TRIM_RUN_USERNAME:-<unknown>}"
}

resolve_paths

say "dsh 全功能体检 $(date '+%F %T')"
say "面板身份=${PANEL_USER:-?} (uid=${PANEL_UID:-?})  数据目录=${DATA_DIR:-<未找到>}  dsh home=${DSH_HOME}"

# ---------------------------------------------------------------- 1. 面板本体
hdr "1. 面板进程与端口"
if pgrep -f 'dashboard\.js' >/dev/null 2>&1; then
  ok "面板进程运行中 (pid=$(pgrep -f 'dashboard\.js' | head -1))"
else
  fail "面板进程未运行 (dashboard.js)"
fi
if (exec 3<>/dev/tcp/127.0.0.1/28001) 2>/dev/null; then
  ok "面板端口 28001 监听中"
  exec 3>&- 3<&- 2>/dev/null || true
else
  fail "面板端口 28001 未监听/被拒"
fi

# ---------------------------------------------------------------- 2. node 运行时
hdr "2. node 运行时"
NODE_BIN=""
for c in /var/apps/nodejs_*/target/bin/node /var/apps/nodejs_*/bin/node \
         /vol[0-9]*/@appcenter/nodejs_*/bin/node /vol[0-9]*/@appcenter/nodejs_*/target/bin/node \
         /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && { NODE_BIN="$c"; break; }
done
if [ -n "${NODE_BIN}" ]; then
  NV=$( "${NODE_BIN}" -v 2>/dev/null )
  ok "node 可执行: ${NODE_BIN} (${NV})"
  NPM_BIN="${NODE_BIN%/bin/node}/bin/npm"
  [ -x "${NPM_BIN}" ] && ok "npm 伴生存在: ${NPM_BIN}" || warn "npm 缺失于 ${NPM_BIN}"
else
  fail "未找到可执行 node"
fi

# ---------------------------------------------------------------- 3. dsh 安装
hdr "3. dsh 安装与二进制"
if [ -n "${DATA_DIR}" ] && [ -d "${DATA_DIR}" ]; then
  # 找已安装的 dsh 版本目录(通常 DATA_DIR/dsh/<ver> 或 DATA_DIR/versions/<ver>).
  DSH_ROOT=""
  for c in "${DATA_DIR}/dsh" "${DATA_DIR}/versions" "${DATA_DIR}/installed" "${DATA_DIR}"; do
    [ -d "$c" ] && DSH_ROOT="$c" && break
  done
  # 定位真正的 lib/bin.js 或 launcher.
  DSH_LAUNCH=$(find "${DSH_ROOT:-${DATA_DIR}}" -maxdepth 4 -type f \( -name 'bin.js' -o -name 'dsh' -o -name 'main.js' \) 2>/dev/null | head -1)
  if [ -n "${DSH_LAUNCH}" ]; then
    ok "dsh 启动器存在: ${DSH_LAUNCH}"
  else
    warn "未在 ${DSH_ROOT:-${DATA_DIR}} 下找到 dsh 启动器 (可能尚未安装版本)"
  fi
else
  warn "数据目录 ${DATA_DIR:-<空>} 不存在, 跳过 dsh 安装检测"
fi

# ---------------------------------------------------------------- 4. 权限体检(重点)
hdr "4. dsh 用户读配置/工作目录权限(重点)"
check_access() {
  # $1=路径  $2=说明
  local p="$1" label="$2"
  [ -z "$p" ] && { skip "${label}: 路径为空"; return; }
  [ -e "$p" ] || { warn "${label}: ${p} 不存在"; return; }
  local owner mode
  owner=$(stat -c '%U:%G' "$p" 2>/dev/null)
  mode=$(stat -c '%a' "$p" 2>/dev/null)
  local r w x
  if [ -r "$p" ]; then r=1; else r=0; fi
  if [ -w "$p" ]; then w=1; else w=0; fi
  if [ -x "$p" ]; then x=1; else x=0; fi

  # 面板身份能否读/写/进.
  local ruid ru_ok=1
  if [ -n "${PANEL_UID}" ] && command -v su >/dev/null 2>&1; then
    if su -s /bin/sh - "${PANEL_USER}" -c "test -r '$p'" 2>/dev/null; then ruid=readable; else ruid=NO-READ; ru_ok=0; fi
  else
    ruid="(无法以面板身份验证)"
  fi

  local verdict="[owner=${owner:-?} mode=${mode:-?} r=${r} w=${w} x=${x} panel=${ruid}]"
  if [ "$r" = 1 ] && [ "$x" = 1 ]; then
    ok "${label}: ${p} ${verdict}"
  elif [ "$r" = 1 ]; then
    warn "${label}: ${p} ${verdict} (可读但不可进入目录)"
    [ "$FIX_MODE" = 1 ] && { chmod u+rwX "$p" 2>/dev/null && warn "  已 chmod u+rwX"; }
  else
    fail "${label}: ${p} ${verdict} (面板无法读取)"
    if [ "$FIX_MODE" = 1 ]; then
      if chmod u+rwX "$p" 2>/dev/null; then
        warn "  已 chmod u+rwX 修复 ${p}"
      else
        warn "  需手动修复: chown -R ${PANEL_USER:-<user>} '$p' && chmod u+rwX '$p'"
      fi
    fi
  fi
}

check_access "${DSH_HOME}" "dsh home 目录"
check_access "${DSH_HOME}/profiles" "dsh 配置目录(profiles)"
check_access "${DSH_HOME}/storages" "dsh 工作区目录(storages)"
[ -n "${DATA_DIR}" ] && check_access "${DATA_DIR}" "面板数据目录"

# 凭据文件权限(必须是 600).
hdr "5. 凭据文件权限"
CRED=""
for f in "${DSH_HOME}/.credentials.yaml" "${DATA_DIR}/.credentials.yaml" "${DSH_HOME}/.env"; do
  [ -f "$f" ] && { CRED="$f"; break; }
done
if [ -n "${CRED}" ]; then
  m=$(stat -c '%a' "$CRED" 2>/dev/null)
  if [ "$m" = "600" ]; then
    ok "${CRED} 权限 ${m} (正确 600)"
  else
    warn "${CRED} 权限 ${m} (应为 600)"
    [ "$FIX_MODE" = 1 ] && { chmod 600 "$CRED" 2>/dev/null && warn "  已 chmod 600"; }
  fi
else
  skip "未找到凭据文件(可能尚未设置 API Key)"
fi

# ---------------------------------------------------------------- 6. 配置补丁
hdr "6. webserver 配置补丁"
PATCH="${DSH_HOME}/profiles/web/cordis.patch.yml"
if [ -f "${PATCH}" ]; then
  if grep -qE '0\.0\.0\.0|\[::\]' "${PATCH}"; then
    fail "${PATCH} 含通配绑定(新版 dsh 拒绝): $(grep -E '0\.0\.0\.0|\[::\]' "${PATCH}" | head -1)"
  else
    ok "${PATCH} 无通配绑定"
  fi
else
  skip "${PATCH} 不存在(dsh 将绑定回环)"
fi

# ---------------------------------------------------------------- 7. 端口占用
hdr "7. dsh 端口占用"
PORT=""
for c in "${DATA_DIR}/port" "${DATA_DIR}/console-config.json"; do
  [ -f "$c" ] && PORT=$(grep -oE '"port"[^0-9]*[0-9]+' "$c" 2>/dev/null | grep -oE '[0-9]+' | head -1)
  [ -n "$PORT" ] && break
done
[ -z "$PORT" ] && PORT=28000
if ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
  ok "端口 ${PORT} 有监听(dsh 可能在跑)"
else
  skip "端口 ${PORT} 无监听(dsh 未运行或绑定别处)"
fi

# ---------------------------------------------------------------- 8. dsh 进程
hdr "8. dsh 进程树"
DSH_PIDS=$(pgrep -f 'bin\.js|lib/bin|dsh' 2>/dev/null | head -20)
if [ -n "${DSH_PIDS}" ]; then
  ok "发现 dsh 相关进程: $(echo ${DSH_PIDS} | tr '\n' ' ')"
  for pid in ${DSH_PIDS}; do
    rss=$(awk '/VmRSS:/{print $2" "$3}' "/proc/${pid}/status" 2>/dev/null)
    [ -n "$rss" ] && say "    pid ${pid} RSS=${rss}"
  done
else
  skip "无 dsh 进程在跑"
fi

# ---------------------------------------------------------------- 9. 直接健康探测
hdr "9. 面板 API 直连探测"
HTTP=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:28001/api/status" 2>/dev/null)
if [ "$HTTP" = "200" ]; then
  ok "GET /api/status 返回 200"
  BODY=$(curl -sS -m 5 "http://127.0.0.1:28001/api/status" 2>/dev/null)
  say "  $(echo "$BODY" | head -c 300)"
else
  fail "GET /api/status 返回 ${HTTP:-<无响应>}"
fi

# ---------------------------------------------------------------- 汇总
hdr "汇总"
say "  PASS=${PASS}  WARN=${WARN}  FAIL=${FAIL}  SKIP=${SKIP}"
if [ "$FAIL" -gt 0 ]; then
  say "  → 存在 ${FAIL} 项失败, 优先看第 4 节(权限)与第 9 节(API)."
  exit 1
else
  say "  → 全部通过 (或仅有提示项)."
  exit 0
fi
