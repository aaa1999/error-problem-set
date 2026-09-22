#!/usr/bin/env python3
"""错题本远程同步服务端（协议 v1，零第三方依赖）。

端点：
  GET  /                  状态页（浏览器打开即可确认服务在跑）
  GET  /sync/manifest     已有图片清单 {"assets": ["<hash>.<ext>", ...]}
  PUT  /sync/asset/<name> 上传一张图片（请求体 = 原始字节）
  PUT  /sync/data         推送整份 data.json（请求体 = JSON 文本）

协议说明见 ../docs/sync-protocol.md；桌面端在「☁ 同步」弹窗里填 http://<本机ip>:<port> 即可。

用法：
  python3 sync_server.py --dir /path/to/backup --port 8080 [--token 秘钥]
"""
import argparse
import json
import os
import re
import socket
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "v1"
# 图片名 = 内容哈希 + 扩展名；严格白名单，防路径穿越
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}\.(png|jpe?g|webp|gif|bmp|avif)$")


def atomic_write(path: str, data: bytes) -> None:
    """先写同目录临时文件再替换，断电/中断不会写坏已有文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def lan_ip() -> str:
    """本机在内网中的 IP（用于启动时提示桌面端该填的地址）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 不会真的发包，只为选路由
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class SyncHandler(BaseHTTPRequestHandler):
    server_version = f"ErrorbookSync/{PROTOCOL_VERSION}"
    args: argparse.Namespace  # main() 里注入

    @property
    def assets_dir(self) -> str:
        return os.path.join(self.args.dir, "assets")

    @property
    def data_path(self) -> str:
        return os.path.join(self.args.dir, "data.json")

    # ---------- 基础工具 ----------

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        return not self.args.token or self.headers.get("X-Sync-Token") == self.args.token

    def _read_body(self) -> bytes:
        length = self.headers.get("Content-Length")
        if length is None:
            raise ValueError("缺少 Content-Length")
        return self.rfile.read(int(length))

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[%s] %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), self.address_string(), fmt % args))
        sys.stdout.flush()

    # ---------- 端点 ----------

    def do_GET(self) -> None:
        if self.path == "/":
            try:
                with open(self.data_path, "rb") as f:
                    db = json.loads(f.read() or b"{}")
                stat = f"{len(db.get('mistakes', []))} 道错题 / {len(db.get('notes', []))} 篇笔记 / {len(db.get('folders', []))} 个文件夹"
            except Exception:
                stat = "尚无数据（等待第一次同步）"
            self._json(200, {
                "service": "错题本远程同步服务端",
                "protocol": PROTOCOL_VERSION,
                "data": stat,
                "dir": os.path.abspath(self.args.dir),
            })
        elif self.path == "/sync/manifest":
            if not self._authed():
                self.close_connection = True
                return self._json(403, {"error": "令牌无效"})
            try:
                names = sorted(n for n in os.listdir(self.assets_dir) if NAME_RE.match(n))
            except FileNotFoundError:
                names = []
            self._json(200, {"assets": names})
        else:
            self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        if not self._authed():
            self.close_connection = True  # 不读请求体，直接断开连接避免错位
            return self._json(403, {"error": "令牌无效"})
        try:
            data = self._read_body()
        except ValueError as e:
            return self._json(411, {"error": str(e)})

        if self.path == "/sync/data":
            try:
                json.loads(data)
            except Exception:
                return self._json(400, {"error": "请求体不是合法 JSON，已拒收（原 data.json 未动）"})
            atomic_write(self.data_path, data)
            return self._json(200, {"ok": True})

        m = re.fullmatch(r"/sync/asset/([^/]+)", self.path)
        name = m.group(1) if m else ""
        if not NAME_RE.match(name):
            return self._json(400, {"error": f"非法图片名：{name!r}"})
        atomic_write(os.path.join(self.assets_dir, name), data)
        self._json(200, {"ok": True})


def main() -> None:
    ap = argparse.ArgumentParser(description="错题本远程同步服务端（协议 v1）")
    ap.add_argument("--dir", required=True, help="数据落盘目录（data.json + assets/，即桌面端可直接「合并导入」的数据目录）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0，局域网可访问）")
    ap.add_argument("--port", type=int, default=8080, help="监听端口（默认 8080）")
    ap.add_argument("--token", default=os.environ.get("SYNC_TOKEN", ""), help="可选访问令牌；也可用环境变量 SYNC_TOKEN。客户端需填相同令牌")
    args = ap.parse_args()

    os.makedirs(os.path.join(args.dir, "assets"), exist_ok=True)
    SyncHandler.args = args
    addr = lan_ip()
    print(f"错题本同步服务已启动：http://{args.host}:{args.port}  （协议 {PROTOCOL_VERSION}）", flush=True)
    print(f"数据目录：{os.path.abspath(args.dir)}", flush=True)
    print(f"桌面端「☁ 同步」里填：{addr}:{args.port}" + ("（需令牌）" if args.token else ""), flush=True)
    print("Ctrl+C 停止", flush=True)
    try:
        ThreadingHTTPServer((args.host, args.port), SyncHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
