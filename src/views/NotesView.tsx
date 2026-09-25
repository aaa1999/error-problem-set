import { useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Note } from "../types";
import { formatTime, uuid } from "../lib/utils";
import { noteExcerpt, renderMarkdown, resolveAssetRef, sanitizeWordHtml, mapAssetsInHtml } from "../lib/markdown";
import { useBook } from "../store";
import { NoteEditor } from "../components/NoteEditor";

/** 新建一篇笔记：先在内存里建草稿，输入了内容才落盘；没输入就切走则直接丢弃 */
function newDraft(format: Note["format"]): Note {
  const now = Date.now();
  return { id: uuid(), title: "", format, content: "", createdAt: now, updatedAt: now };
}

/** 远程设备的笔记：只读查看（markdown 渲染 / word 富文本），不能编辑 */
function RemoteNoteViewer({ note, onBack }: { note: Note; onBack: () => void }) {
  const { dataDir } = useBook();
  const html = useMemo(
    () =>
      note.format === "markdown"
        ? renderMarkdown(note.content, ref => resolveAssetRef(ref, dataDir))
        : mapAssetsInHtml(sanitizeWordHtml(note.content), r => resolveAssetRef(r, dataDir)),
    [note, dataDir],
  );
  return (
    <div className="remote-note-viewer">
      <div className="note-viewer-top">
        <button className="btn btn-sm" onClick={onBack}>
          ← 返回
        </button>
        <span className={`note-badge ${note.format === "word" ? "word" : "md"}`}>{note.format === "word" ? "Word" : "MD"}</span>
        <span className="muted">
          {note.title.trim() || "无标题"} · 更新于 {formatTime(note.updatedAt)} · 远程设备只读
        </span>
      </div>
      <div className="note-viewer-body md-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function NotesView() {
  const { db, deleteNote, remoteDevices } = useBook();
  // 设备范围："" = 本机；其余为已拉取的远程设备 id（只读）
  const [deviceScope, setDeviceScope] = useState("");
  const remote = remoteDevices.find(d => d.id === deviceScope) ?? null;
  const activeDb = remote ? remote.db : db;
  const readOnly = remote !== null;
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Note | null>(null);
  const [query, setQuery] = useState("");
  // 右键菜单：笔记列表项上右键（x/y 为光标位置）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; noteId: string } | null>(null);

  const notes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...activeDb.notes]
      .filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeDb.notes, query]);

  const selected = (sel && draft && sel === draft.id ? draft : undefined) ?? activeDb.notes.find(n => n.id === sel);

  const create = (format: Note["format"]) => {
    const d = newDraft(format);
    setDraft(d);
    setSel(d.id);
  };

  const pick = (id: string) => {
    if (draft && selected && selected.id === draft.id && selected.id !== id) {
      // 从草稿切走：没内容就丢弃（NoteEditor 卸载兜底只存非空内容）
      setDraft(null);
    }
    setSel(id);
  };

  const backToList = () => {
    setDraft(null);
    setSel(null);
  };

  const removeNote = async (n: Note) => {
    setCtxMenu(null);
    const ok = await ask(`确定删除笔记「${n.title.trim() || "无标题"}」吗？（旧数据在数据目录的 snapshots 里还有备份）`, {
      title: "删除确认",
    });
    if (!ok) return;
    await deleteNote(n.id);
    if (sel === n.id) backToList();
  };

  const switchDevice = (id: string) => {
    setDeviceScope(id);
    setSel(null);
    setDraft(null);
    setQuery("");
  };

  return (
    <>
      <div className="notes-layout">
      <aside className="notes-side">
        {remoteDevices.length > 0 && (
          <div className="device-pills">
            <button className={`device-pill ${deviceScope === "" ? "on" : ""}`} onClick={() => switchDevice("")}>
              本机
            </button>
            {remoteDevices.map(d => (
              <button
                key={d.id}
                className={`device-pill ${deviceScope === d.id ? "on" : ""}`}
                title={`${d.name} 的笔记（只读）`}
                onClick={() => switchDevice(d.id)}
              >
                📱 {d.name}
              </button>
            ))}
          </div>
        )}
        {!readOnly && (
          <div className="notes-side-head">
            <button className="btn btn-sm" onClick={() => create("markdown")}>
              ＋ Markdown 笔记
            </button>
            <button className="btn btn-sm" onClick={() => create("word")}>
              ＋ Word 笔记
            </button>
          </div>
        )}
        {readOnly && remote && <div className="notes-side-head muted">📱 {remote.name} · 只读</div>}
        <div className="notes-search-wrap">
          <input className="notes-search" value={query} placeholder="搜索笔记…" onChange={e => setQuery(e.target.value)} />
          {activeDb.notes.length > 0 && (
            <span className="muted">
              {notes.length} / {activeDb.notes.length} 篇
            </span>
          )}
        </div>
        <div className="notes-list">
          {notes.length === 0 ? (
            <div className="notes-list-empty muted">
              {activeDb.notes.length === 0
                ? readOnly
                  ? "该设备还没有笔记"
                  : "还没有笔记，点上面的按钮新建一篇"
                : "没有匹配的笔记"}
            </div>
          ) : (
            notes.map(n => (
              <button
                key={n.id}
                className={`note-item ${selected?.id === n.id ? "active" : ""}`}
                onClick={() => pick(n.id)}
                onContextMenu={e => {
                  if (readOnly) return;
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, noteId: n.id });
                }}
              >
                <span className="note-item-top">
                  <span className={`note-badge ${n.format === "word" ? "word" : "md"}`}>{n.format === "word" ? "Word" : "MD"}</span>
                  <span>{formatTime(n.updatedAt)}</span>
                </span>
                <span className="note-item-title">{n.title.trim() || "无标题"}</span>
                {noteExcerpt(n) && <span className="note-item-snippet">{noteExcerpt(n)}</span>}
              </button>
            ))
          )}
        </div>
      </aside>
      <section className="notes-main">
        {readOnly ? (
          selected ? (
            <RemoteNoteViewer note={selected} onBack={backToList} />
          ) : (
            <div className="empty-state note-empty">
              <div className="empty-icon">📱</div>
              <h2>{remote?.name} 的笔记</h2>
              <p>来自远程设备，只读浏览（「☁ 同步 → 按设备拉取」后可刷新）</p>
            </div>
          )
        ) : selected ? (
          <NoteEditor
            key={selected.id}
            note={selected}
            isNew={draft?.id === selected.id}
            onBack={backToList}
            onDeleted={backToList}
          />
        ) : (
          <div className="empty-state note-empty">
            <div className="empty-icon">📝</div>
            <h2>笔记</h2>
            <p>Markdown（即时预览、可粘贴图片）或 Word 富文本，均支持导出 PDF / Word</p>
          </div>
        )}
      </section>
      </div>
      {/* 笔记右键菜单：删除 */}
      {ctxMenu && (
        <>
          <div
            className="popover-backdrop"
            onClick={() => setCtxMenu(null)}
            onContextMenu={e => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 170),
              top: Math.min(ctxMenu.y, window.innerHeight - 64),
            }}
          >
            <button
              className="danger"
              onClick={() => {
                const n = db.notes.find(x => x.id === ctxMenu.noteId);
                if (n) void removeNote(n);
                else setCtxMenu(null);
              }}
            >
              🗑 删除笔记
            </button>
          </div>
        </>
      )}
    </>
  );
}
