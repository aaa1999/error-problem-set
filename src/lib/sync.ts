import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readFile, readTextFile, remove, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import type { Database } from "../types";
import { normalizeDb } from "./db";
import { isValidDeviceId } from "./devices";
import { collectAssetRefs } from "./markdown";

/**
 * 远程同步（推送 + 拉取），协议见 docs/sync-protocol.md（v3，多设备）。
 * 推送：GET /sync/manifest 拿服务端已有图片清单 → 只 PUT 缺的图片 →
 *       PUT /sync/data（带 X-Device-Id/X-Device-Name 头）推整份库——服务端只覆盖
 *       本设备的槽位，不动其他设备推送的数据。
 * 拉取：GET /sync/devices 拿设备清单 → 逐台 GET /sync/data?device=<id> 取该设备原始整库，
 *       落到 <数据目录>/devices/<id>/（每设备一份，不与本机数据合并）；侧栏按 设备→文件夹
 *       只读浏览。缺的图片按内容哈希下到主 assets/（各设备共用，天然去重）。
 * 图片文件名即内容哈希，天然幂等：重跑时已传/已下的自动跳过。
 */

const TARGET_KEY = "errorbook.sync.server";
const DEVICE_KEY = "errorbook.device.id";

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

/**
 * 本设备标识（v3 多设备用）：服务端按 id 分槽存各设备最新版。
 * 持久化在应用数据目录 device.json（卸载重装不清除该目录，id 不变、服务端槽位对得上）；
 * localStorage 作副本兼容。id 形如 desktop-<16位十六进制>。
 */
let cachedIdentity: { id: string; name: string } | null = null;

export async function deviceIdentity(): Promise<{ id: string; name: string }> {
  if (cachedIdentity) return cachedIdentity;
  let id = "";
  try {
    const f = await join(await appDataDir(), "device.json");
    if (await exists(f)) id = String((JSON.parse(await readTextFile(f)) as { id?: unknown }).id ?? "");
  } catch {
    // 读不到按未生成处理
  }
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) id = localStorage.getItem(DEVICE_KEY) ?? "";
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    id = `desktop-${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }
  try {
    const dir = await appDataDir();
    await mkdir(dir, { recursive: true });
    await writeTextFile(await join(dir, "device.json"), JSON.stringify({ id }, null, 2));
  } catch {
    // 应用目录写不了（极端情况）时只留 localStorage
  }
  localStorage.setItem(DEVICE_KEY, id);
  const ua = navigator.userAgent;
  const platform = /Mac/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux|X11/i.test(ua) ? "Linux" : "桌面";
  cachedIdentity = { id, name: `${platform}·${id.slice(-4)}` };
  return cachedIdentity;
}

/** 推送时的设备头：名称按 URL 编码（HTTP 头放不了中文），服务端解码后展示在状态页 */
async function deviceHeaders(): Promise<Record<string, string>> {
  const d = await deviceIdentity();
  return { "X-Device-Id": d.id, "X-Device-Name": encodeURIComponent(d.name) };
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

  // 3. 推送整份库到本设备的槽位（与磁盘 data.json 相同的序列化格式；服务端只覆盖本设备版本）
  if (isAborted()) throw new SyncAborted(done);
  onProgress({ phase: "data", done, total: missing.length });
  const dres = await request(
    `${base}/sync/data`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(target), ...(await deviceHeaders()) },
      body: JSON.stringify(db, null, 2),
    },
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

// ---------- 拉取（v3：按设备分开下载，不合并） ----------

export interface PullProgress {
  /** connect 连接与清单 | devices 逐台拉取设备库 | assets 下载缺的图片 | done 完成 */
  phase: "connect" | "devices" | "assets" | "done";
  done: number;
  total: number;
  current?: string;
}

/** 服务端设备清单条目 */
export interface ServerDevice {
  id: string;
  name: string;
  lastPush: string;
  mistakes: number;
  notes: number;
  folders: number;
}

/** 一台设备本次拉取的结果 */
export interface PulledDevice {
  id: string;
  name: string;
  mistakes: number;
  notes: number;
}

export interface DevicePullResult {
  /** 本次实际拉到本地的设备（不含本机） */
  pulled: PulledDevice[];
  /** 服务端上除本机外没有其他设备数据 */
  onlySelf: boolean;
  /** 本次实际下载的图片数 */
  downloadedAssets: number;
  /** 服务端也缺、被跳过的图片数（保留引用） */
  missingAssets: number;
}

/**
 * 拉取服务端上全部设备（本机除外）的整库，各自落到 <dataDir>/devices/<id>/：
 * data.json 原样保存 + device.json 记设备名。缺的图片按内容哈希下到主 assets/（各设备共用）。
 * 幂等可重入：中断后重新执行，已落盘的设备/图片自动跳过。不改本机 data.json。
 */
export async function pullAllDevices(
  target: SyncTarget,
  dataDir: string,
  onProgress: (p: PullProgress) => void,
  isAborted: () => boolean,
): Promise<DevicePullResult> {
  const base = target.server;
  const own = await deviceIdentity();

  // 1. 连接探针 + 图片清单（与推送同一探针口径）
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

  // 2. 设备清单
  const dres = await request(`${base}/sync/devices`, { method: "GET", headers: authHeaders(target) }, "获取设备清单");
  if (dres.status === 401 || dres.status === 403) throw denyError(dres.status);
  if (dres.status === 404) throw new Error("服务端版本过旧（不支持按设备拉取），请升级服务端到协议 v3");
  if (!dres.ok) throw new Error(`获取设备清单失败：HTTP ${dres.status}`);
  const listing = (await dres.json().catch(() => null)) as { devices?: unknown } | null;
  if (!listing || !Array.isArray(listing.devices)) throw new Error("服务端返回的设备清单格式不正确");
  const others = listing.devices.filter(
    (d): d is ServerDevice => !!d && typeof d === "object" && typeof (d as ServerDevice).id === "string" && (d as ServerDevice).id !== own.id,
  );

  // 3. 逐台拉取设备整库，落盘到 devices/<id>/
  const pulled: PulledDevice[] = [];
  const dbs: Database[] = [];
  for (let i = 0; i < others.length; i++) {
    if (isAborted()) throw new SyncAborted(0);
    const d = others[i];
    onProgress({ phase: "devices", done: i, total: others.length, current: d.name || d.id });
    const res = await request(
      `${base}/sync/data?device=${encodeURIComponent(d.id)}`,
      { method: "GET", headers: authHeaders(target), connectTimeout: 5000 },
      `拉取设备 ${d.name || d.id}`,
    );
    if (res.status === 401 || res.status === 403) throw denyError(res.status);
    if (res.status === 404) continue; // 清单与槽位竞态：该设备数据没了，跳过
    if (!res.ok) throw new Error(`拉取设备 ${d.name || d.id} 失败：HTTP ${res.status}`);
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== "object") throw new Error(`设备 ${d.name || d.id} 返回的不是合法的题库数据`);
    const db = normalizeDb(raw);
    dbs.push(db);
    const dir = await join(dataDir, "devices", d.id);
    await mkdir(dir, { recursive: true });
    await writeFile(await join(dir, "data.json"), new TextEncoder().encode(JSON.stringify(db, null, 2)));
    await writeFile(
      await join(dir, "device.json"),
      new TextEncoder().encode(JSON.stringify({ id: d.id, name: d.name || d.id, pulledAt: Date.now() }, null, 2)),
    );
    pulled.push({ id: d.id, name: d.name || d.id, mistakes: db.mistakes.length, notes: db.notes.length });
  }
  onProgress({ phase: "devices", done: others.length, total: others.length });

  // 4. 下载各设备库引用到而本地缺的图片（内容哈希，共用主 assets/；本地已有的直接跳过）
  const need = new Set<string>();
  for (const db of dbs) for (const key of collectLibraryAssets(db)) need.add(key);
  const missing = [...need];
  let downloaded = 0;
  let skippedLocal = 0;
  let missingAssets = 0;
  for (let i = 0; i < missing.length; i++) {
    if (isAborted()) throw new SyncAborted(downloaded);
    const key = missing[i];
    onProgress({ phase: "assets", done: i - skippedLocal, total: missing.length - skippedLocal, current: key });
    const dstPath = await join(dataDir, "assets", key);
    if (await exists(dstPath)) {
      skippedLocal++;
      continue; // 本地已有（内容哈希一致）
    }
    if (!serverAssets.has(key)) {
      missingAssets++; // 服务端清单里没有：直接跳过，不打 404
      continue;
    }
    const res = await request(
      `${base}/sync/asset/${key}`,
      { method: "GET", headers: authHeaders(target), connectTimeout: 5000 },
      `下载 ${key}`,
    );
    if (res.status === 404) {
      missingAssets++; // 服务端也缺：保留引用跳过（与推送口径一致）
      continue;
    }
    if (res.status === 401 || res.status === 403) throw denyError(res.status);
    if (!res.ok) throw new Error(`下载图片 ${key} 失败：HTTP ${res.status}`);
    await writeFile(dstPath, new Uint8Array(await res.arrayBuffer()));
    downloaded++;
  }
  // 5. 以服务端清单为准：清掉本地已不在服务端的旧设备快照
  //    （远程设备栏只显示其他设备当前存在的推送；本机槽位本来就不拉取）
  const keepIds = new Set(listing.devices.filter((d): d is ServerDevice => !!d && typeof d.id === "string").map(d => d.id));
  try {
    const root = await join(dataDir, "devices");
    if (await exists(root)) {
      for (const e of await readDir(root)) {
        if (e.isDirectory && e.name && isValidDeviceId(e.name) && !keepIds.has(e.name)) {
          await remove(await join(root, e.name), { recursive: true });
        }
      }
    }
  } catch {
    // 清理失败不影响本次拉取结果
  }

  onProgress({ phase: "done", done: 1, total: 1 });

  return { pulled, onlySelf: others.length === 0, downloadedAssets: downloaded, missingAssets };
}
