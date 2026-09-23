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
  const [folderIds, setFolderIds] = useState<string[]>(() => editing ? [...editing.folderIds] : defaultFolderId ? [defaultFolderId] : []);
  // 选择题选项：默认摆出 A–D 四个空框（留空保存即非选择题）；编辑已有题带出已存的选项
  const [options, setOptions] = useState<string[]>(() =>
    editing && editing.options.length > 0 ? [...editing.options] : ["", "", "", ""],
  );
  const [answer, setAnswer] = useState<number | null>(() => (editing ? editing.answer : null));
  const [flash, setFlash] = useState("");

  /** 过滤空选项；全空 = 非选择题 */
  const cleanOptions = () => options.map(o => o.trim()).filter(Boolean);

  const optionsReady = () => {
    const opts = cleanOptions();
    return opts.length === 0 || answer !== null; // 填了选项必须标记正确答案
  };

  // 表单最新值镜像：卸载时兜底保存用
  const formRef = useRef({ qBlocks, aBlocks, tags, folderIds, options, answer, editId });
  formRef.current = { qBlocks, aBlocks, tags, folderIds, options, answer, editId };

  // 切走页面（含切到笔记 tab）时，自动保存的 900ms 间隙里没落盘的内容补一次
  useEffect(() => {
    return () => {
      const f = formRef.current;
      if (!f.editId) return; // 新题只认显式保存
      const target = getMistake(f.editId);
      const opts = f.options.map(o => o.trim()).filter(Boolean);
      if (target && !isBlocksEmpty(f.qBlocks) && (opts.length === 0 || f.answer !== null)) {
        void updateMistake({
          ...target,
          question: f.qBlocks,
          analysis: f.aBlocks,
          tags: f.tags,
          folderIds: f.folderIds,
          options: opts,
          answer: opts.length > 0 ? f.answer : null,
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

  const buildMistake = (): Mistake => {
    const opts = cleanOptions();
    return {
      id: editing?.id ?? uuid(),
      folderIds,
      options: opts,
      answer: opts.length > 0 ? answer : null,
      attempts: editing?.attempts ?? 0, // 作答统计随编辑保留，只增不减
      wrong: editing?.wrong ?? 0,
      question: qBlocks,
      analysis: aBlocks,
      tags,
      createdAt: editing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  };

  const saveAndNext = async () => {
    if (!valid) return;
    if (!optionsReady()) {
      showFlash("已填选项：请点 A / B / C / D 选中正确答案，或清空选项");
      return;
    }
    const m = buildMistake();
    await addMistake(m);
    setQBlocks([newTextNode("")]);
    setABlocks([newTextNode("")]);
    // 标签和文件夹保留，方便连续录入同一章节的题；选项恢复为空白 A–D
    setOptions(["", "", "", ""]);
    setAnswer(null);
    showFlash("已保存 ✓，继续录入下一题");
  };

  const saveAndDone = async () => {
    if (!valid) return;
    if (!optionsReady()) {
      showFlash("已填选项：请点 A / B / C / D 选中正确答案，或清空选项");
      return;
    }
    if (editing) await updateMistake(buildMistake());
    else await addMistake(buildMistake());
    onDone();
  };

  // 编辑已有错题时：停止输入 900ms 后自动保存，防止忘点保存丢内容
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const target = editingRef.current;
      const opts = options.map(o => o.trim()).filter(Boolean);
      if (!target || isBlocksEmpty(qBlocks) || (opts.length > 0 && answer === null)) return;
      void updateMistake({
        ...target,
        question: qBlocks,
        analysis: aBlocks,
        tags,
        folderIds,
        options: opts,
        answer: opts.length > 0 ? answer : null,
        updatedAt: Date.now(),
      });
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qBlocks, aBlocks, tags, folderIds, options, answer, editId]);

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
  }, [qBlocks, aBlocks, tags, folderIds, options, answer, editing, valid]);

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
        <FolderSelect value={folderIds} onChange={setFolderIds} />
        <TagInput value={tags} onChange={setTags} suggestions={allTags} />
      </div>

      <BlockEditor
        label="题目"
        blocks={qBlocks}
        onChange={setQBlocks}
        placeholder="输入题目文字，或直接粘贴截图 / 拖入图片"
        autoFocus={!editing}
      />

      {/* 选择题选项（题目之后、解析之前）：默认 A–D 四个框；点 A/B/C/D 字母选出正确答案；全留空 = 非选择题 */}
      <div className="options-editor">
        <div className="page-label">
          选项
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            点 A / B / C / D 选中正确答案；全留空 = 非选择题（不计错误率）
          </span>
        </div>
        {options.map((o, i) => (
          <div key={i} className="option-row">
            <button
              type="button"
              className={`option-letter-btn ${answer === i ? "on" : ""}`}
              title={`标记 ${String.fromCharCode(65 + i)} 为正确答案`}
              onClick={() => setAnswer(i)}
            >
              {String.fromCharCode(65 + i)}
            </button>
            <input
              className="modal-input option-input"
              value={o}
              placeholder={`选项 ${String.fromCharCode(65 + i)} 内容`}
              onChange={e => setOptions(opts => opts.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className="btn btn-sm"
              title="删除该选项"
              onClick={() => {
                setOptions(opts => opts.filter((_, j) => j !== i));
                setAnswer(a => (a === i ? null : a !== null && a > i ? a - 1 : a));
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="row-actions">
          {options.length < 8 && (
            <button type="button" className="btn btn-sm" onClick={() => setOptions(opts => [...opts, ""])}>
              ＋ 添加选项
            </button>
          )}
          {options.length > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setOptions([]);
                setAnswer(null);
              }}
            >
              清空（转为非选择题）
            </button>
          )}
        </div>
      </div>

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
