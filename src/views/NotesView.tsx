import { useMemo, useState } from "react";
import type { Note } from "../types";
import { formatTime, uuid } from "../lib/utils";
import { noteExcerpt } from "../lib/markdown";
import { useBook } from "../store";
import { NoteEditor } from "../components/NoteEditor";

/** 新建一篇笔记：先在内存里建草稿，输入了内容才落盘；没输入就切走则直接丢弃 */
function newDraft(format: Note["format"]): Note {
  const now = Date.now();
  return { id: uuid(), title: "", format, content: "", createdAt: now, updatedAt: now };
}

export function NotesView() {
  const { db } = useBook();
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Note | null>(null);
  const [query, setQuery] = useState("");

  const notes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...db.notes]
      .filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [db.notes, query]);

  const selected = (sel && draft && sel === draft.id ? draft : undefined) ?? db.notes.find(n => n.id === sel);

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

  return (
    <div className="notes-layout">
      <aside className="notes-side">
        <div className="notes-side-head">
          <button className="btn btn-sm" onClick={() => create("markdown")}>
            ＋ Markdown 笔记
          </button>
          <button className="btn btn-sm" onClick={() => create("word")}>
            ＋ Word 笔记
          </button>
        </div>
        <div className="notes-search-wrap">
          <input className="notes-search" value={query} placeholder="搜索笔记…" onChange={e => setQuery(e.target.value)} />
          {db.notes.length > 0 && (
            <span className="muted">
              {notes.length} / {db.notes.length} 篇
            </span>
          )}
        </div>
        <div className="notes-list">
          {notes.length === 0 ? (
            <div className="notes-list-empty muted">
              {db.notes.length === 0 ? "还没有笔记，点上面的按钮新建一篇" : "没有匹配的笔记"}
            </div>
          ) : (
            notes.map(n => (
              <button key={n.id} className={`note-item ${selected?.id === n.id ? "active" : ""}`} onClick={() => pick(n.id)}>
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
        {selected ? (
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
  );
}
