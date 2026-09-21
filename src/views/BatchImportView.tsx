import { useMemo, useState } from "react";
import { basename, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import type { Mistake } from "../types";
import { IMAGE_EXTS, extOf, fileSrc, importImageFile } from "../lib/images";
import { folderPathName } from "../lib/folders";
import { naturalCompare, uuid } from "../lib/utils";
import { useBook } from "../store";
import { TagInput } from "../components/TagInput";
import { FolderSelect } from "../components/FolderSelect";
import { MergeImport } from "../components/MergeImport";

type RowMode = "q" | "a" | "skip";

interface Row {
  path: string;
  name: string;
  /** 相对来源根目录的子文件夹路径，"" 表示根；同时用作分组 key 和自动建夹路径 */
  relDir: string;
  mode: RowMode;
}

interface GroupEntry {
  row: Row;
  idx: number;
}

export function BatchImportView({
  onDone,
  defaultFolderId = null,
}: {
  onDone: () => void;
  defaultFolderId?: string | null;
}) {
  const { db, dataDir, allTags, addMistake, updateMistake, getMistake, findOrCreateFolder } = useBook();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [rootFolderId, setRootFolderId] = useState<string | null>(defaultFolderId);
  const [mirrorStructure, setMirrorStructure] = useState(true);
  const [groupTargets, setGroupTargets] = useState<Record<string, string | null>>({});
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [doneInfo, setDoneInfo] = useState<{ questions: number; analyses: number } | null>(null);
  const [err, setErr] = useState("");

  const groups = useMemo(() => {
    if (!rows) return [] as { relDir: string; list: GroupEntry[] }[];
    const map = new Map<string, GroupEntry[]>();
    rows.forEach((row, idx) => {
      const list = map.get(row.relDir);
      if (list) list.push({ row, idx });
      else map.set(row.relDir, [{ row, idx }]);
    });
    return [...map.entries()].map(([relDir, list]) => ({ relDir, list }));
  }, [rows]);

  const hasSubDirs = groups.some(g => g.relDir !== "");

  const counts = useMemo(() => {
    if (!rows) return null;
    let q = 0;
    let a = 0;
    let s = 0;
    for (const r of rows) {
      if (r.mode === "q") q++;
      else if (r.mode === "a") a++;
      else s++;
    }
    return { q, a, s };
  }, [rows]);

  const scanDirRecursive = async (base: string, rel: string, out: Row[]): Promise<void> => {
    const entries = await readDir(rel === "" ? base : await join(base, rel));
    for (const e of entries) {
      if (e.isFile && IMAGE_EXTS.includes(extOf(e.name))) {
        out.push({
          path: rel === "" ? await join(base, e.name) : await join(base, rel, e.name),
          name: e.name,
          relDir: rel,
          mode: "q",
        });
      } else if (e.isDirectory && !e.name.startsWith(".")) {
        await scanDirRecursive(base, rel === "" ? e.name : `${rel}/${e.name}`, out);
      }
    }
  };

  const scanFolder = async () => {
    setErr("");
    setDoneInfo(null);
    const res = await openDialog({ directory: true, title: "选择存放截图的文件夹（会连同子文件夹一起扫描）" });
    if (typeof res !== "string" || !res) return;
    setScanning(true);
    try {
      const out: Row[] = [];
      await scanDirRecursive(res, "", out);
      out.sort((x, y) => naturalCompare(x.relDir, y.relDir) || naturalCompare(x.name, y.name));
      if (out.length === 0) {
        setRows(null);
        setErr("该文件夹（含子文件夹）里没有图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）");
        return;
      }
      setGroupTargets({});
      setRows(out);
    } catch (e) {
      setErr(`读取文件夹失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const scanFiles = async () => {
    setErr("");
    setDoneInfo(null);
    const res = await openDialog({
      multiple: true,
      title: "选择图片（可多选）",
      filters: [{ name: "图片", extensions: IMAGE_EXTS }],
    });
    const paths = Array.isArray(res) ? res : res ? [res] : [];
    if (paths.length === 0) return;
    const out: Row[] = [];
    for (const p of paths) out.push({ path: p, name: await basename(p), relDir: "", mode: "q" });
    out.sort((x, y) => naturalCompare(x.name, y.name));
    setGroupTargets({});
    setRows(out);
  };

  const setRowMode = (idx: number, mode: RowMode) => {
    setRows(rs => (rs ? rs.map((r, j) => (j === idx ? { ...r, mode } : r)) : rs));
  };

  /** 第 idx 行若设为「解析图」，将并入的最近一道题所在分组；null 表示前面没有可挂的题 */
  const anchorGroupFor = (idx: number): string | null => {
    if (!rows) return null;
    for (let j = idx - 1; j >= 0; j--) {
      if (rows[j].mode === "q") return rows[j].relDir;
    }
    return null;
  };

  const runImport = async () => {
    if (!rows || importing) return;
    setImporting(true);
    setProgress(0);
    setErr("");
    let questions = 0;
    let analyses = 0;
    let currentId: string | null = null;
    const folderCache = new Map<string, string | null>();
    try {
      const resolveFolder = async (relDir: string): Promise<string | null> => {
        const cached = folderCache.get(relDir);
        if (cached !== undefined) return cached;
        let target: string | null;
        if (mirrorStructure && relDir) {
          let parent = rootFolderId;
          for (const seg of relDir.split("/")) parent = (await findOrCreateFolder(seg, parent)).id;
          target = parent;
        } else {
          target = groupTargets[relDir] ?? rootFolderId;
        }
        folderCache.set(relDir, target);
        return target;
      };
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.mode !== "skip") {
          const img = await importImageFile(dataDir, row.path);
          if (img) {
            if (row.mode === "a" && currentId) {
              const target = getMistake(currentId);
              if (target) {
                await updateMistake({
                  ...target,
                  analysis: [...target.analysis, img],
                  tags: [...new Set([...target.tags, ...tags])],
                  updatedAt: Date.now(),
                });
                analyses++;
              }
            } else {
              const folderId = await resolveFolder(row.relDir);
              const m: Mistake = {
                id: uuid(),
                folderId,
                question: [img],
                analysis: [],
                tags: [...tags],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              await addMistake(m);
              currentId = m.id;
              questions++;
            }
          }
        }
        setProgress(i + 1);
      }
      setDoneInfo({ questions, analyses });
      setRows(null);
    } catch (e) {
      setErr(`导入中断：${String(e)}（已导入的部分已保存）`);
    } finally {
      setImporting(false);
    }
  };

  if (doneInfo) {
    return (
      <div className="empty-state">
        <div className="empty-icon">✅</div>
        <h2>导入完成</h2>
        <p>
          新增 {doneInfo.questions} 道错题，附加 {doneInfo.analyses} 张解析图。
        </p>
        <div className="row-actions center">
          <button className="btn" onClick={() => setDoneInfo(null)}>
            再导一批
          </button>
          <button className="btn btn-primary" onClick={onDone}>
            去浏览
          </button>
        </div>
      </div>
    );
  }

  const rootName = folderPathName(db.folders, rootFolderId);

  return (
    <div className="batch">
      <div className="page-card">
        <div className="page-label">① 选择来源</div>
        <div className="row-actions">
          <button className="btn" disabled={scanning || importing} onClick={() => void scanFolder()}>
            📂 选择文件夹（含子文件夹）
          </button>
          <button className="btn" disabled={scanning || importing} onClick={() => void scanFiles()}>
            🖼 选择多个图片文件
          </button>
          {scanning && <span className="muted">扫描中…</span>}
        </div>
        {err && <div className="be-error">{err}</div>}
      </div>

      {rows && rows.length > 0 && (
        <div className="page-card" style={{ marginTop: 16 }}>
          <div className="page-label">② 确认每张图的身份</div>
          <p className="muted">
            默认每张图新开一道错题；若某张是同文件夹里上一题的解析截图，把它改成「解析图 ↩」，会并进去。
          </p>
          <div className="batch-rows">
            {groups.map(g => (
              <div key={g.relDir || "__root__"} className="batch-group">
                <div className="batch-group-head">
                  <span className="batch-group-name">{g.relDir === "" ? "（根目录）" : g.relDir}</span>
                  {mirrorStructure ? (
                    <span className="muted" title="按源文件夹结构，在目标位置下自动创建同名子文件夹">
                      → {g.relDir === "" ? rootName : `${rootName} / ${g.relDir.split("/").join(" / ")}`}
                      {g.relDir !== "" && "（不存在会自动创建）"}
                    </span>
                  ) : (
                    <FolderSelect
                      value={groupTargets[g.relDir] ?? rootFolderId}
                      onChange={v => setGroupTargets(t => ({ ...t, [g.relDir]: v }))}
                    />
                  )}
                </div>
                {g.list.map(({ row, idx }) => (
                  <div className="batch-row" key={row.path}>
                    <img className="batch-thumb" src={fileSrc(row.path)} alt="" loading="lazy" />
                    <div className="batch-name" title={row.path}>
                      {idx + 1}. {row.name}
                    </div>
                    <select
                      value={row.mode}
                      disabled={importing}
                      onChange={e => setRowMode(idx, e.target.value as RowMode)}
                    >
                      <option value="q">题目图（新错题）</option>
                      <option value="a" disabled={anchorGroupFor(idx) !== row.relDir}>
                        解析图 ↩（并入上一题）
                      </option>
                      <option value="skip">跳过（不导入）</option>
                    </select>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="page-card" style={{ marginTop: 16 }}>
          <div className="page-label">③ 目标位置、标签并导入</div>
          <div className="entry-meta">
            <FolderSelect value={rootFolderId} onChange={setRootFolderId} />
            {hasSubDirs && (
              <label className="mirror-check" title="在目标文件夹下按来源的子文件夹层级自动创建同名文件夹，已存在的直接复用">
                <input
                  type="checkbox"
                  checked={mirrorStructure}
                  disabled={importing}
                  onChange={e => setMirrorStructure(e.target.checked)}
                />
                按源文件夹结构自动创建子文件夹
              </label>
            )}
            <TagInput value={tags} onChange={setTags} suggestions={allTags} />
          </div>
          {importing ? (
            <div className="import-progress">
              <div className="progress-bar">
                <i style={{ width: `${(progress / rows.length) * 100}%` }} />
              </div>
              <span className="muted">
                {progress} / {rows.length}
              </span>
            </div>
          ) : (
            <div className="row-actions spread">
              <span className="muted">
                来自 {groups.length} 个文件夹，将新增 {counts?.q ?? 0} 道错题（含 {counts?.a ?? 0} 张解析图，跳过{" "}
                {counts?.s ?? 0} 张）
              </span>
              <button className="btn btn-primary" onClick={() => void runImport()}>
                导入 {counts?.q ?? 0} 题
              </button>
            </div>
          )}
        </div>
      )}

      <MergeImport />
    </div>
  );
}
