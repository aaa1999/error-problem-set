import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_EXTS, extOf, importBlobAsImage, importImageFile } from "../lib/images";
import { mapAssetsInHtml, relativizeAssetUrl, resolveAssetRef } from "../lib/markdown";
import { useBook } from "../store";

interface Props {
  value: string;
  onChange: (html: string) => void;
  autoFocus?: boolean;
}

const BLOCKS: [string, string][] = [
  ["p", "正文"],
  ["h1", "标题 1"],
  ["h2", "标题 2"],
  ["h3", "标题 3"],
];

/** Word 风格富文本编辑器：contenteditable + execCommand（浏览器内置，产出干净的 b/i/h1 标签） */
export function WordEditor({ value, onChange, autoFocus = false }: Props) {
  const { dataDir } = useBook();
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(0);
  const [block, setBlock] = useState("p");

  const flashError = (m: string) => {
    setErr(m);
    window.setTimeout(() => setErr(""), 3500);
  };

  useEffect(() => {
    // 产出语义标签（<b>/<i>）而不是 style spans，Word 打开更干净
    document.execCommand("styleWithCSS", false, "false");
    if (!ref.current) return;
    ref.current.innerHTML = mapAssetsInHtml(value, r => resolveAssetRef(r, dataDir));
    if (autoFocus) ref.current.focus();
    // 只在挂载时写入内容（按 note.id 重挂载），之后交给浏览器管理 DOM，避免打断光标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 段落格式下拉框跟随光标所在的块
  useEffect(() => {
    const h = () => {
      const sel = window.getSelection();
      const el = ref.current;
      if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      let node: Node | null = sel.anchorNode;
      while (node && node !== el) {
        const tag = node instanceof HTMLElement ? node.tagName.toLowerCase() : "";
        if (tag === "h1" || tag === "h2" || tag === "h3") {
          setBlock(tag);
          return;
        }
        if (tag === "p" || tag === "div" || tag === "blockquote" || tag === "li") {
          setBlock("p");
          return;
        }
        node = node.parentNode;
      }
    };
    document.addEventListener("selectionchange", h);
    return () => document.removeEventListener("selectionchange", h);
  }, []);

  /** 编辑区 DOM → 存储格式：本库图片地址还原为 assets/ 相对引用 */
  const serialize = () => {
    const el = ref.current;
    if (!el) return;
    const html = el.innerHTML.replace(/(\ssrc=")([^"]*)(")/g, (m, head: string, src: string, tail: string) => {
      const rel = relativizeAssetUrl(src, dataDir);
      return rel === src ? m : `${head}${rel}${tail}`;
    });
    onChange(html);
  };

  const exec = (cmd: string, val?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    serialize();
  };

  const insertHtml = (html: string) => {
    ref.current?.focus();
    document.execCommand("insertHTML", false, html);
    serialize();
  };

  const importBlobs = async (blobs: Blob[]) => {
    setBusy(n => n + 1);
    try {
      for (const b of blobs) {
        const img = await importBlobAsImage(dataDir, b);
        insertHtml(`<img src="${resolveAssetRef(`assets/${img.hash}.${img.ext}`, dataDir)}" alt="图片">`);
      }
    } catch (e) {
      flashError(`图片导入失败：${String(e)}`);
    } finally {
      setBusy(n => n - 1);
    }
  };

  const importPaths = async (paths: string[]) => {
    setBusy(n => n + 1);
    try {
      let found = false;
      for (const p of paths) {
        const img = await importImageFile(dataDir, p);
        if (img) {
          found = true;
          insertHtml(`<img src="${resolveAssetRef(`assets/${img.hash}.${img.ext}`, dataDir)}" alt="图片">`);
        }
      }
      if (!found) flashError("没有找到可导入的图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）");
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

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
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
    // 从访达复制的图片文件路径：全部片段都是图片路径才按导入处理；其余（含富文本）走默认粘贴
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

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
    if (files.length > 0) void importBlobs(files);
  };

  /** 工具栏按钮不抢焦点，保住编辑区选区 */
  const keepFocus = (e: MouseEvent) => e.preventDefault();

  return (
    <div className="word-editor">
      <div className="note-toolrow">
        <select
          className="word-block-select"
          value={block}
          onChange={e => {
            setBlock(e.target.value);
            exec("formatBlock", `<${e.target.value}>`);
          }}
        >
          {BLOCKS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="wtool" title="加粗" onMouseDown={keepFocus} onClick={() => exec("bold")}>
          <b>B</b>
        </button>
        <button type="button" className="wtool" title="斜体" onMouseDown={keepFocus} onClick={() => exec("italic")}>
          <i>I</i>
        </button>
        <button type="button" className="wtool" title="下划线" onMouseDown={keepFocus} onClick={() => exec("underline")}>
          <u>U</u>
        </button>
        <button type="button" className="wtool" title="删除线" onMouseDown={keepFocus} onClick={() => exec("strikeThrough")}>
          <s>S</s>
        </button>
        <span className="tool-div" />
        <button type="button" className="wtool" title="无序列表" onMouseDown={keepFocus} onClick={() => exec("insertUnorderedList")}>
          • 列表
        </button>
        <button type="button" className="wtool" title="有序列表" onMouseDown={keepFocus} onClick={() => exec("insertOrderedList")}>
          1. 列表
        </button>
        <button type="button" className="wtool" title="引用" onMouseDown={keepFocus} onClick={() => exec("formatBlock", "<blockquote>")}>
          ❝
        </button>
        <button type="button" className="wtool" title="分隔线" onMouseDown={keepFocus} onClick={() => exec("insertHorizontalRule")}>
          ―
        </button>
        <span className="tool-div" />
        <button type="button" className="btn btn-sm" onClick={() => void pickImages()} disabled={busy > 0}>
          📎 插入图片
        </button>
        <button type="button" className="wtool" title="清除格式" onMouseDown={keepFocus} onClick={() => exec("removeFormat")}>
          ⌫ 格式
        </button>
        {busy > 0 && <span className="muted">导入中…</span>}
        <span className="muted note-hint">可直接粘贴截图、从网页/Word 粘贴富文本</span>
      </div>
      {err && <div className="be-error">{err}</div>}
      <div
        ref={ref}
        className="word-body rich-text"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="开始书写，支持加粗、标题、列表，可直接粘贴截图"
        onInput={serialize}
        onPaste={onPaste}
        onDrop={onDrop}
      />
    </div>
  );
}
