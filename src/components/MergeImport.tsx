import { useState } from "react";
import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyFile, exists, readDir } from "@tauri-apps/plugin-fs";
import { loadDb } from "../lib/db";
import { executeMerge, mergeOutcomeText, planMerge, type MergePlan } from "../lib/merge";
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
  core: MergePlan;
}

/** 从另一份错题本数据目录（含 data.json + assets）整体合并到当前数据目录 */
export function MergeImport() {
  const { db, dataDir, addMistakes, addNotes, addTags, addPendingImports, findOrCreateFolder } = useBook();
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
      setPlan({ sourceDir, core: planMerge(db, source) });
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
    try {
      const outcome = await executeMerge(plan.core, {
        // 本地已有（哈希一致）直接算到位；缺的从源目录拷，源里也缺则保留引用跳过
        fetchAsset: async key => {
          const dstPath = await join(dataDir, "assets", key);
          if (await exists(dstPath)) return true;
          try {
            await copyFile(await join(plan.sourceDir, "assets", key), dstPath);
            return true;
          } catch {
            return false;
          }
        },
        findOrCreateFolder,
        addMistakes,
        addNotes,
        addTags,
        addPendingImports,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(mergeOutcomeText(plan.core, outcome));
      setPlan(null);
    } catch (e) {
      setErr(`合并中断：${String(e)}（可重新执行，已导入的会自动跳过）`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-card" style={{ marginTop: 16 }}>
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
            {plan.core.source.mistakes.length} 道错题、{plan.core.source.notes.length} 篇笔记、{plan.core.source.folders.length} 个文件夹：将导入{" "}
            {plan.core.newMistakes.length} 道错题、{plan.core.newNotes.length} 篇笔记（含 {plan.core.assetKeys.length} 张图片）
            {plan.core.newTags.length > 0 ? `、${plan.core.newTags.length} 个标签` : ""}，跳过已存在{" "}
            {plan.core.skipped} 道、{plan.core.skippedNotes} 篇
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
