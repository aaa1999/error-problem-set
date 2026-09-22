import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Note } from "../types";
import { formatTime } from "../lib/utils";
import { isNoteEmpty } from "../lib/markdown";
import { MarkdownEditor } from "./MarkdownEditor";
import { WordEditor } from "./WordEditor";
import { useBook } from "../store";

interface Props {
  note: Note;
  /** 全新还没落过盘的笔记：内容为空时不写入，直接丢弃 */
  isNew: boolean;
  onBack: () => void;
  onDeleted: () => void;
}

export function NoteEditor({ note, isNew, onBack, onDeleted }: Props) {
  const { dataDir, db, addNote, updateNote, deleteNote } = useBook();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [flash, setFlash] = useState("");
  const [exporting, setExporting] = useState<"pdf" | "doc" | null>(null);
  const [exportErr, setExportErr] = useState("");

  // 最新值镜像：防抖保存 / 卸载兜底 / 导出都用它，不吃旧闭包
  const latest = useRef({ title, content });
  latest.current = { title, content };
  const dirtyRef = useRef(false);
  const persistedRef = useRef(!isNew && db.notes.some(n => n.id === note.id));

  const save = useCallback(async () => {
    if (!dirtyRef.current) return;
    const { title, content } = latest.current;
    if (isNoteEmpty(title, content, note.format)) {
      // 空内容不落盘；已持久化的保持原样（用户清空内容另有删除按钮）
      if (!persistedRef.current) dirtyRef.current = false;
      return;
    }
    const now = Date.now();
    const next: Note = { ...note, title, content, updatedAt: now };
    if (persistedRef.current) await updateNote(next);
    else await addNote(next);
    persistedRef.current = true;
    dirtyRef.current = false;
    setSavedAt(now);
  }, [note, addNote, updateNote]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const showFlash = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(""), 1800);
  };

  // 停止输入 800ms 后自动保存
  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => void save(), 800);
    return () => window.clearTimeout(timer);
  }, [title, content, save]);

  // 切走页面（切 tab、选别的笔记）时，防抖间隙里没落盘的内容补一次
  useEffect(() => {
    return () => {
      const { title, content } = latest.current;
      if (dirtyRef.current && !isNoteEmpty(title, content, note.format)) void saveRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl/Cmd + S 立即保存
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current().then(() => showFlash("已保存 ✓"));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const changeTitle = (v: string) => {
    dirtyRef.current = true;
    setTitle(v);
  };
  const changeContent = (v: string) => {
    dirtyRef.current = true;
    setContent(v);
  };

  const doDelete = async () => {
    const ok = await ask(`删除笔记「${title.trim() || "无标题"}」？此操作不可恢复。`, { title: "删除笔记" });
    if (!ok) return;
    dirtyRef.current = false; // 防止卸载兜底又把它存回来
    if (persistedRef.current) await deleteNote(note.id);
    onDeleted();
  };

  const runExport = async (kind: "pdf" | "doc") => {
    setExportErr("");
    setExporting(kind);
    try {
      await saveRef.current(); // 导出前先把最新内容落盘
      // 导出库（jsPDF + html2canvas）体积大，点导出时才加载
      const { exportNoteAsDoc, exportNoteAsPdf } = await import("../lib/noteExport");
      const target: Note = { ...note, title: latest.current.title, content: latest.current.content };
      const res = kind === "pdf" ? await exportNoteAsPdf(target, dataDir) : await exportNoteAsDoc(target, dataDir);
      if (res === "saved") showFlash(kind === "pdf" ? "已导出 PDF ✓" : "已导出 Word ✓");
    } catch (e) {
      setExportErr(`导出失败：${String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="note-editor">
      <div className="note-editor-head">
        <button className="btn btn-sm" onClick={onBack}>
          ← 返回
        </button>
        <input className="note-title-input" value={title} placeholder="笔记标题" onChange={e => changeTitle(e.target.value)} />
        <span className={`note-badge ${note.format === "word" ? "word" : "md"}`}>
          {note.format === "word" ? "Word 富文本" : "Markdown"}
        </span>
        <span className="muted note-save-state">
          {savedAt ? `已保存 ${formatTime(savedAt)}` : isNew && !persistedRef.current ? "输入后自动保存" : ""}
        </span>
        <div className="note-editor-acts">
          <button className="btn btn-sm" disabled={exporting !== null} onClick={() => void runExport("pdf")}>
            {exporting === "pdf" ? "导出中…" : "导出 PDF"}
          </button>
          <button className="btn btn-sm" disabled={exporting !== null} onClick={() => void runExport("doc")}>
            {exporting === "doc" ? "导出中…" : "导出 Word"}
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void doDelete()}>
            删除
          </button>
        </div>
      </div>
      {exportErr && <div className="be-error note-export-err">{exportErr}</div>}
      <div className="note-editor-body">
        {note.format === "markdown" ? (
          <MarkdownEditor key={note.id} value={content} onChange={changeContent} autoFocus={isNew} />
        ) : (
          <WordEditor key={note.id} value={content} onChange={changeContent} autoFocus={isNew} />
        )}
      </div>
      {flash && <div className="saved-flash">{flash}</div>}
    </div>
  );
}
