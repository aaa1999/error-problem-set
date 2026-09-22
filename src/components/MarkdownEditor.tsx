import { useEffect, useDeferredValue, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_EXTS, extOf, importBlobAsImage, importImageFile } from "../lib/images";
import { renderMarkdown, resolveAssetRef } from "../lib/markdown";
import { useBook } from "../store";

type Mode = "edit" | "split" | "preview";

interface Props {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

export function MarkdownEditor({ value, onChange, autoFocus = false }: Props) {
  const { dataDir } = useBook();
  const [mode, setMode] = useState<Mode>("split");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 受控 textarea 外部改值后恢复光标（插图/包裹加粗等操作用）
  const caretReq = useRef<{ start: number; end: number } | null>(null);

  const flashError = (m: string) => {
    setErr(m);
    window.setTimeout(() => setErr(""), 3500);
  };

  useEffect(() => {
    const req = caretReq.current;
    if (!req || !taRef.current) return;
    caretReq.current = null;
    taRef.current.focus();
    taRef.current.setSelectionRange(req.start, req.end);
  }, [value]);

  const applyValue = (next: string, caret: { start: number; end: number }) => {
    caretReq.current = caret;
    onChange(next);
  };

  /** 在光标处插入文本 */
  const insertAtCaret = (text: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    applyValue(ta.value.slice(0, s) + text + ta.value.slice(e), { start: s + text.length, end: s + text.length });
  };

  /** 用成对符号包裹选区（无选区时插入占位词） */
  const wrapSelection = (before: string, after: string, placeholder: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart ?? 0;
    const e = ta.selectionEnd ?? 0;
    const inner = ta.value.slice(s, e) || placeholder;
    applyValue(ta.value.slice(0, s) + before + inner + after + ta.value.slice(e), {
      start: s + before.length,
      end: s + before.length + inner.length,
    });
  };

  const importBlobs = async (blobs: Blob[]) => {
    setBusy(n => n + 1);
    try {
      const parts: string[] = [];
      for (const b of blobs) {
        const img = await importBlobAsImage(dataDir, b);
        parts.push(`\n![图片](assets/${img.hash}.${img.ext})\n`);
      }
      if (parts.length > 0) insertAtCaret(parts.join(""));
    } catch (e) {
      flashError(`图片导入失败：${String(e)}`);
    } finally {
      setBusy(n => n - 1);
    }
  };

  const importPaths = async (paths: string[]) => {
    setBusy(n => n + 1);
    try {
      const parts: string[] = [];
      for (const p of paths) {
        const img = await importImageFile(dataDir, p);
        if (img) parts.push(`\n![图片](assets/${img.hash}.${img.ext})\n`);
      }
      if (parts.length > 0) insertAtCaret(parts.join(""));
      else flashError("没有找到可导入的图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）");
    } catch (e) {
      flashError(`图片导入失败：${String(e)}`);
    } finally {
      setBusy(n => n - 1);
    }
  };

  const pickImages = async () => {
    const res = await openDialog({ multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTS }] });
    if (!res) return;
    await importPaths(Array.isArray(res) ? res : [res]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = [...(e.clipboardData?.items ?? [])];
    const blobs = items
      .filter(it => it.type.startsWith("image/"))
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (blobs.length > 0) {
      e.preventDefault();
      void importBlobs(blobs);
      return;
    }
    // 从访达复制图片文件（file:// 地址/绝对路径）：全部片段都是图片路径才按导入处理
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const tokens = text
      .split(/[\n,，]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => (s.startsWith("file://") ? decodeURIComponent(s.replace(/^file:\/\//, "")) : s));
    if (tokens.length > 0 && tokens.every(p => IMAGE_EXTS.includes(extOf(p)))) {
      e.preventDefault();
      void importPaths(tokens);
    }
  };

  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
    if (files.length > 0) void importBlobs(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === "Tab") {
      e.preventDefault();
      insertAtCaret("  ");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 列表自动续行：光标前是「- / * / + / 1. / 1、/ - [ ]」开头的行，回车补同样的前缀；空列表项再回车取消
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
      const line = ta.value.slice(lineStart, s);
      const m = line.match(/^(\s*)(-\s\[\s\]\s|[-*+]\s|\d+[.、]\s)/);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) {
        applyValue(ta.value.slice(0, lineStart) + ta.value.slice(s), { start: lineStart, end: lineStart });
        return;
      }
      const om = m[2].match(/^(\d+)([.、])\s$/);
      const nextMarker = om ? `${parseInt(om[1], 10) + 1}${om[2]} ` : m[2];
      const ins = `\n${m[1]}${nextMarker}`;
      applyValue(ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd ?? s), { start: s + ins.length, end: s + ins.length });
    }
  };

  // 大文档下打字不卡：预览渲染挂到低优先级更新
  const deferred = useDeferredValue(value);
  const html = useMemo(() => renderMarkdown(deferred, ref => resolveAssetRef(ref, dataDir)), [deferred, dataDir]);

  return (
    <div className="md-editor">
      <div className="note-toolrow">
        <div className="tabs">
          {(["edit", "split", "preview"] as Mode[]).map(m => (
            <button key={m} className={`tab ${mode === m ? "active" : ""}`} onClick={() => setMode(m)}>
              {m === "edit" ? "编辑" : m === "split" ? "分屏" : "预览"}
            </button>
          ))}
        </div>
        {mode !== "preview" && (
          <>
            <button type="button" className="wtool" title="加粗" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection("**", "**", "加粗")}>
              <b>B</b>
            </button>
            <button type="button" className="wtool" title="斜体" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection("*", "*", "斜体")}>
              <i>I</i>
            </button>
            <button type="button" className="wtool" title="行内代码" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection("`", "`", "代码")}>
              码
            </button>
            <button type="button" className="wtool" title="引用" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection("> ", "", "引用内容")}>
              ❝
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void pickImages()} disabled={busy > 0}>
              📎 插入图片
            </button>
            {busy > 0 && <span className="muted">导入中…</span>}
            <span className="muted note-hint">粘贴/拖入图片自动入库 · 支持表格、任务列表等 GFM 语法</span>
          </>
        )}
      </div>
      {err && <div className="be-error">{err}</div>}
      <div className={`md-panes mode-${mode}`}>
        {mode !== "preview" && (
          <textarea
            ref={taRef}
            className="md-src"
            value={value}
            autoFocus={autoFocus}
            spellCheck={false}
            placeholder={"# 标题\n\n支持 Markdown 语法，直接粘贴截图、拖入图片"}
            onChange={e => onChange(e.target.value)}
            onPaste={onPaste}
            onDrop={onDrop}
            onKeyDown={onKeyDown}
          />
        )}
        {mode !== "edit" && (
          <div className="md-preview rich-text" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
