#!/bin/bash
# start-debug.sh — 手动启动 dsh-console 面板并抓取诊断信息
# 用法: 在 NAS 上以 root 运行:  bash start-debug.sh
set -u

APP=/var/apps/dsh-console
MAIN="${APP}/cmd/main"

echo "===== start-debug $(date '+%F %T') ====="

echo "--- 0. main 真实位置 ---"
ls -l "${MAIN}" 2>&1 || echo "MISSING: ${MAIN}"

echo
echo "--- 1. TRIM_APPDEST (target) 内容与权限 ---"
echo "TRIM_APPDEST = $(readlink -f "${APP}/target" 2>/dev/null)"
ls -la "$(readlink -f "${APP}/target" 2>/dev/null)" 2>&1 | head -40

echo
echo "--- 2. target 目录可写性测试 (socket 要建在这里) ---"
TDIR="$(readlink -f "${APP}/target" 2>/dev/null)"
if [ -n "${TDIR}" ]; then
    if touch "${TDIR}/.wtest" 2>/dev/null; then
        echo "WRITABLE: ${TDIR}"
        rm -f "${TDIR}/.wtest"
    else
        echo "READONLY: ${TDIR}  (touch 失败)"
    fi
fi

echo
echo "--- 3. cmd/main status (正确路径) ---"
bash "${MAIN}" status
echo "status 退出码 = $?   (0=运行 3=停止)"

echo
echo "--- 4. 手动 start ---"
bash "${MAIN}" start
echo "start 退出码 = $?"

echo
echo "--- 5. start 之后的状态 ---"
sleep 2
echo "-- 28001 端口 --"
bash -c "exec 3<>/dev/tcp/127.0.0.1/28001" 2>&1 && echo "28001 OPEN" || echo "28001 CLOSED/REFUSED"
echo "-- socket --"
ls -l "${TDIR}/app.sock" 2>&1 || echo "no app.sock"
echo "-- 进程 --"
ps aux 2>/dev/null | grep -E 'dashboard\.js|proxy\.py' | grep -v grep || echo "no panel/proxy process"

echo
echo "--- 6. 日志尾部 ---"
for f in /vol1/@appdata/dsh-console/console.log /vol1/@appdata/dsh-console/proxy.log; do
    echo "== ${f} =="
    tail -30 "${f}" 2>&1 || echo "(不存在)"
done

echo
echo "--- 7. @appcenter 里的 ui 位置确认 ---"
ls -d "${TDIR}/ui" 2>&1 || echo "no ${TDIR}/ui"
ls -d "${TDIR}/target/ui" 2>&1 || echo "no ${TDIR}/target/ui"

echo
echo "===== 结束 ====="
