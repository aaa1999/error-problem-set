import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { join } from "@tauri-apps/api/path";
import type { Database, Folder, ImageBlock, Mistake, Note, PendingImport } from "./types";
import { emptyDb, ensureDirs, loadDb, saveDb } from "./lib/db";
import { loadRemoteDevices, type RemoteDevice } from "./lib/devices";
import { assetUrlFor } from "./lib/images";
import { descendantSet } from "./lib/folders";
import { naturalCompare, uuid } from "./lib/utils";

type Status = "loading" | "welcome" | "ready";

export interface Book {
  status: Status;
  dataDir: string;
  assetsDir: string;
  db: Database;
  allTags: string[];
  /** [标签, 数量]，按名称排序 */
  tagCounts: [string, number][];
  assetSrc: (b: ImageBlock) => string;
  chooseDataDir: (dir: string) => Promise<void>;
  addMistake: (m: Mistake) => Promise<void>;
  /** 批量追加错题（数据目录合并用），跳过已存在的 id，返回实际新增数 */
  addMistakes: (ms: Mistake[]) => Promise<number>;
  updateMistake: (m: Mistake) => Promise<void>;
  deleteMistake: (id: string) => Promise<void>;
  /** 读取最新数据里的指定错题（批量导入循环里用，避免闭包旧值） */
  getMistake: (id: string) => Mistake | undefined;
  setMistakeFolders: (mistakeId: string, folderIds: string[]) => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder>;
  /** 按名称+父级查找，没有就创建（批量导入按源结构落位用） */
  findOrCreateFolder: (name: string, parentId: string | null) => Promise<Folder>;
  /** 文件夹名支持 a/b/c 层级：按 / 拆段逐级查找或创建，返回最深层级 */
  findOrCreateFolderPath: (path: string, baseParentId: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** 拖动重挂父级：新父级不能是自己或自己的后代（防环） */
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  /** 删除文件夹：其中错题移到未分类，子文件夹上移一级 */
  deleteFolder: (id: string) => Promise<void>;
  addNote: (n: Note) => Promise<void>;
  updateNote: (n: Note) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  /** 批量追加笔记（数据目录合并用），跳过已存在的 id，返回实际新增数 */
  addNotes: (ns: Note[]) => Promise<number>;
  /** 新建预建标签；空名或已存在（错题已带/已预建）时静默跳过 */
  createTag: (name: string) => Promise<void>;
  /** 批量并入预建标签（数据目录合并用），跳过已有（含错题已带的），返回实际新增数 */
  addTags: (names: string[]) => Promise<number>;
  /** 存一条待导入清单（做题 tab） */
  addPendingImport: (p: PendingImport) => Promise<void>;
  /** 批量并入待导入清单（合并导入/拉取用），按 id 去重，返回实际新增数 */
  addPendingImports: (ps: PendingImport[]) => Promise<number>;
  /** 导入完成/丢弃后移除清单 */
  removePendingImport: (id: string) => Promise<void>;
  /** 已拉取的远程设备库（只读浏览，见 lib/devices.ts）；拉取同步完成后调 refreshRemoteDevices 刷新 */
  remoteDevices: RemoteDevice[];
  refreshRemoteDevices: () => Promise<void>;
}

const BookCtx = createContext<Book | null>(null);
const STORAGE_KEY = "errorbook.dataDir";

export function BookProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [dataDir, setDataDir] = useState("");
  const [assetsDir, setAssetsDir] = useState("");
  const [db, setDb] = useState<Database>(emptyDb);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDevice[]>([]);
  const dbRef = useRef(db);
  dbRef.current = db;

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setStatus("welcome");
      return;
    }
    void (async () => {
      try {
        await ensureDirs(saved);
        const loaded = await loadDb(saved);
        setDataDir(saved);
        setAssetsDir(await join(saved, "assets"));
        setDb(loaded);
        setStatus("ready");
        setRemoteDevices(await loadRemoteDevices(saved).catch(() => []));
      } catch (e) {
        console.error("数据目录不可用：", e);
        setStatus("welcome");
      }
    })();
  }, []);

  const chooseDataDir = useCallback(async (dir: string) => {
    await ensureDirs(dir);
    const loaded = await loadDb(dir);
    localStorage.setItem(STORAGE_KEY, dir);
    setDataDir(dir);
    setAssetsDir(await join(dir, "assets"));
    setDb(loaded);
    setRemoteDevices(await loadRemoteDevices(dir).catch(() => []));
    setStatus("ready");
  }, []);

  const refreshRemoteDevices = useCallback(async () => {
    if (!dataDir) return;
    setRemoteDevices(await loadRemoteDevices(dataDir).catch(() => []));
  }, [dataDir]);

  const persist = useCallback(
    async (next: Database) => {
      setDb(next);
      await saveDb(dataDir, next);
    },
    [dataDir],
  );

  const addMistake = useCallback(
    async (m: Mistake) => {
      const cur = dbRef.current;
      await persist({ ...cur, mistakes: [...cur.mistakes, m] });
    },
    [persist],
  );

  const addMistakes = useCallback(
    async (ms: Mistake[]) => {
      const cur = dbRef.current;
      const ids = new Set(cur.mistakes.map(m => m.id));
      const add = ms.filter(m => !ids.has(m.id));
      if (add.length > 0) await persist({ ...cur, mistakes: [...cur.mistakes, ...add] });
      return add.length;
    },
    [persist],
  );

  const updateMistake = useCallback(
    async (m: Mistake) => {
      const cur = dbRef.current;
      await persist({ ...cur, mistakes: cur.mistakes.map(x => (x.id === m.id ? m : x)) });
    },
    [persist],
  );

  const deleteMistake = useCallback(
    async (id: string) => {
      const cur = dbRef.current;
      await persist({ ...cur, mistakes: cur.mistakes.filter(x => x.id !== id) });
    },
    [persist],
  );

  const getMistake = useCallback((id: string) => dbRef.current.mistakes.find(m => m.id === id), []);

  const setMistakeFolders = useCallback(
    async (mistakeId: string, folderIds: string[]) => {
      const cur = dbRef.current;
      await persist({
        ...cur,
        mistakes: cur.mistakes.map(m => (m.id === mistakeId ? { ...m, folderIds, updatedAt: Date.now() } : m)),
      });
    },
    [persist],
  );

  const createFolder = useCallback(
    async (name: string, parentId: string | null) => {
      const f: Folder = { id: uuid(), name: name.trim(), parentId, createdAt: Date.now() };
      await persist({ ...dbRef.current, folders: [...dbRef.current.folders, f] });
      return f;
    },
    [persist],
  );

  const findOrCreateFolder = useCallback(
    async (name: string, parentId: string | null) => {
      const trimmed = name.trim();
      const cur = dbRef.current;
      const found = cur.folders.find(f => f.name === trimmed && (f.parentId ?? null) === parentId);
      if (found) return found;
      const f: Folder = { id: uuid(), name: trimmed, parentId, createdAt: Date.now() };
      await persist({ ...cur, folders: [...cur.folders, f] });
      return f;
    },
    [persist],
  );

  /** 文件夹名支持 a/b/c 层级：按 / 拆段，从 baseParent 起逐级查找或创建，返回最深层级文件夹 */
  const findOrCreateFolderPath = useCallback(
    async (path: string, baseParentId: string | null) => {
      let parentId = baseParentId;
      let current: Folder | null = null;
      for (const seg of path.split("/").map(s => s.trim()).filter(Boolean)) {
        current = await findOrCreateFolder(seg, parentId);
        parentId = current.id;
      }
      if (!current) throw new Error("文件夹名不能为空");
      return current;
    },
    [findOrCreateFolder],
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      const cur = dbRef.current;
      await persist({ ...cur, folders: cur.folders.map(f => (f.id === id ? { ...f, name: name.trim() } : f)) });
    },
    [persist],
  );

  /** 拖动重挂父级：新父级不能是自己或自己的后代（防环），父级未变则跳过 */
  const moveFolder = useCallback(
    async (id: string, parentId: string | null) => {
      const cur = dbRef.current;
      const me = cur.folders.find(f => f.id === id);
      if (!me || (me.parentId ?? null) === parentId) return;
      if (parentId && descendantSet(cur.folders, id).has(parentId)) return;
      await persist({ ...cur, folders: cur.folders.map(f => (f.id === id ? { ...f, parentId } : f)) });
    },
    [persist],
  );

  /** 删除文件夹：从错题的所属列表里移除该文件夹（清空的落到未分类），子文件夹上移一级 */
  const deleteFolder = useCallback(
    async (id: string) => {
      const cur = dbRef.current;
      const parentId = cur.folders.find(f => f.id === id)?.parentId ?? null;
      await persist({
        ...cur,
        folders: cur.folders.filter(f => f.id !== id).map(f => (f.parentId === id ? { ...f, parentId } : f)),
        mistakes: cur.mistakes.map(m =>
          m.folderIds.includes(id) ? { ...m, folderIds: m.folderIds.filter(x => x !== id) } : m,
        ),
      });
    },
    [persist],
  );

  const addNote = useCallback(
    async (n: Note) => {
      const cur = dbRef.current;
      await persist({ ...cur, notes: [...cur.notes, n] });
    },
    [persist],
  );

  const updateNote = useCallback(
    async (n: Note) => {
      const cur = dbRef.current;
      await persist({ ...cur, notes: cur.notes.map(x => (x.id === n.id ? n : x)) });
    },
    [persist],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      const cur = dbRef.current;
      await persist({ ...cur, notes: cur.notes.filter(x => x.id !== id) });
    },
    [persist],
  );

  const addNotes = useCallback(
    async (ns: Note[]) => {
      const cur = dbRef.current;
      const ids = new Set(cur.notes.map(n => n.id));
      const add = ns.filter(n => !ids.has(n.id));
      if (add.length > 0) await persist({ ...cur, notes: [...cur.notes, ...add] });
      return add.length;
    },
    [persist],
  );

  const createTag = useCallback(
    async (name: string) => {
      const t = name.trim();
      if (!t) return;
      const cur = dbRef.current;
      const used = new Set(cur.mistakes.flatMap(m => m.tags));
      if (used.has(t) || cur.tags.includes(t)) return;
      await persist({ ...cur, tags: [...cur.tags, t] });
    },
    [persist],
  );

  const addTags = useCallback(
    async (names: string[]) => {
      const cur = dbRef.current;
      const used = new Set([...cur.mistakes.flatMap(m => m.tags), ...cur.tags]);
      const add = [...new Set(names.map(n => n.trim()).filter(n => n && !used.has(n)))];
      if (add.length > 0) await persist({ ...cur, tags: [...cur.tags, ...add] });
      return add.length;
    },
    [persist],
  );

  // ---------- 待导入清单（做题 tab：手机做题 → 同步 → 电脑导入） ----------

  const addPendingImport = useCallback(
    async (p: PendingImport) => {
      const cur = dbRef.current;
      if (cur.pendingImports.some(x => x.id === p.id)) return;
      await persist({ ...cur, pendingImports: [...cur.pendingImports, p] });
    },
    [persist],
  );

  const addPendingImports = useCallback(
    async (ps: PendingImport[]) => {
      const cur = dbRef.current;
      const ids = new Set(cur.pendingImports.map(p => p.id));
      const add = ps.filter(p => !ids.has(p.id));
      if (add.length > 0) await persist({ ...cur, pendingImports: [...cur.pendingImports, ...add] });
      return add.length;
    },
    [persist],
  );

  const removePendingImport = useCallback(
    async (id: string) => {
      const cur = dbRef.current;
      await persist({ ...cur, pendingImports: cur.pendingImports.filter(p => p.id !== id) });
    },
    [persist],
  );

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of db.mistakes) for (const t of x.tags) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of db.tags) if (!m.has(t)) m.set(t, 0); // 预建标签计数 0，侧栏置灰可点
    return [...m.entries()].sort((a, b) => naturalCompare(a[0], b[0]));
  }, [db]);

  const allTags = useMemo(() => tagCounts.map(([t]) => t), [tagCounts]);

  const value = useMemo<Book>(
    () => ({
      status,
      dataDir,
      assetsDir,
      db,
      allTags,
      tagCounts,
      assetSrc: (b: ImageBlock) => assetUrlFor(assetsDir, b),
      chooseDataDir,
      addMistake,
      addMistakes,
      updateMistake,
      deleteMistake,
      getMistake,
      setMistakeFolders,
      createFolder,
      findOrCreateFolder,
      findOrCreateFolderPath,
      renameFolder,
      moveFolder,
      deleteFolder,
      addNote,
      updateNote,
      deleteNote,
      addNotes,
      createTag,
      addTags,
      addPendingImport,
      addPendingImports,
      removePendingImport,
      remoteDevices,
      refreshRemoteDevices,
    }),
    [
      status,
      dataDir,
      assetsDir,
      db,
      allTags,
      tagCounts,
      chooseDataDir,
      addMistake,
      addMistakes,
      updateMistake,
      deleteMistake,
      getMistake,
      setMistakeFolders,
      createFolder,
      findOrCreateFolder,
      findOrCreateFolderPath,
      renameFolder,
      moveFolder,
      deleteFolder,
      addNote,
      updateNote,
      deleteNote,
      addNotes,
      createTag,
      addTags,
      addPendingImport,
      addPendingImports,
      removePendingImport,
      remoteDevices,
      refreshRemoteDevices,
    ],
  );

  return <BookCtx.Provider value={value}>{children}</BookCtx.Provider>;
}

export function useBook(): Book {
  const ctx = useContext(BookCtx);
  if (!ctx) throw new Error("useBook 必须在 BookProvider 内使用");
  return ctx;
}
