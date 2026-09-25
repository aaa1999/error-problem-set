import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import type { Database } from "../types";
import { normalizeDb } from "./db";
import { naturalCompare } from "./utils";

/**
 * 远程设备库：拉取时服务端上每台设备的整库原样落在 <数据目录>/devices/<设备id>/，
 * 不与本机数据合并；侧栏「远程设备」按 设备 → 文件夹 只读浏览。
 */

export interface RemoteDevice {
  id: string;
  /** 展示名（拉取时从服务端设备清单带入） */
  name: string;
  db: Database;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 设备 id 白名单（与服务端一致，目录名防注入） */
export function isValidDeviceId(s: string): boolean {
  return DEVICE_ID_RE.test(s);
}

/** 读取数据目录下全部已拉取的设备库（device.json 存名称；缺了就用 id 兜底），按名称自然排序 */
export async function loadRemoteDevices(dataDir: string): Promise<RemoteDevice[]> {
  const root = await join(dataDir, "devices");
  if (!(await exists(root))) return [];
  const out: RemoteDevice[] = [];
  let entries: { name: string; isDirectory: boolean }[] = [];
  try {
    entries = await readDir(root);
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory || !e.name || !DEVICE_ID_RE.test(e.name)) continue;
    const dataPath = await join(root, e.name, "data.json");
    if (!(await exists(dataPath))) continue;
    try {
      const raw = JSON.parse(await readTextFile(dataPath));
      let name = e.name;
      const metaPath = await join(root, e.name, "device.json");
      if (await exists(metaPath)) {
        try {
          name = String((JSON.parse(await readTextFile(metaPath)) as { name?: unknown }).name ?? e.name);
        } catch {
          // meta 坏了就用 id
        }
      }
      out.push({ id: e.name, name: String(name), db: normalizeDb(raw) });
    } catch {
      // 单个设备库坏了跳过，不拖垮整体
    }
  }
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}

/** 侧栏选择范围的「远程设备」前缀：device:<id>=设备全部，device:<id>/<folderId|uncat>=设备内范围 */
export const DEVICE_SEL_PREFIX = "device:";

export interface DeviceSel {
  deviceId: string;
  /** "" 全部 | "uncat" 未分类 | 文件夹 id */
  sub: string;
}

/** 解析 device: 选择范围；不是设备范围返回 null。设备 id 不含 /（服务端白名单保证），首个 / 后为 sub */
export function parseDeviceSel(sel: string): DeviceSel | null {
  if (!sel.startsWith(DEVICE_SEL_PREFIX)) return null;
  const rest = sel.slice(DEVICE_SEL_PREFIX.length);
  const slash = rest.indexOf("/");
  const deviceId = slash === -1 ? rest : rest.slice(0, slash);
  if (!deviceId) return null;
  return { deviceId, sub: slash === -1 ? "" : rest.slice(slash + 1) };
}
