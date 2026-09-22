import { join } from "@tauri-apps/api/path";
import { exists, readFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import type { Database } from "../types";
import { collectAssetRefs } from "./markdown";

/**
 * 远程同步（推送）：把整库推到自建服务端，协议见 docs/sync-protocol.md。
 * 流程：GET /sync/manifest 拿服务端已有图片清单 → 只 PUT 缺的图片 → PUT /sync/data 推整份库。
 * 图片文件名即内容哈希，天然幂等：重跑时已上传的会出现在清单里被跳过。
 */

const TARGET_KEY = "errorbook.sync.server";

export interface SyncTarget {
  /** 形如 http://192.168.1.100:8080（仅 scheme://host:port，无路径无尾斜杠） */
  server: string;
  /** 可选访问令牌，经 X-Sync-Token 头发送；服务端未启用验证则留空 */
  token?: string;
}

export function loadSyncTarget(): SyncTarget | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as SyncTarget | null;
    return t && typeof t.server === "string" && t.server ? t : null;
  } catch {
    return null;
  }
}

export function saveSyncTarget(t: SyncTarget) {
  localStorage.setItem(TARGET_KEY, JSON.stringify(t));
}

export function clearSyncTarget() {
  localStorage.removeItem(TARGET_KEY);
}

/** "192.168.1.5:8080" / "http://host:port/…" → 规范 origin（自动补 http://）；无效返回 null */
export function normalizeServerAddr(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** 全库引用到的图片文件名集合（错题 blocks + 笔记正文），与合并导入的收集口径一致 */
export function collectLibraryAssets(db: Database): Set<string> {
  const keys = new Set<string>();
  for (const m of db.mistakes)
    for (const b of [...m.question, ...m.analysis]) if (b.type === "image") keys.add(`${b.hash}.${b.ext}`);
  for (const n of db.notes) for (const ref of collectAssetRefs(n.content)) keys.add(ref.slice("assets/".length));
  return keys;
}

export interface SyncProgress {
  phase: "connect" | "assets" | "data";
  /** 已完成的图片数 */
  done: number;
  /** 待上传图片总数 */
  total: number;
  /** 正在上传的文件名 */
  current?: string;
}

export interface SyncResult {
  /** 本次实际上传的图片数 */
  uploadedAssets: number;
  /** 本地引用了但文件缺失、被跳过的图片数 */
  missingLocal: number;
  /** 本库引用到的图片总数 */
  totalAssets: number;
  mistakes: number;
  notes: number;
  folders: number;
}

/** 用户中止：在逐张上传的间隙抛出 */
export class SyncAborted extends Error {
  constructor(public uploaded: number) {
    super("已中止");
  }
}

type Init = RequestInit & { connectTimeout?: number };

function authHeaders(target: SyncTarget): Record<string, string> {
  return target.token ? { "X-Sync-Token": target.token } : {};
}

async function request(url: string, init: Init, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`无法连接服务器（${what}）：请检查地址、端口与网络。${String(e)}`);
  }
}

function denyError(status: number): Error {
  return new Error(`服务器拒绝：令牌无效或未授权（HTTP ${status}）`);
}

/**
 * 推送整库到 target。幂等可重入：中断后重新执行，已传过的图片自动跳过。
 */
export async function pushToServer(
  target: SyncTarget,
  db: Database,
  dataDir: string,
  onProgress: (p: SyncProgress) => void,
  isAborted: () => boolean,
): Promise<SyncResult> {
  const base = target.server;

  // 1. 服务端图片清单
  onProgress({ phase: "connect", done: 0, total: 0 });
  const mres = await request(`${base}/sync/manifest`, { method: "GET", headers: authHeaders(target), connectTimeout: 5000 }, "获取清单");
  if (mres.status === 401 || mres.status === 403) throw denyError(mres.status);
  if (mres.status === 404) throw new Error("该地址不是错题同步服务端（/sync/manifest 返回 404），请确认地址与端口");
  if (!mres.ok) throw new Error(`获取清单失败：HTTP ${mres.status}`);
  const manifest = (await mres.json().catch(() => null)) as { assets?: unknown } | null;
  if (!manifest || !Array.isArray(manifest.assets)) {
    throw new Error("该地址不是错题同步服务端：/sync/manifest 响应的不是本协议的 { assets: [...] }");
  }
  const serverAssets = new Set(manifest.assets.filter((x): x is string => typeof x === "string"));

  // 2. 逐张上传服务端缺的图片
  const local = collectLibraryAssets(db);
  const missing = [...local].filter(k => !serverAssets.has(k));
  let done = 0;
  let missingLocal = 0;
  for (const key of missing) {
    if (isAborted()) throw new SyncAborted(done);
    onProgress({ phase: "assets", done, total: missing.length, current: key });
    const path = await join(dataDir, "assets", key);
    if (!(await exists(path))) {
      // 本地文件缺失：保留引用跳过（与合并导入对缺失源图的处理一致）
      missingLocal++;
      done++;
      continue;
    }
    const bytes = await readFile(path);
    const res = await request(
      `${base}/sync/asset/${key}`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...authHeaders(target) }, body: bytes },
      `上传 ${key}`,
    );
    if (res.status === 401 || res.status === 403) throw denyError(res.status);
    if (!res.ok) throw new Error(`上传图片 ${key} 失败：HTTP ${res.status}`);
    done++;
  }

  // 3. 推送整份库（与磁盘 data.json 相同的序列化格式，覆盖式，最后推送为准）
  if (isAborted()) throw new SyncAborted(done);
  onProgress({ phase: "data", done, total: missing.length });
  const dres = await request(
    `${base}/sync/data`,
    { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders(target) }, body: JSON.stringify(db, null, 2) },
    "推送题库数据",
  );
  if (dres.status === 401 || dres.status === 403) throw denyError(dres.status);
  if (!dres.ok) throw new Error(`推送题库数据失败：HTTP ${dres.status}`);

  return {
    uploadedAssets: done - missingLocal,
    missingLocal,
    totalAssets: local.size,
    mistakes: db.mistakes.length,
    notes: db.notes.length,
    folders: db.folders.length,
  };
}
