#!/usr/bin/env python3
"""错题本远程同步服务端（协议 v2，零第三方依赖）。

端点：
  GET  /                  状态页（浏览器打开即可确认服务在跑）
  GET  /sync/manifest     已有图片清单 {"assets": ["<hash>.<ext>", ...]}
  PUT  /sync/asset/<name> 上传一张图片（请求体 = 原始字节）
  GET  /sync/asset/<name> 下载一张图片（拉取合并用；不存在 404）
  PUT  /sync/data         推送整份 data.json（请求体 = JSON 文本）
  GET  /sync/data         拉取整份 data.json（拉取合并用；尚无数据 404）

可靠性：
  - 原子写（临时文件 + rename），断电/中断不会写坏已有文件
  - data.json 每次被覆盖前自动快照进 snapshots/（保留最近 20 份，防误推送丢数据）
  - 请求体大小上限（--max-body-mb，默认 64MB），超限 413 拒收
  - GET /sync/data、GET /sync/asset 带 ETag，客户端带 If-None-Match 时回 304 省流量

协议说明见 ../docs/sync-protocol.md；桌面端在「☁ 同步」弹窗里填 http://<本机ip>:<port> 即可。

用法：
  python3 sync_server.py --dir /path/to/backup --port 8081 [--token 秘钥] [--max-body-mb 64]
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "v2"
# 图片名 = 内容哈希 + 扩展名；严格白名单，防路径穿越
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}\.(png|jpe?g|webp|gif|bmp|avif)$")
MAX_SNAPSHOTS = 20


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


def backup_data(data_path: str) -> None:
    """data.json 被覆盖前把旧版快照进 snapshots/（保留最近 MAX_SNAPSHOTS 份）。"""
    if not os.path.isfile(data_path):
        return
    snap_dir = os.path.join(os.path.dirname(data_path), "snapshots")
    try:
        os.makedirs(snap_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dst = os.path.join(snap_dir, f"data-{stamp}.json")
        n = 0
        while os.path.exists(dst):
            n += 1
            dst = os.path.join(snap_dir, f"data-{stamp}-{n}.json")
        shutil.copy2(data_path, dst)
        names = sorted(x for x in os.listdir(snap_dir) if x.startswith("data-") and x.endswith(".json"))
        for name in names[: max(0, len(names) - MAX_SNAPSHOTS)]:
            try:
                os.remove(os.path.join(snap_dir, name))
            except OSError:
                pass
    except OSError:
        # 快照失败不阻塞推送
        pass


def file_etag(path: str) -> str:
    """弱校验用的 ETag：内容哈希（文件不大，直接算）。"""
    try:
        with open(path, "rb") as f:
            return f'"{hashlib.sha1(f.read()).hexdigest()}"'
    except OSError:
        return ""


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
        n = int(length)
        limit = self.args.max_body_mb * 1024 * 1024
        if n > limit:
            # 不读请求体直接断开连接，避免错位；下一请求重新建连
            self.close_connection = True
            raise ValueError(f"请求体 {n} 字节超过上限 {limit}，已拒收")
        return self.rfile.read(n)

    def _etag_not_modified(self, etag: str) -> bool:
        """客户端带 If-None-Match 且命中 → 304 省流量（调用方据此提前返回）。"""
        inm = self.headers.get("If-None-Match")
        return bool(etag and inm and etag in inm)

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[%s] %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), self.address_string(), fmt % args))
        sys.stdout.flush()

    # ---------- 端点 ----------

    def do_GET(self) -> None:
        if self.path == "/":
            try:
                with open(self.data_path, "rb") as f:
                    db = json.loads(f.read() or b"{}")
                stat = (
                    f"{len(db.get('mistakes', []))} 道错题 / {len(db.get('notes', []))} 篇笔记 / "
                    f"{len(db.get('folders', []))} 个文件夹 / {len(db.get('tags', []))} 个预建标签"
                )
                mtime = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(self.data_path)))
            except Exception:
                stat, mtime = "尚无数据（等待第一次同步）", ""
            try:
                assets_n = len([n for n in os.listdir(self.assets_dir) if NAME_RE.match(n)])
            except FileNotFoundError:
                assets_n = 0
            self._json(200, {
                "service": "错题本远程同步服务端",
                "protocol": PROTOCOL_VERSION,
                "endpoints": [
                    "GET /sync/manifest", "PUT|GET /sync/asset/<name>", "PUT|GET /sync/data",
                ],
                "data": stat,
                "assets": assets_n,
                "lastPush": mtime,
                "dir": os.path.abspath(self.args.dir),
            })
        elif self.path == "/sync/manifest":
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            try:
                names = sorted(n for n in os.listdir(self.assets_dir) if NAME_RE.match(n))
            except FileNotFoundError:
                names = []
            self._json(200, {"assets": names})
        elif self.path == "/sync/data":
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            try:
                etag = file_etag(self.data_path)
                if self._etag_not_modified(etag):
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.end_headers()
                    return
                with open(self.data_path, "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                return self._json(404, {"error": "尚无数据：请先从任意一端推送"})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            m = re.fullmatch(r"/sync/asset/([^/]+)", self.path)
            if not m or not NAME_RE.match(m.group(1)):
                return self._json(404, {"error": "not found"})
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            path = os.path.join(self.assets_dir, m.group(1))
            if not os.path.isfile(path):
                return self._json(404, {"error": f"图片不存在：{m.group(1)}"})
            # 文件名即内容哈希，天然可作强 ETag
            etag = f'"{m.group(1)}"'
            if self._etag_not_modified(etag):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            try:
                with open(path, "rb") as f:
                    body = f.read()
            except OSError:
                return self._json(500, {"error": "读取图片失败"})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        """HEAD 与 GET 同头无体，供探活与缓存协商（/sync/data、/sync/asset）。"""
        if not self._authed():
            self.send_response(403)
            self.end_headers()
            return
        if self.path == "/sync/data":
            if os.path.isfile(self.data_path):
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("ETag", file_etag(self.data_path))
                self.send_header("Content-Length", str(os.path.getsize(self.data_path)))
            else:
                self.send_response(404)
            self.end_headers()
            return
        m = re.fullmatch(r"/sync/asset/([^/]+)", self.path)
        if m and NAME_RE.match(m.group(1)):
            path = os.path.join(self.assets_dir, m.group(1))
            if os.path.isfile(path):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("ETag", f'"{m.group(1)}"')
                self.send_header("Content-Length", str(os.path.getsize(path)))
            else:
                self.send_response(404)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_PUT(self) -> None:
        if not self._authed():
            self.close_connection = True  # 不读请求体，直接断开连接避免错位
            return self._json(403, {"error": "令牌无效"})
        try:
            data = self._read_body()
        except ValueError as e:
            return self._json(413, {"error": str(e)})

        if self.path == "/sync/data":
            try:
                json.loads(data)
            except Exception:
                return self._json(400, {"error": "请求体不是合法 JSON，已拒收（原 data.json 未动）"})
            backup_data(self.data_path)  # 覆盖前快照旧版
            atomic_write(self.data_path, data)
            return self._json(200, {"ok": True})

        m = re.fullmatch(r"/sync/asset/([^/]+)", self.path)
        name = m.group(1) if m else ""
        if not NAME_RE.match(name):
            return self._json(400, {"error": f"非法图片名：{name!r}"})
        atomic_write(os.path.join(self.assets_dir, name), data)
        self._json(200, {"ok": True})


def main() -> None:
    ap = argparse.ArgumentParser(description="错题本远程同步服务端（协议 v2：推送 + 拉取）")
    ap.add_argument("--dir", required=True, help="数据落盘目录（data.json + assets/，即桌面端可直接「合并导入」的数据目录）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0，局域网可访问）")
    ap.add_argument("--port", type=int, default=8081, help="监听端口（默认 8081）")
    ap.add_argument("--token", default=os.environ.get("SYNC_TOKEN", ""), help="可选访问令牌；也可用环境变量 SYNC_TOKEN。客户端需填相同令牌")
    ap.add_argument("--max-body-mb", type=int, default=64, help="单个请求体大小上限（MB，默认 64），超限拒收 413")
    args = ap.parse_args()

    os.makedirs(os.path.join(args.dir, "assets"), exist_ok=True)
    SyncHandler.args = args
    addr = lan_ip()
    print(f"错题本同步服务已启动：http://{args.host}:{args.port}  （协议 {PROTOCOL_VERSION}，推送 + 拉取）", flush=True)
    print(f"数据目录：{os.path.abspath(args.dir)}", flush=True)
    print(f"客户端「☁ 同步」里填：{addr}:{args.port}" + ("（需令牌）" if args.token else ""), flush=True)
    print(f"data.json 覆盖前自动快照到 snapshots/（保留最近 {MAX_SNAPSHOTS} 份）；请求体上限 {args.max_body_mb}MB", flush=True)
    print("Ctrl+C 停止", flush=True)
    try:
        ThreadingHTTPServer((args.host, args.port), SyncHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
