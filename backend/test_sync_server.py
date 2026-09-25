#!/usr/bin/env python3
"""sync_server.py 的自测（标准库 unittest，零依赖）：多设备分槽推送 + 合并拉取。

跑法：cd backend && python3 -m unittest test_sync_server -v
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import sync_server

HOST = "127.0.0.1"


def make_db(mistakes=(), folders=(), notes=(), tags=(), pending=()):
    return {
        "version": 3,
        "mistakes": list(mistakes),
        "folders": list(folders),
        "notes": list(notes),
        "tags": list(tags),
        "pendingImports": list(pending),
    }


def mistake(mid, updated, folder_ids=(), tags=(), text="q"):
    return {
        "id": mid,
        "folderIds": list(folder_ids),
        "options": [],
        "answer": None,
        "attempts": 0,
        "wrong": 0,
        "question": [{"id": "b1", "type": "text", "text": text}],
        "analysis": [],
        "tags": list(tags),
        "createdAt": updated - 1,
        "updatedAt": updated,
    }


def folder(fid, name, parent=None, created=1):
    return {"id": fid, "name": name, "parentId": parent, "createdAt": created}


def note(nid, updated, title="n"):
    return {"id": nid, "title": title, "format": "markdown", "content": "c",
            "createdAt": updated - 1, "updatedAt": updated}


class ServerFixture(unittest.TestCase):
    """每个用例独立的临时目录 + 随机端口服务实例（用例间不共享状态）。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="errorbook-sync-test-")
        self.args = type("Args", (), {
            "dir": self.dir, "host": HOST, "port": 0,
            "token": "", "max_body_mb": 64,
        })()
        sync_server.SyncHandler.args = self.args
        self.httpd = ThreadingHTTPServer((HOST, 0), sync_server.SyncHandler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    # ---------- HTTP 小工具 ----------

    def http(self, method, path, body=None, headers=None):
        req = urllib.request.Request(f"http://{HOST}:{self.port}{path}", data=body, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def push(self, db, device=None, name=None, token=None):
        headers = {"Content-Type": "application/json"}
        if device:
            headers["X-Device-Id"] = device
        if name:
            headers["X-Device-Name"] = name
        if token:
            headers["X-Sync-Token"] = token
        return self.http("PUT", "/sync/data", json.dumps(db).encode(), headers)

    def pull(self, etag=None):
        headers = {}
        if etag:
            headers["If-None-Match"] = etag
        return self.http("GET", "/sync/data", None, headers)


class TestMultiDeviceSync(ServerFixture):
    def test_empty_404_before_any_push(self):
        status, body, _ = self.pull()
        self.assertEqual(status, 404)

    def test_push_slots_and_merged_pull(self):
        # 设备 A：m1、m2(v1)、note1，文件夹 数学(fa1)
        db_a = make_db(
            mistakes=[mistake("m1", 1000), mistake("m2", 1000, folder_ids=["fa1"], tags=["数学"])],
            folders=[folder("fa1", "数学")],
            notes=[note("n1", 1000)],
            tags=["数学"],
        )
        status, body, _ = self.push(db_a, device="desktop-a1", name="%E6%A1%8C%E9%9D%A2%E7%AB%AF")  # "桌面端"
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["device"], "desktop-a1")

        # 设备 B：m2 被编辑（updatedAt 更新）、新增 m3（挂在同名文件夹，id 不同）、note2
        db_b = make_db(
            mistakes=[mistake("m2", 2000, folder_ids=["fb1"], text="edited"), mistake("m3", 1500, folder_ids=["fb1"])],
            folders=[folder("fb1", "数学")],
            notes=[note("n2", 1200)],
        )
        status, _, _ = self.push(db_b, device="phone-b2")
        self.assertEqual(status, 200)

        status, body, _ = self.pull()
        self.assertEqual(status, 200)
        merged = json.loads(body)
        # 合并 = A ∪ B：m1 + m2 + m3，m2 取 updatedAt 更新的 B 版本
        self.assertEqual({m["id"] for m in merged["mistakes"]}, {"m1", "m2", "m3"})
        m2 = next(m for m in merged["mistakes"] if m["id"] == "m2")
        self.assertEqual(m2["question"][0]["text"], "edited")
        # 同名文件夹按路径合并成一个，且 m3 的 folderIds 重映射到统一 id（A 先推，fa1 为准）
        self.assertEqual(len(merged["folders"]), 1)
        self.assertEqual(merged["folders"][0]["id"], "fa1")
        self.assertEqual(m2["folderIds"], ["fa1"])
        self.assertEqual(next(m for m in merged["mistakes"] if m["id"] == "m3")["folderIds"], ["fa1"])
        # 笔记、标签并集
        self.assertEqual({n["id"] for n in merged["notes"]}, {"n1", "n2"})
        self.assertEqual(merged["tags"], ["数学"])

    def test_push_only_overwrites_own_slot(self):
        """B 的推送不得动 A 的槽：A 再推仍从 A 的版本出发。"""
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1")
        self.push(make_db(mistakes=[mistake("m9", 1000)]), device="phone-b2")
        # A 重新推送只有 m1+m2（不含 m9），B 的 m9 仍在合并结果里
        self.push(make_db(mistakes=[mistake("m1", 1000), mistake("m2", 1100)]), device="desktop-a1")
        status, body, _ = self.pull()
        merged = json.loads(body)
        self.assertEqual({m["id"] for m in merged["mistakes"]}, {"m1", "m2", "m9"})

    def test_same_id_older_update_does_not_win(self):
        """同 id 且推送更晚但 updatedAt 更旧：仍取 updatedAt 新的版本。"""
        self.push(make_db(mistakes=[mistake("m1", 2000, text="new")]), device="desktop-a1")
        time.sleep(0.01)
        self.push(make_db(mistakes=[mistake("m1", 1000, text="old")]), device="phone-b2")
        _, body, _ = self.pull()
        m1 = json.loads(body)["mistakes"][0]
        self.assertEqual(m1["question"][0]["text"], "new")

    def test_legacy_client_falls_into_default_slot(self):
        """不带 X-Device-Id 的 v1/v2 客户端落 default 槽，不冲掉具名设备。"""
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1")
        status, body, _ = self.push(make_db(mistakes=[mistake("mX", 1000)]))  # 无设备头
        self.assertEqual(json.loads(body)["device"], "default")
        _, body, _ = self.pull()
        self.assertEqual({m["id"] for m in json.loads(body)["mistakes"]}, {"m1", "mX"})

    def test_invalid_device_id_rejected(self):
        status, body, _ = self.push(make_db(), device="../../etc")
        self.assertEqual(status, 400)

    def test_bad_json_rejected(self):
        status, body, _ = self.http("PUT", "/sync/data", b"not-json{", {"Content-Type": "application/json", "X-Device-Id": "a"})
        self.assertEqual(status, 400)

    def test_etag_304(self):
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1")
        status, _, headers = self.pull()
        etag = headers["ETag"]
        self.assertEqual(status, 200)
        status, body, headers = self.pull(etag=etag)
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        # 再推送后 ETag 变化，旧 ETag 拉到新内容
        self.push(make_db(mistakes=[mistake("m1", 1000), mistake("m2", 1200)]), device="desktop-a1")
        status, body, _ = self.pull(etag=etag)
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["mistakes"]), 2)

    def test_status_page_lists_devices(self):
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1", name="%E6%A1%8C%E9%9D%A2%E7%AB%AF")
        status, body, _ = self.http("GET", "/")
        info = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(info["protocol"], "v3")
        dev = next(d for d in info["devices"] if d["id"] == "desktop-a1")
        self.assertEqual(dev["name"], "桌面端")  # 设备名按 URL 编码上传，服务端解码
        self.assertEqual(dev["mistakes"], 1)

    def test_root_data_json_materialized(self):
        """每次推送后根目录 data.json = 合并结果，整个目录可被桌面端直接合并导入。"""
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1")
        self.push(make_db(mistakes=[mistake("m2", 1000)]), device="phone-b2")
        with open(os.path.join(self.dir, "data.json"), encoding="utf-8") as f:
            merged = json.load(f)
        self.assertEqual({m["id"] for m in merged["mistakes"]}, {"m1", "m2"})

    def test_token_required_when_configured(self):
        old = self.args.token
        try:
            self.args.token = "secret"
            status, _, _ = self.http("GET", "/sync/manifest")
            self.assertEqual(status, 403)
            status, _, _ = self.push(make_db(), device="d")
            self.assertEqual(status, 403)
            status, _, _ = self.push(make_db(), device="d", token="secret")
            self.assertEqual(status, 200)
        finally:
            self.args.token = old

    def test_device_snapshot_before_overwrite(self):
        self.push(make_db(mistakes=[mistake("m1", 1000)]), device="desktop-a1")
        time.sleep(0.02)
        self.push(make_db(mistakes=[mistake("m1", 2000)]), device="desktop-a1")
        snap_dir = os.path.join(self.dir, "devices", "desktop-a1", "snapshots")
        snaps = [n for n in os.listdir(snap_dir) if n.startswith("data-")]
        self.assertEqual(len(snaps), 1)
        with open(os.path.join(snap_dir, snaps[0]), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["mistakes"][0]["updatedAt"], 1000)

    def test_devices_listing(self):
        self.push(make_db(mistakes=[mistake("m1", 1000)], notes=[note("n1", 1000)]), device="desktop-a1", name="%E6%A1%8C%E9%9D%A2%E7%AB%AF")
        time.sleep(0.01)
        self.push(make_db(mistakes=[mistake("m2", 1000)]), device="phone-b2", name="iPhone")
        status, body, _ = self.http("GET", "/sync/devices")
        self.assertEqual(status, 200)
        info = json.loads(body)
        self.assertEqual([d["id"] for d in info["devices"]], ["phone-b2", "desktop-a1"])  # 最近推送在前
        by_id = {d["id"]: d for d in info["devices"]}
        self.assertEqual(by_id["desktop-a1"]["name"], "桌面端")
        self.assertEqual(by_id["desktop-a1"]["mistakes"], 1)
        self.assertEqual(by_id["desktop-a1"]["notes"], 1)
        self.assertEqual(by_id["phone-b2"]["folders"], 0)

    def test_per_device_pull_returns_own_data_only(self):
        """GET /sync/data?device=<id> 返回该设备原始整库，不做任何合并。"""
        self.push(make_db(mistakes=[mistake("m1", 1000), mistake("m2", 1000, text="old")]), device="desktop-a1")
        time.sleep(0.01)
        self.push(make_db(mistakes=[mistake("m2", 2000, text="new")]), device="phone-b2")

        status, body, headers = self.http("GET", "/sync/data?device=desktop-a1")
        self.assertEqual(status, 200)
        db = json.loads(body)
        self.assertEqual({m["id"] for m in db["mistakes"]}, {"m1", "m2"})
        self.assertEqual(next(m for m in db["mistakes"] if m["id"] == "m2")["question"][0]["text"], "old")

        # ETag 协商：命中 304
        etag = headers["ETag"]
        status, body2, _ = self.http("GET", "/sync/data?device=desktop-a1", None, {"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body2, b"")

        # 未知设备 / 非法 id
        status, _, _ = self.http("GET", "/sync/data?device=nobody")
        self.assertEqual(status, 404)
        status, _, _ = self.http("GET", "/sync/data?device=..%2F..%2Fetc")
        self.assertEqual(status, 400)

        # 不带参数仍是合并视图（旧客户端兼容）
        status, body3, _ = self.pull()
        self.assertEqual({m["id"] for m in json.loads(body3)["mistakes"]}, {"m1", "m2"})
        self.assertEqual(next(m for m in json.loads(body3)["mistakes"] if m["id"] == "m2")["question"][0]["text"], "new")


class TestMergeRules(unittest.TestCase):
    """merge_dbs 纯函数用例：文件夹重映射 / 悬空引用 / 嵌套路径 / 做题清单。"""

    def test_nested_folder_paths_merge(self):
        a = make_db(
            mistakes=[mistake("m1", 1000, folder_ids=["a2"])],
            folders=[folder("a1", "数学"), folder("a2", "错题", parent="a1")],
        )
        b = make_db(
            mistakes=[mistake("m2", 1000, folder_ids=["b2"])],
            folders=[folder("b1", "数学"), folder("b2", "错题", parent="b1"), folder("b3", "笔记", parent="b1")],
        )
        merged = sync_server.merge_dbs([("A", a), ("B", b)])
        # 数学/错题 同路径合并；笔记 是 B 独有 → 3 个文件夹，m2 重映射到 A 的 a2
        self.assertEqual({f["name"] for f in merged["folders"]}, {"数学", "错题", "笔记"})
        by_name = {f["name"]: f for f in merged["folders"]}
        self.assertEqual(by_name["错题"]["parentId"], by_name["数学"]["id"])
        m2 = next(m for m in merged["mistakes"] if m["id"] == "m2")
        self.assertEqual(m2["folderIds"], [by_name["错题"]["id"]])

    def test_dangling_folder_ref_dropped(self):
        a = make_db(mistakes=[mistake("m1", 1000, folder_ids=["ghost"], tags=[])])
        merged = sync_server.merge_dbs([("A", a)])
        self.assertEqual(merged["mistakes"][0]["folderIds"], [])

    def test_updated_at_tie_later_device_wins(self):
        a = make_db(mistakes=[mistake("m1", 1000, text="A")])
        b = make_db(mistakes=[mistake("m1", 1000, text="B")])
        merged = sync_server.merge_dbs([("A", a), ("B", b)])
        self.assertEqual(merged["mistakes"][0]["question"][0]["text"], "B")

    def test_pending_and_tags_union(self):
        p1 = {"id": "p1", "folderName": "f", "createdAt": 1, "total": 2, "entries": []}
        a = make_db(tags=["a", "b"], pending=[p1])
        b = make_db(tags=["b", "c"])
        merged = sync_server.merge_dbs([("A", a), ("B", b)])
        self.assertEqual(merged["tags"], ["a", "b", "c"])
        self.assertEqual([p["id"] for p in merged["pendingImports"]], ["p1"])

    def test_multi_folder_membership_and_dedupe(self):
        a = make_db(
            mistakes=[mistake("m1", 1000, folder_ids=["f1", "f2", "f1"])],
            folders=[folder("f1", "一"), folder("f2", "二")],
        )
        merged = sync_server.merge_dbs([("A", a)])
        self.assertEqual(merged["mistakes"][0]["folderIds"], ["f1", "f2"])


class TestV2Migration(unittest.TestCase):
    def test_root_data_json_moved_to_default_slot(self):
        d = tempfile.mkdtemp(prefix="errorbook-migrate-test-")
        try:
            with open(os.path.join(d, "data.json"), "w", encoding="utf-8") as f:
                json.dump(make_db(mistakes=[mistake("m1", 1000)]), f)
            sync_server.migrate_v2_layout(d)
            self.assertFalse(os.path.exists(os.path.join(d, "data.json")))
            with open(os.path.join(d, "devices", "default", "data.json"), encoding="utf-8") as f:
                self.assertEqual(json.load(f)["mistakes"][0]["id"], "m1")
            # 幂等：devices/ 已存在时不再动
            with open(os.path.join(d, "data.json"), "w", encoding="utf-8") as f:
                json.dump(make_db(), f)
            sync_server.migrate_v2_layout(d)
            with open(os.path.join(d, "devices", "default", "data.json"), encoding="utf-8") as f:
                self.assertEqual(len(json.load(f)["mistakes"]), 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
