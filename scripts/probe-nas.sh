#!/bin/sh
# probe-nas.sh — 在飞牛 fnOS 上跑, 把真实环境打印出来发回给开发者定位.
# 用法: 通过 SSH 或终端粘贴执行:  sh /path/to/probe-nas.sh
# 或直接一段段复制粘贴. 只读探测, 不改任何文件.
echo "===== fnos-dsh-manager 环境探针 $(date '+%F %T') ====="

echo "--- 1. 本应用相关环境变量 ---"
for v in TRIM_APPNAME TRIM_APPVER TRIM_APPDEST TRIM_APPDEST_VOL \
         TRIM_PKGVAR TRIM_PKGETC TRIM_PKGTMP TRIM_PKGHOME \
         TRIM_SERVICE_PORT TRIM_USERNAME TRIM_RUN_USERNAME \
         TRIM_DATA_SHARE_PATHS TRIM_API_TOKEN; do
    eval "val=\${$v:-<empty>}"
    echo "$v=$val"
done

echo "--- 2. 本应用目录树 (/var/apps/fnos-dsh-manager) ---"
ls -la /var/apps/fnos-dsh-manager 2>&1 | head -30
echo "--- target 软链指向 ---"
readlink -f /var/apps/fnos-dsh-manager/target 2>&1
readlink -f /var/apps/fnos-dsh-manager/var 2>&1
readlink -f /var/apps/fnos-dsh-manager/home 2>&1
readlink -f /var/apps/fnos-dsh-manager/etc 2>&1

echo "--- 3. node 依赖应用 (真实路径) ---"
ls -d /var/apps/nodejs_* 2>&1
for d in /var/apps/nodejs_*; do
    [ -d "$d" ] || continue
    echo "  [$d] target -> $(readlink -f "$d/target" 2>/dev/null)"
    ls "$d/target/bin" 2>/dev/null | head -10
done
echo "--- 卷下 @appcenter 的 node ---"
ls -d /vol[0-9]*/@appcenter/nodejs_* 2>&1
for d in /vol[0-9]*/@appcenter/nodejs_*; do
    [ -d "$d" ] || continue
    echo "  [$d]"
    ls "$d/bin" 2>/dev/null | head -10
    ls "$d/target/bin" 2>/dev/null | head -10
done

echo "--- 4. 可执行 node/python3 探测 ---"
for c in /var/apps/nodejs_*/target/bin/node /var/apps/nodejs_*/bin/node \
         /vol[0-9]*/@appcenter/nodejs_*/bin/node /vol[0-9]*/@appcenter/nodejs_*/target/bin/node \
         /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && echo "  NODE: $c -> $( "$c" -v 2>/dev/null )"
done
for c in /var/apps/python3*/target/bin/python3 /var/apps/python3*/bin/python3 \
         /vol[0-9]*/@appcenter/python3*/bin/python3 \
         /usr/bin/python3 /usr/local/bin/python3 /bin/python3; do
    [ -x "$c" ] && echo "  PYTHON: $c -> $( "$c" --version 2>&1 )"
done
command -v node 2>/dev/null && echo "  PATH node: $(command -v node)"
command -v python3 2>/dev/null && echo "  PATH python3: $(command -v python3)"

echo "--- 5. 数据目录内容 ---"
for d in /vol[0-9]*/@appdata/fnos-dsh-manager /var/apps/fnos-dsh-manager/var; do
    [ -d "$d" ] && { echo "  [$d]"; ls -la "$d" 2>&1 | head -30; }
done

echo "--- 6. 日志尾部 ---"
for f in /vol[0-9]*/@appdata/fnos-dsh-manager/console.log \
         /vol[0-9]*/@appdata/fnos-dsh-manager/proxy.log \
         /vol[0-9]*/@appdata/fnos-dsh-manager/install.log \
         /var/apps/fnos-dsh-manager/var/console.log \
         /var/apps/fnos-dsh-manager/var/install.log; do
    [ -f "$f" ] && { echo "  == $f =="; tail -15 "$f" 2>&1; }
done

echo "--- 7. 进程与端口 ---"
ps -ef 2>/dev/null | grep -E 'dashboard\.js|proxy\.py' | grep -v grep
echo "  28001 端口: $( (exec 3<>/dev/tcp/127.0.0.1/28001) 2>&1 && echo OPEN || echo CLOSED/REFUSED )"
ls -la /var/apps/fnos-dsh-manager/target/app.sock 2>&1

echo "--- 8. cmd/main status 实测 ---"
sh /var/apps/fnos-dsh-manager/target/cmd/main status 2>&1
echo "  status 退出码=$?"

echo "===== 探针结束 ====="
