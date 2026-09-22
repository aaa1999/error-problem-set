import { useState } from "react";
import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyFile, exists, readDir } from "@tauri-apps/plugin-fs";
import type { Database, Folder, Mistake, Note } from "../types";
import { loadDb } from "../lib/db";
import { collectAssetRefs } from "../lib/markdown";
import { useBook } from "../store";

/**
 * 定位数据目录：所选文件夹本身含 data.json 直接用；
 * 否则往下找两层（比如整台机器的「错题本」文件夹、或含 data/ 子目录的安装目录整包拷贝）。
 * 找到多个时报错让用户选具体那个。
 */
async function findDataDir(root: string): Promise<string> {
  if (await exists(await join(root, "data.json"))) return root;
  const candidates: string[] = [];
  const scan = async (dir: string, depth: number) => {
    if (depth > 2 || candidates.length > 1) return;
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory || e.name.startsWith(".")) continue;
      const child = await join(dir, e.name);
      if (await exists(await join(child, "data.json"))) candidates.push(child);
      else await scan(child, depth + 1);
    }
  };
  await scan(root, 1);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`所选文件夹下有多个数据目录，请直接选择其中之一：${candidates.join(" 、")}`);
  }
  throw new Error("所选文件夹里没有找到数据目录（需包含 data.json 与 assets 文件夹）。请选择另一台机器拷来的 data / 错题本 文件夹本身");
}

interface Plan {
  sourceDir: string;
  source: Database;
  newMistakes: Mistake[];
  newNotes: Note[];
  skipped: number;
  skippedNotes: number;
  imageCount: number;
}

/** 从另一份错题本数据目录（含 data.json + assets）整体合并到当前数据目录 */
export function MergeImport() {
  const { db, dataDir, addMistakes, addNotes, findOrCreateFolder } = useBook();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const pick = async () => {
    setErr("");
    setResult(null);
    const res = await openDialog({ directory: true, title: "选择其他机器拷来的数据文件夹（data.json + assets）" });
    if (typeof res !== "string" || !res) return;
    setBusy(true);
    try {
      const sourceDir = await findDataDir(res);
      const source = await loadDb(sourceDir);
      if (source.mistakes.length === 0 && source.notes.length === 0) {
        setErr("该数据目录里没有错题或笔记数据");
        return;
      }
      const existing = new Set(db.mistakes.map(m => m.id));
      const newMistakes = source.mistakes.filter(m => !existing.has(m.id));
      const existingNotes = new Set(db.notes.map(n => n.id));
      const newNotes = source.notes.filter(n => !existingNotes.has(n.id));
      const imgs = new Set<string>();
      for (const m of newMistakes)
        for (const b of [...m.question, ...m.analysis]) if (b.type === "image") imgs.add(`${b.hash}.${b.ext}`);
      for (const n of newNotes) for (const ref of collectAssetRefs(n.content)) imgs.add(ref.slice("assets/".length));
      setPlan({
        sourceDir,
        source,
        newMistakes,
        newNotes,
        skipped: source.mistakes.length - newMistakes.length,
        skippedNotes: source.notes.length - newNotes.length,
        imageCount: imgs.size,
      });
    } catch (e) {
      setErr(`读取失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setErr("");
    const total = plan.newMistakes.length + plan.newNotes.length + plan.imageCount;
    setProgress({ done: 0, total });
    try {
      // 1. 文件夹按「名称+父级」合并（父层先处理，同名复用不重建）
      const byId = new Map(plan.source.folders.map(f => [f.id, f]));
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
      const sorted = [...plan.source.folders].sort((a, b) => depthOf(a) - depthOf(b));
      const fmap = new Map<string, string>();
      for (const f of sorted) {
        const dst = await findOrCreateFolder(f.name, f.parentId ? fmap.get(f.parentId) ?? null : null);
        fmap.set(f.id, dst.id);
      }

      // 2. 拷贝缺失的图片（按内容哈希，已存在的跳过；错题和笔记的引用都算）
      const keys = new Set<string>();
      for (const m of plan.newMistakes)
        for (const b of [...m.question, ...m.analysis]) if (b.type === "image") keys.add(`${b.hash}.${b.ext}`);
      for (const n of plan.newNotes) for (const ref of collectAssetRefs(n.content)) keys.add(ref.slice("assets/".length));
      let done = 0;
      for (const key of keys) {
        const dstPath = await join(dataDir, "assets", key);
        if (!(await exists(dstPath))) {
          try {
            await copyFile(await join(plan.sourceDir, "assets", key), dstPath);
          } catch {
            // 源目录里也缺这张图，保留引用但跳过拷贝
          }
        }
        done++;
        setProgress({ done, total });
      }

      // 3. 错题与笔记入册（保留原 id/时间戳，错题文件夹指向合并后的目标）
      await addMistakes(plan.newMistakes.map(m => ({ ...m, folderId: m.folderId ? fmap.get(m.folderId) ?? null : null })));
      done += plan.newMistakes.length;
      setProgress({ done, total });
      if (plan.newNotes.length > 0) await addNotes(plan.newNotes);
      setProgress({ done: total, total });

      setResult(
        `合并完成：新导入 ${plan.newMistakes.length} 道错题、${plan.newNotes.length} 篇笔记，` +
          `跳过 ${plan.skipped} 道错题、${plan.skippedNotes} 篇笔记（已存在），` +
          `${plan.source.folders.length} 个文件夹已按名称合并。`,
      );
      setPlan(null);
    } catch (e) {
      setErr(`合并中断：${String(e)}（可重新执行，已导入的会自动跳过）`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-card" style={{ marginTop: 16 }}>
      <div className="page-label">或：从另一份错题本数据目录合并</div>
      <p className="muted">
        把其他机器的数据文件夹拷过来（U 盘、网盘、聊天传输都行），选择它即可，题目、文件夹、标签整体合并进来。
        选到上一级也没关系，会自动向下识别（最多两层）；已导入过的自动跳过，图片按内容哈希去重，可重复执行。
      </p>
      {result ? (
        <div className="row-actions spread">
          <span className="muted">{result}</span>
          <button className="btn" onClick={() => setResult(null)}>
            完成
          </button>
        </div>
      ) : plan ? (
        busy ? (
          <div className="import-progress">
            <div className="progress-bar">
              <i style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
            </div>
            <span className="muted">
              {progress.done} / {progress.total}
            </span>
          </div>
        ) : (
        <div className="row-actions spread">
          <span className="muted">
            {plan.source.mistakes.length} 道错题、{plan.source.notes.length} 篇笔记、{plan.source.folders.length} 个文件夹：将导入{" "}
            {plan.newMistakes.length} 道错题、{plan.newNotes.length} 篇笔记（含 {plan.imageCount} 张图片），跳过已存在{" "}
            {plan.skipped} 道、{plan.skippedNotes} 篇
          </span>
            <span className="row-actions">
              <button className="btn" onClick={() => setPlan(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void run()}>
                开始合并
              </button>
            </span>
          </div>
        )
      ) : (
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => void pick()}>
            📂 选择数据目录…
          </button>
          {busy && <span className="muted">读取中…</span>}
        </div>
      )}
      {err && <div className="be-error">{err}</div>}
    </div>
  );
}
