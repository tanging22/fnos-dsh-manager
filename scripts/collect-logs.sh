#!/bin/bash
# collect-logs.sh — fnos-dsh-manager 排错信息采集
# 在 NAS 上跑(ssh 或 fnOS 终端), 把内嵌页 Bad Gateway 相关的关键信息打包成一份,
# 发给本小姐分析. 只读不写, 不改动任何运行状态.
set -u

APP_NAME="fnos-dsh-manager"
OUT="/tmp/${APP_NAME}-diagnose.txt"
: > "${OUT}"

say() { printf '%s\n' "$*" >> "${OUT}"; }
hdr() { printf '\n========== %s ==========\n' "$*" >> "${OUT}"; }

# 1. 环境变量(网关注入的)
hdr "TRIM env"
env | grep -E '^TRIM_|^CONSOLE_|^GATEWAY_|^SOCK_' | sort >> "${OUT}" 2>/dev/null

# 2. 应用目录结构 + 软链目标
hdr "app dir"
APP_DIR="/var/apps/${APP_NAME}"
say "APP_DIR=${APP_DIR}"
ls -la "${APP_DIR}" >> "${OUT}" 2>&1
say "--- target 软链 ---"
readlink -f "${APP_DIR}/target" >> "${OUT}" 2>&1 || true
readlink -f "${APP_DIR}/var"    >> "${OUT}" 2>&1 || true
readlink -f "${APP_DIR}/home"   >> "${OUT}" 2>&1 || true

# 3. socket 是否真的建出来
hdr "socket"
say "SOCK_PATH=${APP_DIR}/target/app.sock"
ls -la "${APP_DIR}/target/app.sock" >> "${OUT}" 2>&1 || say "socket 不存在"

# 4. 面板端口 28001 是否在监听
hdr "port 28001"
(exec 3<>/dev/tcp/127.0.0.1/28001) >> "${OUT}" 2>&1 && say "28001 open" || say "28001 closed/refused"

# 5. 进程状态
hdr "processes"
ps aux | grep -E 'dashboard\.js|proxy\.py|fnos-dsh-manager' | grep -v grep >> "${OUT}" 2>&1
say "--- 完整 cmdline ---"
for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "${p}/cmdline" 2>/dev/null || true)
    case "${c}" in
        *dashboard.js*|*proxy.py*) say "pid=${p##*/} :: ${c}" ;;
    esac
done

# 6. 日志(DATA_DIR 定位)
hdr "logs"
DATA_DIR=""
for cand in "${TRIM_PKGVAR:-}" "/vol1/@appdata/${APP_NAME}" "/vol2/@appdata/${APP_NAME}" "/vol3/@appdata/${APP_NAME}" "${APP_DIR}/var"; do
    [ -n "${cand}" ] && [ -f "${cand}/console.log" ] && { DATA_DIR="${cand}"; break; }
done
say "DATA_DIR=${DATA_DIR:-<未找到>}"
if [ -n "${DATA_DIR}" ]; then
    say "===== console.log (最后 80 行) ====="
    tail -n 80 "${DATA_DIR}/console.log" >> "${OUT}" 2>&1 || say "无 console.log"
    say "===== proxy.log (最后 80 行) ====="
    tail -n 80 "${DATA_DIR}/proxy.log" >> "${OUT}" 2>&1 || say "无 proxy.log"
fi

# 7. 面板配置
hdr "config"
for f in "${APP_DIR}/var/console-config.json" "/vol1/@appdata/${APP_NAME}/console-config.json" "${DATA_DIR}/console-config.json"; do
    [ -f "$f" ] && { say "--- $f ---"; cat "$f" >> "${OUT}" 2>&1; }
done

# 8. 直连面板回环探测(不经过网关)
hdr "direct panel probe"
curl -sS -m 5 -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:28001/api/status" >> "${OUT}" 2>&1 || say "curl 直连失败"

echo "诊断信息已写入: ${OUT}"
echo "把它的内容发给我(或 cat ${OUT})"
