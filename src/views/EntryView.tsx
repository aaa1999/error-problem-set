import { useEffect, useRef, useState } from "react";
import type { Block, Mistake } from "../types";
import { isBlocksEmpty, newTextNode, uuid } from "../lib/utils";
import { useBook } from "../store";
import { BlockEditor } from "../components/BlockEditor";
import { TagInput } from "../components/TagInput";
import { FolderSelect } from "../components/FolderSelect";

export function EntryView({
  editId,
  onDone,
  onGoBatch,
  defaultFolderId = null,
}: {
  editId?: string;
  onDone: () => void;
  onGoBatch: () => void;
  defaultFolderId?: string | null;
}) {
  const { db, allTags, addMistake, updateMistake, getMistake } = useBook();
  const editing = editId ? db.mistakes.find(m => m.id === editId) : undefined;
  // 用 ref 取最新的编辑目标，避免自动保存更新 db 后触发重复保存
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const [qBlocks, setQBlocks] = useState<Block[]>(() => (editing ? structuredClone(editing.question) : [newTextNode("")]));
  const [aBlocks, setABlocks] = useState<Block[]>(() => (editing ? structuredClone(editing.analysis) : [newTextNode("")]));
  const [tags, setTags] = useState<string[]>(() => (editing ? [...editing.tags] : []));
  const [folderId, setFolderId] = useState<string | null>(() => (editing ? editing.folderId ?? null : defaultFolderId));
  const [flash, setFlash] = useState("");

  // 表单最新值镜像：卸载时兜底保存用
  const formRef = useRef({ qBlocks, aBlocks, tags, folderId, editId });
  formRef.current = { qBlocks, aBlocks, tags, folderId, editId };

  // 切走页面（含切到笔记 tab）时，自动保存的 900ms 间隙里没落盘的内容补一次
  useEffect(() => {
    return () => {
      const f = formRef.current;
      if (!f.editId) return; // 新题只认显式保存
      const target = getMistake(f.editId);
      if (target && !isBlocksEmpty(f.qBlocks)) {
        void updateMistake({
          ...target,
          question: f.qBlocks,
          analysis: f.aBlocks,
          tags: f.tags,
          folderId: f.folderId,
          updatedAt: Date.now(),
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valid = !isBlocksEmpty(qBlocks);

  const showFlash = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(""), 1800);
  };

  const buildMistake = (): Mistake => ({
    id: editing?.id ?? uuid(),
    folderId,
    question: qBlocks,
    analysis: aBlocks,
    tags,
    createdAt: editing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });

  const saveAndNext = async () => {
    if (!valid) return;
    await addMistake(buildMistake());
    setQBlocks([newTextNode("")]);
    setABlocks([newTextNode("")]);
    // 标签和文件夹保留，方便连续录入同一章节的题
    showFlash("已保存 ✓，继续录入下一题");
  };

  const saveAndDone = async () => {
    if (!valid) return;
    if (editing) await updateMistake(buildMistake());
    else await addMistake(buildMistake());
    onDone();
  };

  // 编辑已有错题时：停止输入 900ms 后自动保存，防止忘点保存丢内容
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const target = editingRef.current;
      if (!target || isBlocksEmpty(qBlocks)) return;
      void updateMistake({
        ...target,
        question: qBlocks,
        analysis: aBlocks,
        tags,
        folderId,
        updatedAt: Date.now(),
      });
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qBlocks, aBlocks, tags, folderId, editId]);

  // Ctrl/Cmd + Enter 快捷保存
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (editing) void saveAndDone();
        else void saveAndNext();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qBlocks, aBlocks, tags, folderId, editing, valid]);

  return (
    <div className="entry">
      <div className="entry-head">
        <h2>{editing ? "编辑错题" : "录入错题"}</h2>
        {!editing && (
          <button className="btn btn-sm" onClick={onGoBatch}>
            📂 批量导入文件夹截图
          </button>
        )}
      </div>

      <div className="entry-meta">
        <FolderSelect value={folderId} onChange={setFolderId} />
        <TagInput value={tags} onChange={setTags} suggestions={allTags} />
      </div>

      <BlockEditor
        label="题目"
        blocks={qBlocks}
        onChange={setQBlocks}
        placeholder="输入题目文字，或直接粘贴截图 / 拖入图片"
        autoFocus={!editing}
      />
      <BlockEditor label="解析" blocks={aBlocks} onChange={setABlocks} placeholder="输入解析文字，或粘贴解析截图" />

      <div className="entry-foot">
        <span className="muted">图片四通道：粘贴截图 · 拖入文件 · 📎 选择文件 · 输入路径{editing && " · 修改会自动保存"}</span>
        <div className="row-actions">
          {editing ? (
            <>
              <button className="btn" onClick={onDone}>
                返回
              </button>
              <button className="btn btn-primary" disabled={!valid} onClick={() => void saveAndDone()}>
                保存并返回
              </button>
            </>
          ) : (
            <>
              <button className="btn" disabled={!valid} onClick={() => void saveAndDone()}>
                保存并去浏览
              </button>
              <button className="btn btn-primary" disabled={!valid} onClick={() => void saveAndNext()}>
                保存并录入下一题 ⏎
              </button>
            </>
          )}
        </div>
      </div>
      {flash && <div className="saved-flash">{flash}</div>}
    </div>
  );
}
