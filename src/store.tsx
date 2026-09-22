import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { join } from "@tauri-apps/api/path";
import type { Database, Folder, ImageBlock, Mistake, Note } from "./types";
import { emptyDb, ensureDirs, loadDb, saveDb } from "./lib/db";
import { assetUrlFor } from "./lib/images";
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
  setMistakeFolder: (mistakeId: string, folderId: string | null) => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder>;
  /** 按名称+父级查找，没有就创建（批量导入按源结构落位用） */
  findOrCreateFolder: (name: string, parentId: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** 删除文件夹：其中错题移到未分类，子文件夹上移一级 */
  deleteFolder: (id: string) => Promise<void>;
  addNote: (n: Note) => Promise<void>;
  updateNote: (n: Note) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  /** 批量追加笔记（数据目录合并用），跳过已存在的 id，返回实际新增数 */
  addNotes: (ns: Note[]) => Promise<number>;
}

const BookCtx = createContext<Book | null>(null);
const STORAGE_KEY = "errorbook.dataDir";

export function BookProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [dataDir, setDataDir] = useState("");
  const [assetsDir, setAssetsDir] = useState("");
  const [db, setDb] = useState<Database>(emptyDb);
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
    setStatus("ready");
  }, []);

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

  const setMistakeFolder = useCallback(
    async (mistakeId: string, folderId: string | null) => {
      const cur = dbRef.current;
      await persist({
        ...cur,
        mistakes: cur.mistakes.map(m => (m.id === mistakeId ? { ...m, folderId, updatedAt: Date.now() } : m)),
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

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      const cur = dbRef.current;
      await persist({ ...cur, folders: cur.folders.map(f => (f.id === id ? { ...f, name: name.trim() } : f)) });
    },
    [persist],
  );

  const deleteFolder = useCallback(
    async (id: string) => {
      const cur = dbRef.current;
      const parentId = cur.folders.find(f => f.id === id)?.parentId ?? null;
      await persist({
        ...cur,
        folders: cur.folders.filter(f => f.id !== id).map(f => (f.parentId === id ? { ...f, parentId } : f)),
        mistakes: cur.mistakes.map(m => (m.folderId === id ? { ...m, folderId: null } : m)),
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

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of db.mistakes) for (const t of x.tags) m.set(t, (m.get(t) ?? 0) + 1);
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
      setMistakeFolder,
      createFolder,
      findOrCreateFolder,
      renameFolder,
      deleteFolder,
      addNote,
      updateNote,
      deleteNote,
      addNotes,
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
      setMistakeFolder,
      createFolder,
      findOrCreateFolder,
      renameFolder,
      deleteFolder,
      addNote,
      updateNote,
      deleteNote,
      addNotes,
    ],
  );

  return <BookCtx.Provider value={value}>{children}</BookCtx.Provider>;
}

export function useBook(): Book {
  const ctx = useContext(BookCtx);
  if (!ctx) throw new Error("useBook 必须在 BookProvider 内使用");
  return ctx;
}
