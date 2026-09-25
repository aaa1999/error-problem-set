import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Block, ImageBlock, TextBlock } from "../types";
import { newTextNode } from "../lib/utils";
import { IMAGE_EXTS, extOf, importBlobAsImage, importImageFile } from "../lib/images";
import { useBook } from "../store";

interface Props {
  label: string;
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function BlockEditor({ label, blocks, onChange, placeholder, autoFocus = false }: Props) {
  const { dataDir, assetSrc } = useBook();
  const [pathDraft, setPathDraft] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(0);
  const focusReq = useRef<{ id: string; caret: number | "start" | "end" } | null>(null);
  const editRefs = useRef(new Map<string, HTMLDivElement>());
  // 块列表的实时镜像：图片导入是异步的，落位时必须基于最新内容追加，
  // 否则会用旧闭包覆盖掉导入期间新插入的图或用户刚输入的文字
  const blocksRef = useRef(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  const updateBlocks = (next: Block[]) => {
    blocksRef.current = next;
    onChange(next);
  };

  const flashError = (m: string) => {
    setErr(m);
    window.setTimeout(() => setErr(""), 3500);
  };

  // 图片导入串行排队：连续粘贴/拖入/选文件的多批图片按触发顺序依次落位，互不覆盖
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueImport = (fn: () => Promise<void>) => {
    setBusy(n => n + 1);
    queueRef.current = queueRef.current
      .then(fn)
      .catch(e => flashError(`导入失败：${String(e)}`))
      .finally(() => setBusy(n => n - 1));
  };

  // 空内容时给一个文本块，打开就能直接打字
  useEffect(() => {
    if (blocks.length === 0) updateBlocks([newTextNode("")]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 块结构变化（分段/合并/插图）后恢复光标
  useEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    const el = editRefs.current.get(req.id);
    if (!el) return;
    el.focus();
    const len = el.textContent?.length ?? 0;
    const off = req.caret === "start" ? 0 : req.caret === "end" ? len : Math.min(req.caret, len);
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    if (el.firstChild) range.setStart(el.firstChild, off);
    else range.setStart(el, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }, [blocks]);

  const handleInput = (id: string, text: string) => {
    updateBlocks(blocksRef.current.map(b => (b.type === "text" && b.id === id ? { ...b, text } : b)));
  };

  const splitAt = (id: string, offset: number) => {
    const list = blocksRef.current;
    const i = list.findIndex(b => b.type === "text" && b.id === id);
    if (i < 0) return;
    const curBlock = list[i] as TextBlock;
    const before: TextBlock = { ...curBlock, text: curBlock.text.slice(0, offset) };
    const after = newTextNode(curBlock.text.slice(offset));
    const next = [...list];
    next.splice(i, 1, before, after);
    updateBlocks(next);
    focusReq.current = { id: after.id, caret: "start" };
  };

  const mergeBack = (id: string) => {
    const list = blocksRef.current;
    const i = list.findIndex(b => b.type === "text" && b.id === id);
    if (i <= 0) return;
    const curBlock = list[i] as TextBlock;
    const prev = list[i - 1];
    const next = [...list];
    if (prev.type === "image") {
      // 行首退格删掉上一张图
      next.splice(i - 1, 1);
      updateBlocks(next);
      focusReq.current = { id: curBlock.id, caret: "start" };
      return;
    }
    const joinOffset = prev.text.length;
    next.splice(i - 1, 2, { ...prev, text: prev.text + curBlock.text });
    updateBlocks(next);
    focusReq.current = { id: prev.id, caret: joinOffset };
  };

  /** 在锚点文本块之后（无锚点则末尾）按给定顺序插入块 */
  const insertAfter = (anchorId: string | null, insertions: Block[]) => {
    const list = blocksRef.current;
    const next = [...list];
    const i = anchorId ? next.findIndex(b => b.type === "text" && b.id === anchorId) : -1;
    next.splice(i >= 0 ? i + 1 : next.length, 0, ...insertions);
    updateBlocks(next);
  };

  const removeBlockAt = (idx: number) => updateBlocks(blocksRef.current.filter((_, i) => i !== idx));

  const moveBlock = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    const list = blocksRef.current;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    updateBlocks(next);
  };

  const importFilePaths = (paths: string[], anchorId: string | null) =>
    enqueueImport(async () => {
      const imgs: ImageBlock[] = [];
      for (const p of paths) {
        const b = await importImageFile(dataDir, p);
        if (b) imgs.push(b);
      }
      if (imgs.length === 0) {
        flashError("没有找到可导入的图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）");
        return;
      }
      insertAfter(anchorId, imgs);
    });

  const importBlobs = (blobs: Blob[], anchorId: string | null) =>
    enqueueImport(async () => {
      const imgs: ImageBlock[] = [];
      for (const blob of blobs) imgs.push(await importBlobAsImage(dataDir, blob));
      if (imgs.length > 0) insertAfter(anchorId, imgs);
    });

  const pickFiles = async () => {
    const res = await openDialog({ multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTS }] });
    if (!res) return;
    importFilePaths(Array.isArray(res) ? res : [res], null);
  };

  const onPathEnter = () => {
    const tokens = pathDraft
      .split(/[\n,，]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    setPathDraft("");
    importFilePaths(tokens, null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
    if (files.length > 0) importBlobs(files, null);
  };

  return (
    <div className="block-editor" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <div className="be-toolbar">
        <span className="be-label">{label}</span>
        <button type="button" className="btn btn-sm" onClick={() => void pickFiles()} disabled={busy > 0}>
          📎 插入图片
        </button>
        <input
          className="be-path"
          value={pathDraft}
          placeholder="图片路径，回车导入"
          onChange={e => setPathDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              onPathEnter();
            }
          }}
        />
        {busy > 0 && <span className="muted">导入中…</span>}
      </div>
      {err && <div className="be-error">{err}</div>}
      <div className="be-body">
        {blocks.map((b, i) =>
          b.type === "text" ? (
            <TextCell
              key={b.id}
              block={b}
              placeholder={i === 0 ? placeholder : ""}
              autoFocus={autoFocus && i === 0}
              registerRef={el => {
                if (el) editRefs.current.set(b.id, el);
                else editRefs.current.delete(b.id);
              }}
              onInput={t => handleInput(b.id, t)}
              onEnter={splitAt}
              onMergeBack={mergeBack}
              onPasteImages={blobs => importBlobs(blobs, b.id)}
              onPastePaths={paths => importFilePaths(paths, b.id)}
            />
          ) : (
            <figure key={`${b.hash}-${i}`} className="be-img-wrap">
              <img src={assetSrc(b)} alt="" />
              <div className="be-img-tools">
                <button type="button" title="上移" onClick={() => moveBlock(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button type="button" title="下移" onClick={() => moveBlock(i, 1)} disabled={i === blocks.length - 1}>
                  ↓
                </button>
                <button type="button" title="删除" onClick={() => removeBlockAt(i)}>
                  ✕
                </button>
              </div>
            </figure>
          ),
        )}
      </div>
    </div>
  );
}

function getCaretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

interface TextCellProps {
  block: TextBlock;
  placeholder?: string;
  autoFocus: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onInput: (text: string) => void;
  onEnter: (id: string, offset: number) => void;
  onMergeBack: (id: string) => void;
  onPasteImages: (blobs: Blob[]) => void;
  onPastePaths: (paths: string[]) => void;
}

function TextCell({
  block,
  placeholder,
  autoFocus,
  registerRef,
  onInput,
  onEnter,
  onMergeBack,
  onPasteImages,
  onPastePaths,
}: TextCellProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 只在挂载时写入内容，之后完全交给浏览器管理 DOM，避免打断输入光标
  useEffect(() => {
    if (ref.current && ref.current.textContent !== block.text) ref.current.textContent = block.text;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const off = ref.current ? getCaretOffset(ref.current) : null;
      onEnter(block.id, off ?? block.text.length);
    } else if (e.key === "Backspace") {
      const off = ref.current ? getCaretOffset(ref.current) : null;
      if ((off ?? 1) === 0) {
        e.preventDefault();
        onMergeBack(block.id);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (items) {
      const imgBlobs = [...items]
        .filter(it => it.type.startsWith("image/"))
        .map(it => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (imgBlobs.length > 0) {
        e.preventDefault();
        onPasteImages(imgBlobs);
        return;
      }
    }
    // 从访达复制图片文件（或复制的 file:// 地址/绝对路径）粘贴进来：全部片段都是图片路径才按导入处理
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const tokens = text
      .split(/[\n,，]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => (s.startsWith("file://") ? decodeURIComponent(s.replace(/^file:\/\//, "")) : s));
    if (tokens.length > 0 && tokens.every(p => IMAGE_EXTS.includes(extOf(p)))) {
      e.preventDefault();
      onPastePaths(tokens);
      return;
    }
    // 其余统一按纯文本插入，保证数据模型干净
    if (text) {
      e.preventDefault();
      document.execCommand("insertText", false, text);
    }
  };

  return (
    <div
      ref={el => {
        ref.current = el;
        registerRef(el);
      }}
      className="be-text"
      data-placeholder={placeholder}
      contentEditable
      suppressContentEditableWarning
      onInput={e => onInput(e.currentTarget.textContent ?? "")}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}
