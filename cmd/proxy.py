#!/usr/bin/env python3
"""dsh-console fnOS 统一网关代理.

监听 Unix socket (${TRIM_APPDEST}/app.sock, 由 fnOS 统一网关转发; target 软链
指向 TRIM_APPDEST, 网关转发目标 /var/apps/{appname}/target/app.sock 与之一致),
把请求反向代理到 127.0.0.1:CONSOLE_PORT (面板自带的 HTTP 服务).

职责边界: 本代理只做五件事 ——
  1. Unix socket <-> TCP 的桥 (fnOS 网关只认 socket);
  2. 剥掉网关前缀 (/app/dsh-console), 让面板只看到它自己的路径;
  3. WebSocket 升级请求的原始字节透传 (面板的 /p/ 反代会把 dsh 的 WS 一并透过来);
  4. HTTP 响应**流式**转发 —— 上游写一段浏览器就收一段, 不在代理里缓冲整个body。
     这一条是load bearing 的: 缓冲式读取要等上游关闭才返回, 而 dsh 前端有 SSE
     与其它长连接, 上游永不关闭时代理手里握着整个响应、浏览器一个字节都收不到,
     前端等满 60 秒后抛 `Connection timed out after 60000ms`, 页面直接废掉。
  5. 转发时把 Host 重写为 127.0.0.1 并剥掉 X-Forwarded-Host: 面板的信任栅栏
     是 Host/Origin 判定, 若网关的外部 Host 透传过去, 面板会因名字不受信而
     拒绝. 保留 X-Forwarded-For, 让访问日志还能记到真实客户端 IP.

面板自己已经实现了 Host/Origin 信任栅栏, 这里**不**再做改写: 保留浏览器看到的
原始 Host, 由面板判定. 这一点和上游 dsh 本体的代理不同 —— 那个代理必须伪造
回环 Host 才能绕过 dsh 的 fence, 而本面板是要**靠** fence 做访问控制的.
"""
import http.client
import os
import socket
import socketserver
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONSOLE_PORT = int(os.environ.get("CONSOLE_PORT", "28001"))
SOCK_PATH = os.environ.get("SOCK_PATH", "/var/apps/dsh-console/target/app.sock")
BACKEND = ("127.0.0.1", CONSOLE_PORT)
GATEWAY_PREFIX = os.environ.get("GATEWAY_PREFIX", "/app/dsh-console")

# 建立上游连接 + 发出请求体 + 等响应**头**的时限。它只用来收两种半死连接:
# 客户端发一半就消失、上游根本不回响应头。**不参与响应体的传输** —— 传输
# 阶段无时限(见 Handler._stream_phase), 否则一条正常的长连接会被自己的超时
# 在数据还没到达时就掐断。
REQUEST_TIMEOUT = 300
# 每次读写的块大小。
STREAM_CHUNK = 64 * 1024
# HTML 必须整体读进来才能重写绝对路径; 超过这个上限就放弃注入、直接流式直通
# (放弃的是注入, 不是传输)。与面板的 HTML_BUFFER_CAP 同值。
HTML_BUFFER_CAP = 8 * 1024 * 1024

HOP_BY_HOP = {
    "connection", "proxy-connection", "keep-alive", "transfer-encoding",
    "te", "trailers", "proxy-authorization", "proxy-authenticate", "upgrade",
}


def _recv_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            break
        data += chunk
    return data


def _relay(sock_a, sock_b):
    """WebSocket 升级后的双向原始字节透传.

    两个 socket 都必须先切成**阻塞模式**。

    `create_connection(..., timeout=30)` 设的超时会一直附着在这个 socket 上,
    作用于之后所有的 recv/send。而下面 `recv()` 正是用来"等下一帧"的——
    WebSocket 空闲 30 秒是完全正常的（面板 15s轮询一次、或用户只是停在页面上），
    于是每次空闲满 30 秒 recv 就抛 socket.timeout，被 except 吞掉，然后 finally
    的 shutdown(SHUT_WR) 把连接关掉。前端表现为页面反复重连，日志里却什么都看不到，
    因为那个 timeout 被当成了正常结束。

    升级完成后协议本身要靠心跳保活（面板每 30s 发 ping，浏览器自动回 pong），
    这里不需要也不应该用读超时去代替它。

    半死连接清理: TCP 半关闭（对端断开但本端不知道）时 recv 会永久阻塞,
    之前这里 `t1.join(); t2.join()` 要等两端都 EOF 才返回 —— 一条半死 WS
    会永久泄漏 2 个 pump 线程 + 2 个 socket。现在任一个 pump 结束即通过
    Event 通知, 并立即关闭两端（shutdown 会让对端 recv 返回 EOF, 两个
    pump 线程都会退出）。配合 Handler.timeout 与 TCP keepalive, 彻底堵住
    线程/句柄只增不减的泄漏路径。
    """

    def to_blocking(sock):
        try:
            sock.settimeout(None)
        except Exception:
            pass

    def enable_keepalive(sock):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            # Linux 专属: 60s 空闲后 10s 间隔探测, 更快发现半死对端。
            if hasattr(socket, "TCP_KEEPIDLE"):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
            if hasattr(socket, "TCP_KEEPINTVL"):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
            if hasattr(socket, "TCP_KEEPCNT"):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
        except Exception:
            pass

    to_blocking(sock_a)
    to_blocking(sock_b)
    enable_keepalive(sock_a)
    enable_keepalive(sock_b)

    done = threading.Event()

    def pump(src, dst):
        try:
            while not done.is_set():
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            # 任一方向结束即整体收尾: 关掉两端, 让对端的 recv 也立刻返回。
            done.set()
            try:
                dst.shutdown(socket.SHUT_WR)
            except Exception:
                pass
            try:
                src.close()
            except Exception:
                pass
            try:
                dst.close()
            except Exception:
                pass

    t1 = threading.Thread(target=pump, args=(sock_a, sock_b), daemon=True)
    t2 = threading.Thread(target=pump, args=(sock_b, sock_a), daemon=True)
    t1.start()
    t2.start()
    # 任一路结束（EOF 或 done 置位）就返回, 不再等两端都 EOF。
    t1.join()
    t2.join()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dsh-console-gateway"
    # 空闲 keep-alive 连接的兜底超时: 半开连接 / 长时间没有任何新请求的连接
    # 各占一条线程, ThreadingHTTPServer 的线程只增不减。没有它, rfile.readline()
    # 会永久阻塞, 线程耗尽后整个网关停摆("时好时坏"、重启即恢复的典型形态)。
    #
    # 它**只**用于等下一个请求。一旦进来一个请求, _stream_phase() 会把两侧
    # socket 切到无超时 —— 否则一次 90 秒的上游计算或一条永不关闭的 SSE 会被
    # 这个"空闲"超时腰斩, 而它在等待期间并没有空闲。
    timeout = 60

    def log_message(self, *args):
        pass

    def strip_prefix(self, path):
        # 带 query 的前缀路径之前不做剥离（整串比较），带 query 的请求会
        # 漏剥前缀 → 面板收到 /app/.../p/...?x 的 path → 404。先去掉 query 再剥。
        bare = path.split("?", 1)[0]
        if bare == GATEWAY_PREFIX:
            return "/" + ("?" + path.split("?", 1)[1] if "?" in path else "")
        if bare.startswith(GATEWAY_PREFIX + "/"):
            stripped = bare[len(GATEWAY_PREFIX):] or "/"
            if "?" in path:
                stripped += "?" + path.split("?", 1)[1]
            return stripped
        return path

    def redirect(self, location):
        """301 到带尾斜杠的路径, 修 iframe 内相对资源路径解析错位 (白屏)."""
        try:
            self.send_response(301)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except Exception:
            pass

    def body_bytes(self):
        length = self.headers.get("Content-Length")
        if length is not None:
            if not length.strip().isdigit():
                # 非数字 CL（畸形请求）会让 keep-alive 帧失步, 必须关连接。
                self.close_connection = True
                return None
            return self.rfile.read(int(length))
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            chunks = b""
            while True:
                line = self.rfile.readline().strip()
                try:
                    size = int(line.split(b";")[0], 16)
                except Exception:
                    # 非法的 chunk size 行 → 帧失步, 关连接。
                    self.close_connection = True
                    return None
                if size == 0:
                    # 消费 trailer（直到空行）。
                    while True:
                        trailer = self.rfile.readline()
                        if trailer in (b"\r\n", b"\n", b""):
                            break
                    break
                chunks += self.rfile.read(size)
                self.rfile.readline()
            return chunks
        return None

    def fail(self, code, message):
        try:
            payload = message.encode("utf-8")
            # 状态行二次写防护: 若响应流已经开始了（如 _http_proxy 已经
            # send_response 之后再抛错），再写状态行会污染已发送的流。此时
            # 只能直接关连接，让客户端感知中断。
            if getattr(self, "_response_started", False):
                self.close_connection = True
                return
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            pass

    def _ws_proxy(self, path):
        backend = None
        try:
            backend = socket.create_connection(BACKEND, timeout=30)
            lines = ["%s %s HTTP/1.1" % (self.command, path)]
            for key, value in self.headers.items():
                low = key.lower()
                # origin 也必须剥掉：与 _http_proxy 同理，浏览器 WS 握手带
                # `Origin: http://10.11.12.13:5666`，而这里把 Host 重写成
                # `127.0.0.1`，Origin 透传过去会和 loopback Host 不一致，触发
                # 面板 isTrustedRequest 的 origin-host-mismatch → 403，/ws 推送
                # 通道经网关永远连不上。面板是 same-origin SPA，WS 握手同样来自
                # 面板自己，剥 Origin 与 _http_proxy 一样安全。
                if low in ("host", "connection", "upgrade", "content-length", "x-forwarded-host", "origin"):
                    continue
                lines.append("%s: %s" % (key, value))
            lines.append("Host: 127.0.0.1:%d" % CONSOLE_PORT)
            lines.append("Connection: Upgrade")
            lines.append("Upgrade: %s" % self.headers.get("Upgrade", "websocket"))
            backend.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin1"))

            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = backend.recv(4096)
                if not chunk:
                    break
                buf += chunk
            head, _, rest = buf.partition(b"\r\n\r\n")
            # 后端提前断开, 返回的不是完整响应头: 残缺 buf 不能当头透传。
            if b"\r\n\r\n" not in buf or not head.strip():
                self.fail(502, "upstream closed before handshake")
                return
            head_lines = head.split(b"\r\n")
            parts = head_lines[0].decode("latin1").split(" ", 2)
            code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 502
            self.send_response(code, parts[2] if len(parts) > 2 else "")
            self._response_started = True
            sent_connection = False
            sent_upgrade = False
            for header in head_lines[1:]:
                key, _, value = header.partition(b":")
                name = key.decode("latin1").strip()
                val = value.decode("latin1").strip()
                low = name.lower()
                # `connection` is hop-by-hop for ordinary responses, but on a 101
                # it IS the handshake: RFC 6455 requires the client to see
                # `Connection: Upgrade`. Dropping it as we do below and never
                # putting it back is what left the browser holding a 101 that
                # carried only `Upgrade` — an invalid handshake it rejects
                # outright, so the tunnel never comes up.
                if low in ("transfer-encoding", "content-length"):
                    continue
                if low == "connection":
                    if not sent_connection:
                        self.send_header(name, val)
                        sent_connection = True
                    continue
                if low == "upgrade" and sent_upgrade:
                    continue
                self.send_header(name, val)
                if low == "upgrade":
                    sent_upgrade = True
            if code == 101 and not sent_connection:
                # Backend dropped `Connection` from its own 101 — the browser will
                # not accept the handshake without it, so re-assert it here.
                self.send_header("Connection", "Upgrade")
            if code == 101 and not sent_upgrade:
                self.send_header("Upgrade", self.headers.get("Upgrade", "websocket"))
            self.end_headers()
            if rest:
                self.wfile.write(rest)
            if code == 101:
                self.close_connection = True
                _relay(self.connection, backend)
            else:
                # 非 101 响应（如 401/403 被面板拒绝）: rest 里可能已带部分
                # body, 已在上方 wfile.write(rest) 发出。若后端仍持有连接且
                # 还有剩余 body, 这里按 Content-Length 或 chunked 把它读干净,
                # 否则 keep-alive 连接会帧失步。同时显式关连接（WS 升级失败
                # 后这条连接通常不会复用）。
                self.close_connection = True
        except Exception as exc:
            self.fail(502, "upstream websocket error: %s" % exc)
        finally:
            try:
                if backend:
                    backend.close()
            except Exception:
                pass

    def _stream_phase(self, *socks):
        """进入请求体/响应体传输阶段: 两侧 socket 一律不设读超时。

        `timeout = 60` 的唯一职责是"空闲的 keep-alive 连接别把线程钉死", 它
        只需要作用在**等下一个请求**那一段。一旦真的进来一个请求, 这条连接就
        归本次处理管到响应结束 —— 中间可能横跨一次 90 秒的上游计算, 或一条
        上游永不关闭的 SSE。沿用那个超时等于让代理自己腰斩正常请求: 实测
        直连上游 90 秒后正常返回的响应, 经网关 60.3 秒就被掐成 502; SSE 则
        更糟, 浏览器 90 秒收到 0 字节 —— dsh 前端等满 60 秒后抛
        `Connection timed out after 60000ms`。半死对端改由 TCP keepalive 探测。
        """
        for sock in socks:
            if sock is None:
                continue
            try:
                sock.settimeout(None)
            except Exception:
                pass
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                if hasattr(socket, "TCP_KEEPIDLE"):
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
                if hasattr(socket, "TCP_KEEPINTVL"):
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
                if hasattr(socket, "TCP_KEEPCNT"):
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
            except Exception:
                pass

    def _write_chunk(self, data, chunked):
        """把一段响应体写给浏览器, 必要时自己分帧。"""
        if not data:
            return
        if chunked:
            self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        else:
            self.wfile.write(data)

    def _http_proxy(self, path):
        conn = None
        try:
            body = self.body_bytes()
            headers = {
                k: v for k, v in self.headers.items()
                if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"
            }
            # The panel's trust fence is Host/Origin-based. We rewrite Host to the
            # loopback backend, so we must also drop the gateway's X-Forwarded-Host:
            # if it survived, the panel would see the external hostname instead of
            # 127.0.0.1 and (correctly) refuse an untrusted name. X-Forwarded-For is
            # kept so the visitor log can still record the real client IP.
            #
            # Origin is dropped for the same reason: a <script type=module> load
            # carries `Origin: https://<fos-host>`, which would disagree with the
            # rewritten loopback Host and trip the panel's origin-host-mismatch
            # check (403). Since the panel is a same-origin SPA whose API calls are
            # all same-origin, the fence does not need Origin here; stripping it is
            # exactly as safe as stripping X-Forwarded-Host.
            headers.pop("X-Forwarded-Host", None)
            headers.pop("Origin", None)
            headers["Host"] = "127.0.0.1:%d" % CONSOLE_PORT
            conn = http.client.HTTPConnection(*BACKEND, timeout=REQUEST_TIMEOUT)
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            self._stream_phase(self.connection, conn.sock)

            # HEAD 响应没有 body, 但下方 _rewrite_html 与分帧都假定有 body。
            # HEAD 只回状态行 + 头, 不能写 body。
            is_head = self.command == "HEAD"
            content_type = resp.getheader("Content-Type") or ""
            declared = resp.getheader("Content-Length") or ""
            # Content-Length 由我们自己重新声明(分帧方式可能变), 逐跳头一律剥掉。
            kept = [(k, v) for k, v in resp.getheaders()
                    if k.lower() not in ("transfer-encoding", "connection", "content-length")]

            # HTML 要整体读进来才能重写绝对路径。**只在长度已知且不超过上限时**
            # 才这么做: 长度未知(分块/连接关闭定界)的 HTML 若也去 read(), 就会
            # 阻塞到收满上限或对端关闭 —— 对一个慢HTML 页面就是一次新的挂起。
            # 那种情况直接走下面的流式直通, 只是少了路径重写。
            prefix = b""
            buffered = None
            if (not is_head
                    and content_type.lower().startswith("text/html")
                    and declared.isdigit()
                    and int(declared) <= HTML_BUFFER_CAP):
                buffered = resp.read(int(declared))

            if buffered is not None:
                data = self._rewrite_html(path, content_type, buffered)
                self.send_response(resp.status)
                self._response_started = True
                for key, value in kept:
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            # 其余一律流式直通: 上游写一段, 浏览器就收一段。
            #
            # 早先这里是 `data = resp.read()` —— 把整个响应缓冲完才发出去。对
            # SSE / 任何长连接, 上游不关闭就永远读不完, 浏览器一个字节都收不到;
            # 对慢响应则被 60s 超时腰斩。dsh 前端的
            # `Connection timed out after 60000ms` 就是这条路径的产物。
            chunked = not declared.isdigit()
            if content_type.lower().startswith("text/event-stream"):
                kept.append(("Cache-Control", "no-cache, no-transform"))
                kept.append(("X-Accel-Buffering", "no"))
            self.send_response(resp.status)
            self._response_started = True
            for key, value in kept:
                self.send_header(key, value)
            if chunked:
                # 上游没给长度: 自己分帧, 否则浏览器会一直等 body 结束。
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", declared)
            self.end_headers()
            self._write_chunk(prefix, chunked)
            while True:
                # read1() 而非 read(): read(n) 会**阻塞直到凑满 n 字节**, 对
                # SSE 这种"每次上游只推几字节、然后安静很久"的响应, 它等于又
                # 做了一次缓冲 —— 帧要等凑满 64KB 才发得出去。read1() 每次最多
                # 一次系统调用, 有多少发多少, 上游写一段浏览器就收一段。
                chunk = resp.read1(STREAM_CHUNK)
                if not chunk:
                    break
                self._write_chunk(chunk, chunked)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
        except Exception as exc:
            self.fail(502, "upstream unreachable: %s" % exc)
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass
            # 把空闲 keep-alive 连接的兜底超时还回去, 否则下一轮
            # handle_one_request 里的 rfile.readline() 会永久阻塞。
            try:
                self.connection.settimeout(self.timeout)
            except Exception:
                pass

    def _rewrite_html(self, path, content_type, data):
        """dsh 的 HTML 用绝对路径 (/assets/... /api/...), 走网关时会被浏览器
        解析到网关根而逃出 /app/dsh-console/p 前缀 -> 资源 404. 这里只对 dsh
        反代路径 (/p...) 的 text/html 响应重写绝对资源路径, 加回完整网关前缀.

        面板自己的 HTML (index.html) 用相对路径, 不走这里 (path 不以 /p 开头)."""
        if not path.startswith("/p") and path != "/p":
            return data
        if not (content_type or "").lower().startswith("text/html"):
            return data
        if not isinstance(data, (bytes, bytearray)):
            return data
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return data
        prefix = GATEWAY_PREFIX + "/p"
        # src= href= action= 里的绝对路径, 跳过已是 /p 开头或协议/http 开头的.
        import re

        def sub(m):
            url = m.group(2)
            if url.startswith(("http://", "https://", "//", prefix + "/", prefix)) \
                    or url in ("/", ""):
                return m.group(0)
            if url.startswith("/"):
                # 用单引号包 URL, 避免 URL 内含双引号实体/引号时正则失配或注入。
                return "%s='%s'" % (m.group(1), prefix + url)
            return m.group(0)

        text = re.sub(r"(src|href|action)=([\"'])(/[^\"']*)\2", sub, text)
        # 绝对路径重写是主手段, 覆盖 dsh HTML 里的资源引用.
        return text.encode("utf-8")

    def _proxy(self):
        # 无尾斜杠的网关前缀 (如 /app/dsh-console) 会被浏览器当作文件路径,
        # 相对资源 assets/... 会解析错位丢失 app 段 -> 白屏。这里强制 301 到带斜杠。
        if self.path == GATEWAY_PREFIX:
            return self.redirect(GATEWAY_PREFIX + "/")
        path = self.strip_prefix(self.path)
        if (self.headers.get("Upgrade") or "").lower() == "websocket":
            self._ws_proxy(path)
        else:
            self._http_proxy(path)

    do_GET = _proxy
    do_POST = _proxy
    do_PUT = _proxy
    do_PATCH = _proxy
    do_DELETE = _proxy
    do_HEAD = _proxy
    do_OPTIONS = _proxy


class UnixServer(ThreadingHTTPServer):
    # AF_UNIX 在模块加载时求值会炸掉 Windows 开发机（那边没有这个属性），
    # 连带 TCP_LISTEN 模式也起不来。故改为在 __init__ 里惰性读取。
    address_family = None
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, path, handler):
        self.address_family = socket.AF_UNIX
        super().__init__(path, handler)


def main():
    # 生产永远走 unix socket（fnOS 网关按 ui/config 的 gatewaySocket 拨号）。
    # TCP_LISTEN 只给开发机用：Windows 的 python 没有 socket.AF_UNIX，网关这一跳
    # 在开发机上根本起不来，上传穿透这类问题就无法端到端复现。它不被设置时行为
    # 与之前完全一致。
    tcp_listen = os.environ.get("TCP_LISTEN")
    if tcp_listen:
        server = ThreadingHTTPServer(("127.0.0.1", int(tcp_listen)), Handler)
        print("dsh-console gateway (dev TCP): 127.0.0.1:%d -> 127.0.0.1:%d (prefix %s)"
              % (int(tcp_listen), CONSOLE_PORT, GATEWAY_PREFIX), flush=True)
        server.serve_forever()
        return

    for attempt in range(1, 6):
        try:
            if os.path.exists(SOCK_PATH):
                os.remove(SOCK_PATH)
            os.makedirs(os.path.dirname(SOCK_PATH) or "/tmp", exist_ok=True)
            server = UnixServer(SOCK_PATH, Handler)
            print("dsh-console gateway: %s -> 127.0.0.1:%d (prefix %s)"
                  % (SOCK_PATH, CONSOLE_PORT, GATEWAY_PREFIX), flush=True)
            server.serve_forever()
            return
        except OSError as exc:
            # fnOS may still be handing over the socket during package upgrade.
            print("bind attempt %d failed: %s" % (attempt, exc), file=sys.stderr, flush=True)
            import time
            time.sleep(attempt)
    print("FATAL: could not bind %s; gateway will report Bad Gateway" % SOCK_PATH,
          file=sys.stderr, flush=True)
    sys.exit(1)


if __name__ == "__main__":
    main()
