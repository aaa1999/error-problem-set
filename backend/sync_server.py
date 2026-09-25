#!/usr/bin/env python3
"""错题本远程同步服务端（协议 v3，零第三方依赖）。

多设备模型（v3 核心变化）：
  - 推送按「设备」分槽存储：devices/<设备id>/data.json，一次推送只覆盖
    该设备自己的最新版本，不再冲掉其他设备的数据；
  - 拉取返回全部设备最新推送的**合并结果**：错题/笔记按 id 取 updatedAt
    最新的版本、文件夹按「名称+父级路径」合并并重映射错题所属、预建标签
    与做题清单取并集——多台设备各自录入，任意一端拉取都能拿到全集；
  - 未带 X-Device-Id 的旧客户端（v1/v2）一律落到 default 槽，行为与旧版
    「最后推送为准」一致，不会写坏其他设备的槽位。

端点：
  GET  /                  状态页（设备清单 + 合并统计，浏览器打开即可确认服务在跑）
  GET  /sync/manifest     已有图片清单 {"assets": ["<hash>.<ext>", ...]}
  PUT  /sync/asset/<name> 上传一张图片（请求体 = 原始字节）
  GET  /sync/asset/<name> 下载一张图片（不存在 404）
  PUT  /sync/data         推送整份 data.json 到**本设备**的槽位（请求头 X-Device-Id / X-Device-Name）
  GET  /sync/data         拉取**所有设备合并后**的整份题库（旧客户端 / 整库备份用）
  GET  /sync/devices      设备清单：[{id, name, lastPush, 规模统计}, ...]（按设备拉取的第一步）
  GET  /sync/data?device=<id>  拉取**指定设备**的原始整库（不合并，客户端按设备分开落盘）

可靠性：
  - 原子写（临时文件 + rename），断电/中断不会写坏已有文件
  - 每个设备的 data.json 被覆盖前自动快照进 devices/<id>/snapshots/（保留最近 10 份）
  - 每次推送后把合并结果物化到根目录 data.json，整个 --dir 仍是合法的
    错题本数据目录，可被桌面端「合并导入」直接消费
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
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "v3"
# 图片名 = 内容哈希 + 扩展名；严格白名单，防路径穿越
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}\.(png|jpe?g|webp|gif|bmp|avif)$")
# 设备 id：客户端生成并持久化的随机标识；同样白名单校验防路径穿越
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_SNAPSHOTS = 10
MAX_DEVICE_NAME = 64
# 合并语义里的空库：没有任何设备推送过（不是「推送了空库」）
LEGACY_DEVICE = "default"


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
    """data.json 被覆盖前把旧版快照进同级 snapshots/（保留最近 MAX_SNAPSHOTS 份）。"""
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


# ---------- 多设备合并核心（与桌面端 lib/merge.ts 同一套口径，方向相反：服务端合多设备） ----------

def _name_chain(folder: dict, by_id: dict) -> list:
    """从根到该文件夹的名称链（设备内部按 parentId 上溯，环与断链保护）。"""
    names = [str(folder.get("name") or "")]
    pid = folder.get("parentId")
    guard = 0
    while pid and guard < 64:
        parent = by_id.get(pid)
        if not parent:
            break
        names.append(str(parent.get("name") or ""))
        pid = parent.get("parentId")
        guard += 1
    return names[::-1]


def merge_dbs(entries: list) -> dict:
    """把多个设备各自推送的整库合并成一份（拉取与统计共用）。

    entries: [(device_id, db_dict), ...]，按推送时间从旧到新排列。
    规则：
      - 错题/笔记按 id 合并，同 id 取 updatedAt 最大者（相同则后推送的设备胜出）
      - 文件夹按「名称+父级」路径合并成统一树，首个出现的 id 为准；
        每台设备的文件夹 id 都映射到统一树，错题的 folderIds 随之重映射，
        映射不到的引用（悬空 id）剔除
      - 预建标签按序并集；做题清单按 id 并集
    """
    mistakes: dict = {}   # id -> (updatedAt, device_id, mistake)
    notes: dict = {}
    pending: dict = {}
    tags: list = []
    tag_seen: set = set()
    folders: list = []
    canon_by_path: dict = {}  # 名称链 tuple -> 统一文件夹
    id_maps: dict = {}        # device_id -> {该设备的文件夹id -> 统一文件夹id}

    for did, db in entries:
        raw_folders = db.get("folders") if isinstance(db.get("folders"), list) else []
        by_id = {f.get("id"): f for f in raw_folders if isinstance(f, dict) and f.get("id")}
        fmap = {}
        for f in sorted(raw_folders, key=lambda x: len(_name_chain(x, by_id))):
            if not isinstance(f, dict) or not f.get("id"):
                continue
            chain = tuple(_name_chain(f, by_id))
            if chain in canon_by_path:
                fmap[f["id"]] = canon_by_path[chain]["id"]
                continue
            parent_chain = chain[:-1]
            canon = {
                "id": f["id"],  # 首个出现的 id 即统一 id
                "name": f.get("name"),
                "parentId": canon_by_path[parent_chain]["id"] if parent_chain else None,
                "createdAt": f.get("createdAt") or 0,
            }
            canon_by_path[chain] = canon
            folders.append(canon)
            fmap[f["id"]] = canon["id"]
        id_maps[did] = fmap

        raw_mistakes = db.get("mistakes") if isinstance(db.get("mistakes"), list) else []
        for m in raw_mistakes:
            if not isinstance(m, dict) or not m.get("id"):
                continue
            ua = m.get("updatedAt") or 0
            prev = mistakes.get(m["id"])
            if prev is None or ua >= prev[0]:  # >= 平局时后推送的设备胜出
                mistakes[m["id"]] = (ua, did, m)
        raw_notes = db.get("notes") if isinstance(db.get("notes"), list) else []
        for n in raw_notes:
            if not isinstance(n, dict) or not n.get("id"):
                continue
            ua = n.get("updatedAt") or 0
            prev = notes.get(n["id"])
            if prev is None or ua >= prev[0]:
                notes[n["id"]] = (ua, did, n)
        raw_tags = db.get("tags") if isinstance(db.get("tags"), list) else []
        for t in raw_tags:
            if isinstance(t, str) and t and t not in tag_seen:
                tag_seen.add(t)
                tags.append(t)
        raw_pending = db.get("pendingImports") if isinstance(db.get("pendingImports"), list) else []
        for p in raw_pending:
            if isinstance(p, dict) and p.get("id"):
                pending[p["id"]] = p  # 同 id 即同一份清单，内容一致，后者覆盖无妨

    out_mistakes = []
    for ua, did, m in mistakes.values():
        fmap = id_maps.get(did, {})
        seen = set()
        folder_ids = []
        for fid in m.get("folderIds") or []:
            cid = fmap.get(fid)
            if cid and cid not in seen:
                seen.add(cid)
                folder_ids.append(cid)
        out = dict(m)
        out["folderIds"] = folder_ids
        out_mistakes.append(out)

    return {
        "version": 3,
        "mistakes": out_mistakes,
        "folders": folders,
        "notes": [n for _, _, n in notes.values()],
        "tags": tags,
        "pendingImports": list(pending.values()),
    }


class SyncHandler(BaseHTTPRequestHandler):
    server_version = f"ErrorbookSync/{PROTOCOL_VERSION}"
    args: argparse.Namespace  # main() 里注入
    # 设备槽写入与合并读之间的互斥（临界区都是 KB 级操作，粗粒度锁足够）
    lock = threading.Lock()

    @property
    def assets_dir(self) -> str:
        return os.path.join(self.args.dir, "assets")

    @property
    def devices_dir(self) -> str:
        return os.path.join(self.args.dir, "devices")

    @property
    def merged_path(self) -> str:
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

    def _split_path(self) -> tuple:
        """路径与查询参数分开（/sync/data?device=<id> 用）；query 值取首个。"""
        u = urllib.parse.urlsplit(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        return u.path, query

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[%s] %s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), self.address_string(), fmt % args))
        sys.stdout.flush()

    # ---------- 设备槽读写 ----------

    def _device_id(self) -> str:
        """X-Device-Id 缺失（旧客户端）落 default 槽；带了但非法直接拒（400 由调用方回）。"""
        did = (self.headers.get("X-Device-Id") or "").strip()
        if not did:
            return LEGACY_DEVICE
        return did if DEVICE_ID_RE.match(did) else ""

    def _device_dir(self, did: str) -> str:
        return os.path.join(self.devices_dir, did)

    def _device_meta(self, did: str) -> dict:
        try:
            with open(os.path.join(self._device_dir(did), "meta.json"), "r", encoding="utf-8") as f:
                meta = json.load(f)
            return meta if isinstance(meta, dict) else {}
        except (OSError, ValueError):
            return {}

    def _load_devices(self) -> list:
        """全部设备槽：[(mtime, device_id, db), ...] 按推送时间从旧到新。损坏的槽跳过不拖垮合并。"""
        entries = []
        try:
            names = sorted(os.listdir(self.devices_dir))
        except FileNotFoundError:
            return []
        for did in names:
            data_path = os.path.join(self.devices_dir, did, "data.json")
            if not DEVICE_ID_RE.match(did) or not os.path.isfile(data_path):
                continue
            try:
                with open(data_path, "rb") as f:
                    db = json.loads(f.read() or b"{}")
                if not isinstance(db, dict):
                    continue
                entries.append((os.path.getmtime(data_path), did, db))
            except (OSError, ValueError) as e:
                print(f"[警告] 设备 {did} 的 data.json 无法解析，已跳过合并：{e}", file=sys.stderr, flush=True)
        entries.sort(key=lambda x: (x[0], x[1]))
        return [(did, db) for _, did, db in entries]

    def _merged_bytes(self, devices: list) -> bytes:
        return json.dumps(merge_dbs(devices), ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _materialize_merged(self, merged: dict) -> None:
        """把合并结果物化到根 data.json：让 --dir 整体仍是合法的错题本数据目录（可拷走直接合并导入）。"""
        atomic_write(self.merged_path, json.dumps(merged, ensure_ascii=False, indent=2).encode("utf-8"))

    # ---------- 端点 ----------

    def do_GET(self) -> None:
        path, query = self._split_path()
        if path == "/":
            with self.lock:
                devices = self._load_devices()
                merged = merge_dbs(devices)
            device_list = []
            for did, db in devices:
                meta = self._device_meta(did)
                device_list.append({
                    "id": did,
                    "name": meta.get("name") or did,
                    "lastPush": meta.get("lastPush") or "",
                    "mistakes": len(db.get("mistakes") or []),
                    "notes": len(db.get("notes") or []),
                })
            self._json(200, {
                "service": "错题本远程同步服务端",
                "protocol": PROTOCOL_VERSION,
                "endpoints": [
                    "GET /sync/manifest", "PUT|GET /sync/asset/<name>", "PUT|GET /sync/data",
                    "GET /sync/devices", "GET /sync/data?device=<id>",
                ],
                "merged": (
                    f"{len(merged['mistakes'])} 道错题 / {len(merged['notes'])} 篇笔记 / "
                    f"{len(merged['folders'])} 个文件夹 / {len(merged['tags'])} 个预建标签"
                ),
                "devices": device_list,
                "assets": self._asset_count(),
                "dir": os.path.abspath(self.args.dir),
            })
        elif path == "/sync/manifest":
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            self._json(200, {"assets": self._asset_names()})
        elif path == "/sync/devices":
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            with self.lock:
                devices = self._load_devices()  # 按推送时间从旧到新
            device_list = []
            for did, db in reversed(devices):  # 展示按最近推送在前
                meta = self._device_meta(did)
                device_list.append({
                    "id": did,
                    "name": meta.get("name") or did,
                    "lastPush": meta.get("lastPush") or "",
                    "mistakes": len(db.get("mistakes") or []),
                    "notes": len(db.get("notes") or []),
                    "folders": len(db.get("folders") or []),
                    "tags": len(db.get("tags") or []),
                })
            self._json(200, {"devices": device_list})
        elif path == "/sync/data":
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            did = query.get("device", "")
            if did:
                # 按设备取原始整库（不合并；客户端分设备落盘用）
                if not DEVICE_ID_RE.match(did):
                    return self._json(400, {"error": f"非法设备 id：{did!r}"})
                data_path = os.path.join(self.devices_dir, did, "data.json")
                try:
                    with open(data_path, "rb") as f:
                        body = f.read()
                except OSError:
                    return self._json(404, {"error": f"设备不存在或尚未推送：{did}"})
                etag = f'"{hashlib.sha1(body).hexdigest()}"'
                if self._etag_not_modified(etag):
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("ETag", etag)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            with self.lock:
                devices = self._load_devices()
                if not devices:
                    return self._json(404, {"error": "尚无数据：请先从任意一端推送"})
                try:
                    body = self._merged_bytes(devices)
                except Exception as e:
                    return self._json(500, {"error": f"合并设备数据失败：{e}"})
            etag = f'"{hashlib.sha1(body).hexdigest()}"'
            if self._etag_not_modified(etag):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            m = re.fullmatch(r"/sync/asset/([^/]+)", path)
            if not m or not NAME_RE.match(m.group(1)):
                return self._json(404, {"error": "not found"})
            if not self._authed():
                return self._json(403, {"error": "令牌无效"})
            fpath = os.path.join(self.assets_dir, m.group(1))
            if not os.path.isfile(fpath):
                return self._json(404, {"error": f"图片不存在：{m.group(1)}"})
            # 文件名即内容哈希，天然可作强 ETag
            etag = f'"{m.group(1)}"'
            if self._etag_not_modified(etag):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            try:
                with open(fpath, "rb") as f:
                    body = f.read()
            except OSError:
                return self._json(500, {"error": "读取图片失败"})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _asset_names(self) -> list:
        try:
            return sorted(n for n in os.listdir(self.assets_dir) if NAME_RE.match(n))
        except FileNotFoundError:
            return []

    def _asset_count(self) -> int:
        return len(self._asset_names())

    def do_HEAD(self) -> None:
        """HEAD 与 GET 同头无体，供探活与缓存协商（/sync/data、/sync/asset）。"""
        if not self._authed():
            self.send_response(403)
            self.end_headers()
            return
        path, query = self._split_path()
        if path == "/sync/data":
            did = query.get("device", "")
            if did:
                # 按设备：HEAD 同 GET 头无体
                if not DEVICE_ID_RE.match(did):
                    self.send_response(400)
                    self.end_headers()
                    return
                try:
                    with open(os.path.join(self.devices_dir, did, "data.json"), "rb") as f:
                        body = f.read()
                except OSError:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("ETag", f'"{hashlib.sha1(body).hexdigest()}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return
            with self.lock:
                devices = self._load_devices()
                if not devices:
                    self.send_response(404)
                    self.end_headers()
                    return
                try:
                    body = self._merged_bytes(devices)
                except Exception:
                    self.send_response(500)
                    self.end_headers()
                    return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("ETag", f'"{hashlib.sha1(body).hexdigest()}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return
        m = re.fullmatch(r"/sync/asset/([^/]+)", path)
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

        path, _ = self._split_path()
        if path == "/sync/data":
            try:
                db = json.loads(data)
                if not isinstance(db, dict):
                    raise ValueError("顶层不是 JSON 对象")
            except Exception:
                return self._json(400, {"error": "请求体不是合法的题库 JSON，已拒收（服务端数据未动）"})
            did = self._device_id()
            if not did:
                return self._json(400, {"error": "X-Device-Id 含非法字符（仅允许字母数字-_，最长 64）"})
            # 设备名：客户端按 URL 编码发送（HTTP 头不能直接放中文），限长防滥用
            raw_name = (self.headers.get("X-Device-Name") or "").strip()
            try:
                name = urllib.parse.unquote(raw_name)[:MAX_DEVICE_NAME]
            except Exception:
                name = ""
            with self.lock:
                dev_dir = self._device_dir(did)
                data_path = os.path.join(dev_dir, "data.json")
                backup_data(data_path)  # 覆盖前快照该设备的旧版
                atomic_write(data_path, data)
                meta = self._device_meta(did)
                atomic_write(
                    os.path.join(dev_dir, "meta.json"),
                    json.dumps({
                        "name": name or meta.get("name") or did,
                        "lastPush": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "pushCount": int(meta.get("pushCount") or 0) + 1,
                    }, ensure_ascii=False).encode("utf-8"),
                )
                devices = self._load_devices()
                merged = merge_dbs(devices)
                self._materialize_merged(merged)
            return self._json(200, {
                "ok": True,
                "device": did,
                "merged": {
                    "mistakes": len(merged["mistakes"]),
                    "notes": len(merged["notes"]),
                    "folders": len(merged["folders"]),
                    "devices": len(devices),
                },
            })

        m = re.fullmatch(r"/sync/asset/([^/]+)", path)
        name = m.group(1) if m else ""
        if not NAME_RE.match(name):
            return self._json(400, {"error": f"非法图片名：{name!r}"})
        atomic_write(os.path.join(self.assets_dir, name), data)
        self._json(200, {"ok": True})


def migrate_v2_layout(dir_path: str) -> None:
    """旧版（v1/v2）单文件布局迁移：根 data.json 挪进 devices/default/。

    迁移后旧客户端（不带 X-Device-Id）的推送同样落 default 槽，行为连续、无数据分裂。
    v3 每次推送会把合并结果重新物化到根 data.json，因此以 devices/ 目录是否已存在
    判断是否首次迁移，不会反复搬动。
    """
    old = os.path.join(dir_path, "data.json")
    devices = os.path.join(dir_path, "devices")
    if not os.path.isfile(old) or os.path.isdir(devices):
        return
    dev_dir = os.path.join(devices, LEGACY_DEVICE)
    os.makedirs(dev_dir, exist_ok=True)
    shutil.move(old, os.path.join(dev_dir, "data.json"))
    print(f"已把旧版单文件 data.json 迁移到 {LEGACY_DEVICE} 设备槽（devices/{LEGACY_DEVICE}/data.json）", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="错题本远程同步服务端（协议 v3：按设备分槽推送 + 全设备合并拉取）")
    ap.add_argument("--dir", required=True, help="数据落盘目录（devices/ + assets/ + 合并结果 data.json，可被桌面端「合并导入」直接消费）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0，局域网可访问）")
    ap.add_argument("--port", type=int, default=8081, help="监听端口（默认 8081）")
    ap.add_argument("--token", default=os.environ.get("SYNC_TOKEN", ""), help="可选访问令牌；也可用环境变量 SYNC_TOKEN。客户端需填相同令牌")
    ap.add_argument("--max-body-mb", type=int, default=64, help="单个请求体大小上限（MB，默认 64），超限拒收 413")
    args = ap.parse_args()

    os.makedirs(os.path.join(args.dir, "assets"), exist_ok=True)
    migrate_v2_layout(args.dir)
    SyncHandler.args = args
    addr = lan_ip()
    print(f"错题本同步服务已启动：http://{args.host}:{args.port}  （协议 {PROTOCOL_VERSION}，多设备分槽推送 + 合并拉取）", flush=True)
    print(f"数据目录：{os.path.abspath(args.dir)}", flush=True)
    print(f"客户端「☁ 同步」里填：{addr}:{args.port}" + ("（需令牌）" if args.token else ""), flush=True)
    print(f"每设备覆盖前自动快照（保留最近 {MAX_SNAPSHOTS} 份）；请求体上限 {args.max_body_mb}MB", flush=True)
    print("Ctrl+C 停止", flush=True)
    try:
        ThreadingHTTPServer((args.host, args.port), SyncHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
