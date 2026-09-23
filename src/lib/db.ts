import { join } from "@tauri-apps/api/path";
import { copyFile, exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Database, Folder, Mistake, Note, PendingImport } from "../types";

export function emptyDb(): Database {
  return { version: 3, mistakes: [], folders: [], notes: [], tags: [], pendingImports: [] };
}

/** 容错解析 + 旧版本（v1 无 folders、v2 无 notes）自动迁移到 v3 */
export function normalizeDb(raw: unknown): Database {
  const r = (raw ?? {}) as Record<string, unknown>;
  const folders: Folder[] = Array.isArray(r.folders)
    ? r.folders
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof f.id === "string" && typeof f.name === "string")
        .map(f => ({
          id: f.id as string,
          name: String(f.name),
          parentId: typeof f.parentId === "string" ? f.parentId : null,
          createdAt: Number(f.createdAt) || Date.now(),
        }))
    : [];
  const mistakes: Mistake[] = Array.isArray(r.mistakes)
    ? r.mistakes
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof m.id === "string" && Array.isArray(m.question))
        .map(m => ({
          id: m.id as string,
          // 新格式 folderIds[]；旧格式单个 folderId 自动迁移成一项，都没有 = 未分类
          folderIds: Array.isArray(m.folderIds)
            ? (m.folderIds as unknown[]).map(String).filter(Boolean)
            : typeof m.folderId === "string" && m.folderId
              ? [m.folderId]
              : [],
          // 选择题选项 + 作答统计（旧数据没有这些字段，按空/0 处理）
          options: Array.isArray(m.options) ? (m.options as unknown[]).map(String).filter(Boolean) : [],
          answer: typeof m.answer === "number" && Number.isInteger(m.answer) && m.answer >= 0 ? m.answer : null,
          attempts: Math.max(0, Number(m.attempts) || 0),
          wrong: Math.max(0, Number(m.wrong) || 0),
          question: m.question as Mistake["question"],
          analysis: Array.isArray(m.analysis) ? (m.analysis as Mistake["analysis"]) : [],
          tags: Array.isArray(m.tags) ? (m.tags as unknown[]).map(String) : [],
          createdAt: Number(m.createdAt) || Date.now(),
          updatedAt: Number(m.updatedAt) || Date.now(),
        }))
    : [];
  const notes: Note[] = Array.isArray(r.notes)
    ? r.notes
        .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && typeof n.id === "string")
        .map(n => ({
          id: n.id as string,
          title: typeof n.title === "string" ? n.title : "",
          format: n.format === "word" ? "word" : "markdown",
          content: typeof n.content === "string" ? n.content : "",
          createdAt: Number(n.createdAt) || Date.now(),
          updatedAt: Number(n.updatedAt) || Date.now(),
        }))
    : [];
  // 预建独立标签：旧数据没有该字段时按空处理（v3 内的可选增量字段）
  const tags: string[] = Array.isArray(r.tags)
    ? [...new Set((r.tags as unknown[]).map(String).filter(Boolean))]
    : [];
  // 待导入清单（做题 tab 产生）：旧数据没有该字段按空处理
  const pendingImports: PendingImport[] = Array.isArray(r.pendingImports)
    ? ((r.pendingImports as unknown[]).filter(
        (p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string",
      ) as Record<string, unknown>[])
        .map(p => ({
          id: p.id as string,
          folderName: typeof p.folderName === "string" ? p.folderName : "",
          createdAt: Number(p.createdAt) || Date.now(),
          total: Number(p.total) || 0,
          entries: Array.isArray(p.entries)
            ? (p.entries as Record<string, unknown>[])
                .filter(e => !!e && typeof (e as Record<string, unknown>).no === "number")
                .map(e => ({
                  no: Number(e.no),
                  mine: typeof e.mine === "string" ? e.mine : null,
                  key: typeof e.key === "string" ? e.key : null,
                  flagged: e.flagged === true,
                }))
            : [],
        }))
    : [];
  return { version: 3, mistakes, folders, notes, tags, pendingImports };
}

export async function ensureDirs(dataDir: string): Promise<void> {
  await mkdir(await join(dataDir, "assets"), { recursive: true });
  await mkdir(await join(dataDir, "snapshots"), { recursive: true });
}

export async function loadDb(dataDir: string): Promise<Database> {
  const dataPath = await join(dataDir, "data.json");
  if (!(await exists(dataPath))) return emptyDb();
  try {
    return normalizeDb(JSON.parse(await readTextFile(dataPath)));
  } catch (e) {
    console.warn("data.json 解析失败，按空数据处理：", e);
    return emptyDb();
  }
}

const MAX_SNAPSHOTS = 20;
// 编辑时自动保存很频繁，快照至少间隔 1 分钟做一次，避免刷屏
let lastSnapshotAt = 0;

/** 原子写入：先写临时文件再替换；替换前把旧版拷进 snapshots/（限流 + 保留最近 20 份） */
export async function saveDb(dataDir: string, db: Database): Promise<void> {
  const dataPath = await join(dataDir, "data.json");
  if ((await exists(dataPath)) && Date.now() - lastSnapshotAt > 60_000) {
    lastSnapshotAt = Date.now();
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(dataPath, await join(dataDir, "snapshots", `data-${stamp}.json`));
      await pruneSnapshots(await join(dataDir, "snapshots"));
    } catch {
      // 快照失败不阻塞保存
    }
  }
  const tmp = await join(dataDir, "data.json.tmp");
  await writeTextFile(tmp, JSON.stringify(db, null, 2));
  try {
    await remove(dataPath); // Windows 上 rename 不能覆盖已存在目标
  } catch {
    // 首次保存时 data.json 不存在
  }
  await rename(tmp, dataPath);
}

async function pruneSnapshots(snapDir: string): Promise<void> {
  try {
    const entries = await readDir(snapDir);
    const names = entries
      .filter(e => e.isFile && e.name.startsWith("data-"))
      .map(e => e.name)
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - MAX_SNAPSHOTS))) {
      try {
        await remove(await join(snapDir, name));
      } catch {
        // 单个快照删不掉就算了
      }
    }
  } catch {
    // snapshots 目录可能不存在
  }
}
