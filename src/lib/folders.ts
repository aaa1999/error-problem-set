import type { Folder, Mistake } from "../types";
import { naturalCompare } from "./utils";

/** 按父级分组，同组内按名称自然排序 */
export function groupByParent(folders: Folder[]): Map<string | null, Folder[]> {
  const map = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parentId ?? null;
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  }
  for (const list of map.values()) list.sort((a, b) => naturalCompare(a.name, b.name));
  return map;
}

/** 深度优先平铺（父在前、同级有序），供下拉框使用 */
export function flatFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
  const byParent = groupByParent(folders);
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 完整路径名：「数学 / 立体几何」；找不到或 null 返回「未分类」 */
export function folderPathName(folders: Folder[], id: string | null): string {
  if (!id) return "未分类";
  const byId = new Map(folders.map(f => [f.id, f]));
  const names: string[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 64) {
    names.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return names.length > 0 ? names.join(" / ") : "未分类";
}

/** 自身 + 所有后代文件夹的 id 集合 */
export function descendantSet(folders: Folder[], id: string): Set<string> {
  const byParent = groupByParent(folders);
  const set = new Set<string>();
  const walk = (fid: string) => {
    set.add(fid);
    for (const child of byParent.get(fid) ?? []) walk(child.id);
  };
  walk(id);
  return set;
}

/** 该文件夹（含子文件夹）里的错题数 */
export function countInFolder(mistakes: Mistake[], folders: Folder[], id: string): number {
  const set = descendantSet(folders, id);
  return mistakes.reduce((n, m) => (m.folderId && set.has(m.folderId) ? n + 1 : n), 0);
}

/** 未分类 = 没有文件夹 id，或指向已不存在的文件夹 */
export function countUncategorized(mistakes: Mistake[], folders: Folder[]): number {
  const ids = new Set(folders.map(f => f.id));
  return mistakes.reduce((n, m) => (!m.folderId || !ids.has(m.folderId) ? n + 1 : n), 0);
}
