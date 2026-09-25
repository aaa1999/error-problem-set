import type { Database, Folder, Mistake, Note, PendingImport } from "../types";
import { collectAssetRefs } from "./markdown";

/**
 * 数据合并核心（「合并导入」使用）：
 * 幂等合并——错题/笔记按 id 去重、文件夹按「名称+父级」逐层合并、
 * 预建标签并入、图片按内容哈希只取本地缺的。可重复执行，已并入的自动跳过。
 * 远程同步已改为按设备分开落盘、不合并（lib/sync.ts + lib/devices.ts）。
 */

/** 差量计算：源库相对当前库会新增什么（纯函数，不动数据） */
export interface MergePlan {
  source: Database;
  /** 深度排序后的源文件夹（父层在前，执行时逐层 find-or-create） */
  foldersSorted: Folder[];
  newMistakes: Mistake[];
  newNotes: Note[];
  newTags: string[];
  skipped: number;
  skippedNotes: number;
  /** 新增错题/笔记引用到的图片文件名（hash.ext），本地已有的由执行阶段再过滤 */
  assetKeys: string[];
  /** 待导入清单（做题 tab）：按 id 去重后真正会新增的 */
  newPendingImports: PendingImport[];
}

export function planMerge(current: Database, source: Database): MergePlan {
  const existing = new Set(current.mistakes.map(m => m.id));
  const newMistakes = source.mistakes.filter(m => !existing.has(m.id));
  const existingNotes = new Set(current.notes.map(n => n.id));
  const newNotes = source.notes.filter(n => !existingNotes.has(n.id));
  // 预建标签只数真正会新增的（当前已有 + 随新错题带进来的都不算，源内自身也去重）
  const present = new Set<string>();
  for (const m of current.mistakes) for (const t of m.tags) present.add(t);
  for (const t of current.tags) present.add(t);
  for (const m of newMistakes) for (const t of m.tags) present.add(t);
  const newTags: string[] = [];
  const seen = new Set<string>();
  for (const t of source.tags) {
    if (seen.has(t) || present.has(t)) continue;
    seen.add(t);
    newTags.push(t);
  }

  const imgs = new Set<string>();
  for (const m of newMistakes)
    for (const b of [...m.question, ...m.analysis]) if (b.type === "image") imgs.add(`${b.hash}.${b.ext}`);
  for (const n of newNotes) for (const ref of collectAssetRefs(n.content)) imgs.add(ref.slice("assets/".length));

  const byId = new Map(source.folders.map(f => [f.id, f]));
  const depthOf = (f: Folder): number => {
    let d = 0;
    let p = f.parentId;
    let guard = 0;
    while (p && guard++ < 64) {
      const par = byId.get(p);
      if (!par) break;
      d++;
      p = par.parentId;
    }
    return d;
  };
  const pendingIds = new Set(current.pendingImports.map(p => p.id));
  const newPendingImports = source.pendingImports.filter(p => !pendingIds.has(p.id));

  return {
    source,
    foldersSorted: [...source.folders].sort((a, b) => depthOf(a) - depthOf(b)),
    newMistakes,
    newNotes,
    newTags,
    skipped: source.mistakes.length - newMistakes.length,
    skippedNotes: source.notes.length - newNotes.length,
    assetKeys: [...imgs],
    newPendingImports,
  };
}

/** 执行阶段的本地操作：图片来源不同（目录拷贝 / HTTP 下载），入库走 store */
export interface MergeIO {
  /** 把图片写入本地 assets 目录（本地已缺时才调用）；取不到返回 false（保留引用、跳过不阻断） */
  fetchAsset: (key: string) => Promise<boolean>;
  findOrCreateFolder: (name: string, parentId: string | null) => Promise<Folder>;
  addMistakes: (ms: Mistake[]) => Promise<number>;
  addNotes: (ns: Note[]) => Promise<number>;
  addTags: (ts: string[]) => Promise<number>;
  /** 并入待导入清单（可选：做题清单跨设备同步） */
  addPendingImports?: (ps: PendingImport[]) => Promise<number> | Promise<void> | void;
  onProgress?: (done: number, total: number) => void;
  /** 在图片间隙生效；中止抛 MergeAborted，已下载图片保留（幂等，下次跳过） */
  isAborted?: () => boolean;
}

export interface MergeOutcome {
  newMistakes: number;
  newNotes: number;
  newTags: number;
  foldersMerged: number;
  assetsFetched: number;
  assetsMissing: number;
}

export class MergeAborted extends Error {
  constructor(public fetched: number) {
    super("已中止");
  }
}

export async function executeMerge(plan: MergePlan, io: MergeIO): Promise<MergeOutcome> {
  const total = plan.newMistakes.length + plan.newNotes.length + plan.assetKeys.length;
  let done = 0;
  io.onProgress?.(done, total);

  // 1. 文件夹按「名称+父级」合并（父层先处理，同名复用不重建）
  const fmap = new Map<string, string>();
  for (const f of plan.foldersSorted) {
    const dst = await io.findOrCreateFolder(f.name, f.parentId ? fmap.get(f.parentId) ?? null : null);
    fmap.set(f.id, dst.id);
  }

  // 2. 取回缺失的图片（按内容哈希，本地已有的跳过；取不到的保留引用跳过）
  let assetsFetched = 0;
  let assetsMissing = 0;
  for (const key of plan.assetKeys) {
    if (io.isAborted?.()) throw new MergeAborted(assetsFetched);
    const ok = await io.fetchAsset(key);
    if (ok) assetsFetched++;
    else assetsMissing++;
    done++;
    io.onProgress?.(done, total);
  }

  // 3. 错题与笔记入册（保留原 id/时间戳，错题的每个所属文件夹都映射到合并后的目标）+ 预建标签并入
  await io.addMistakes(
    plan.newMistakes.map(m => ({ ...m, folderIds: m.folderIds.map(id => fmap.get(id)).filter((x): x is string => !!x) })),
  );
  done += plan.newMistakes.length;
  io.onProgress?.(done, total);
  await io.addNotes(plan.newNotes);
  await io.addTags(plan.source.tags);
  if (plan.newPendingImports.length > 0) await io.addPendingImports?.(plan.newPendingImports);
  io.onProgress?.(total, total);

  return {
    newMistakes: plan.newMistakes.length,
    newNotes: plan.newNotes.length,
    newTags: plan.newTags.length,
    foldersMerged: plan.source.folders.length,
    assetsFetched,
    assetsMissing,
  };
}

/** 合并结果的统一文案（合并导入用） */
export function mergeOutcomeText(plan: MergePlan, o: MergeOutcome): string {
  const parts = [
    `新导入 ${o.newMistakes} 道错题、${o.newNotes} 篇笔记`,
    `跳过 ${plan.skipped} 道错题、${plan.skippedNotes} 篇笔记（已存在）`,
    `${o.foldersMerged} 个文件夹已按名称合并`,
  ];
  if (o.newTags > 0) parts.push(`预建标签新增 ${o.newTags} 个`);
  if (plan.newPendingImports.length > 0) parts.push(`待导入清单新增 ${plan.newPendingImports.length} 份`);
  if (o.assetsMissing > 0) parts.push(`${o.assetsMissing} 张图片源端缺失已跳过`);
  return `合并完成：${parts.join("，")}。`;
}
