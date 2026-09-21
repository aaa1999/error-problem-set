import { useState } from "react";
import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyFile, exists } from "@tauri-apps/plugin-fs";
import type { Database, Folder, Mistake } from "../types";
import { loadDb } from "../lib/db";
import { useBook } from "../store";

interface Plan {
  sourceDir: string;
  source: Database;
  newMistakes: Mistake[];
  skipped: number;
  imageCount: number;
}

/** 从另一份错题本数据目录（含 data.json + assets）整体合并到当前数据目录 */
export function MergeImport() {
  const { db, dataDir, addMistakes, findOrCreateFolder } = useBook();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const pick = async () => {
    setErr("");
    setResult(null);
    const res = await openDialog({ directory: true, title: "选择另一份错题本数据目录（包含 data.json）" });
    if (typeof res !== "string" || !res) return;
    setBusy(true);
    try {
      if (!(await exists(await join(res, "data.json")))) {
        setErr("所选文件夹里没有 data.json——请选择错题本的数据目录（data.json + assets 所在的文件夹）");
        return;
      }
      const source = await loadDb(res);
      if (source.mistakes.length === 0) {
        setErr("该数据目录里没有错题数据");
        return;
      }
      const existing = new Set(db.mistakes.map(m => m.id));
      const newMistakes = source.mistakes.filter(m => !existing.has(m.id));
      const imgs = new Set<string>();
      for (const m of newMistakes)
        for (const b of [...m.question, ...m.analysis]) if (b.type === "image") imgs.add(`${b.hash}.${b.ext}`);
      setPlan({
        sourceDir: res,
        source,
        newMistakes,
        skipped: source.mistakes.length - newMistakes.length,
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
    const total = plan.newMistakes.length + plan.imageCount;
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

      // 2. 拷贝缺失的图片（按内容哈希，已存在的跳过）
      const keys = new Set<string>();
      for (const m of plan.newMistakes)
        for (const b of [...m.question, ...m.analysis]) if (b.type === "image") keys.add(`${b.hash}.${b.ext}`);
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

      // 3. 错题入册（保留原 id/时间戳，文件夹指向合并后的目标）
      await addMistakes(plan.newMistakes.map(m => ({ ...m, folderId: m.folderId ? fmap.get(m.folderId) ?? null : null })));
      setProgress({ done: total, total });

      setResult(
        `合并完成：新导入 ${plan.newMistakes.length} 道，跳过 ${plan.skipped} 道（已存在），` +
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
        选择包含 data.json 的数据目录（旧备份、其他设备的数据），题目、文件夹、标签整体合并进来；
        已导入过的自动跳过，图片按内容哈希去重，可重复执行不会产生重复。
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
              {plan.source.mistakes.length} 道错题、{plan.source.folders.length} 个文件夹：将导入{" "}
              {plan.newMistakes.length} 道（含 {plan.imageCount} 张图片），跳过已存在 {plan.skipped} 道
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
