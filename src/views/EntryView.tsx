import { useEffect, useRef, useState } from "react";
import type { Block, Mistake } from "../types";
import { isBlocksEmpty, newTextNode, uuid } from "../lib/utils";
import { useBook } from "../store";
import { BlockEditor } from "../components/BlockEditor";
import { TagSelect } from "../components/TagInput";
import { FolderSelect } from "../components/FolderSelect";

/** 录入记忆：勾「记住标签与文件夹」保存后，下次从任何入口录入自动带上（显式预设优先） */
const MEMORY_KEY = "errorbook.entry.memory";
type EntryMemory = { folders: string[]; tags: string[] };

function loadEntryMemory(): EntryMemory | null {
  try {
    const v = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null");
    if (!v || typeof v !== "object") return null;
    const folders = Array.isArray(v.folders) ? v.folders.filter((x: unknown): x is string => typeof x === "string") : [];
    const tags = Array.isArray(v.tags) ? v.tags.filter((x: unknown): x is string => typeof x === "string") : [];
    return { folders, tags };
  } catch {
    return null;
  }
}

export function EntryView({
  editId,
  onDone,
  onGoBatch,
  defaultFolderId = null,
  presetFolders,
  presetTags,
}: {
  editId?: string;
  onDone: () => void;
  onGoBatch: () => void;
  defaultFolderId?: string | null;
  /** 文件夹录入入口带入的预设所属 */
  presetFolders?: string[];
  /** 标签录入入口带入的预设标签 */
  presetTags?: string[];
}) {
  const { db, allTags, addMistake, updateMistake, getMistake } = useBook();
  const editing = editId ? db.mistakes.find(m => m.id === editId) : undefined;
  // 用 ref 取最新的编辑目标，避免自动保存更新 db 后触发重复保存
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const memory = loadEntryMemory();
  const [qBlocks, setQBlocks] = useState<Block[]>(() => (editing ? structuredClone(editing.question) : [newTextNode("")]));
  const [aBlocks, setABlocks] = useState<Block[]>(() => (editing ? structuredClone(editing.analysis) : [newTextNode("")]));
  // 初始标签/所属：编辑带出原值；否则显式预设（文件夹/标签录入）> 记住的值 > 浏览中文件夹（仅所属）
  const [tags, setTags] = useState<string[]>(() =>
    editing ? [...editing.tags] : presetTags?.length ? [...presetTags] : memory ? [...memory.tags] : [],
  );
  const [folderIds, setFolderIds] = useState<string[]>(() =>
    editing
      ? [...editing.folderIds]
      : presetFolders?.length
        ? [...presetFolders]
        : memory && memory.folders.length > 0
          ? [...memory.folders]
          : defaultFolderId
            ? [defaultFolderId]
            : [],
  );
  // 记住开关：默认跟随上次保存时的选择（有记忆 = 上次勾了）
  const [remember, setRemember] = useState(() => (editing ? false : memory != null));
  // 选择题选项：默认摆出 A–D 四个空框（留空保存即非选择题）；编辑已有题带出已存的选项
  const [options, setOptions] = useState<string[]>(() =>
    editing && editing.options.length > 0 ? [...editing.options] : ["", "", "", ""],
  );
  const [answer, setAnswer] = useState<number | null>(() => (editing ? editing.answer : null));
  const [flash, setFlash] = useState("");

  /** 旧数据可能带选项内容（现在的流程选项文字直接写在题目里）；有内容且未标记答案时不能保存 */
  const hasOptionContent = () => options.some(o => o.trim().length > 0);

  /** 标记了字母 = 选择题；未标记 = 非选择题（有已录内容时除外，须标记） */
  const optionsReady = () => answer !== null || !hasOptionContent();

  // 表单最新值镜像：卸载时兜底保存用
  const formRef = useRef({ qBlocks, aBlocks, tags, folderIds, options, answer, editId });
  formRef.current = { qBlocks, aBlocks, tags, folderIds, options, answer, editId };

  // 切走页面（含切到笔记 tab）时，自动保存的 900ms 间隙里没落盘的内容补一次
  useEffect(() => {
    return () => {
      const f = formRef.current;
      if (!f.editId) return; // 新题只认显式保存
      const target = getMistake(f.editId);
      const opts = f.answer !== null ? f.options.map(o => o.trim()) : [];
      if (target && !isBlocksEmpty(f.qBlocks) && (f.answer !== null || !f.options.some(o => o.trim()))) {
        void updateMistake({
          ...target,
          question: f.qBlocks,
          analysis: f.aBlocks,
          tags: f.tags,
          folderIds: f.folderIds,
          options: opts,
          answer: f.answer,
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
    // 标记了答案 = 选择题（选项字母数即选项数，内容可为空——选项文字通常直接写在题目里）；未标记 = 非选择题
    const opts = answer !== null ? options.map(o => o.trim()) : [];
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

  /** 新录时按「记住」开关落记忆：勾 = 存当前文件夹+标签；不勾 = 清掉旧记忆 */
  const persistMemory = () => {
    if (editing) return;
    if (remember) localStorage.setItem(MEMORY_KEY, JSON.stringify({ folders: folderIds, tags } satisfies EntryMemory));
    else localStorage.removeItem(MEMORY_KEY);
  };

  const saveAndNext = async () => {
    if (!valid) return;
    if (!optionsReady()) {
      showFlash("已录选项内容：请点 A / B / C / D 标记正确答案，或清除内容后保存");
      return;
    }
    const m = buildMistake();
    await addMistake(m);
    persistMemory();
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
      showFlash("已录选项内容：请点 A / B / C / D 标记正确答案，或清除内容后保存");
      return;
    }
    if (editing) await updateMistake(buildMistake());
    else {
      await addMistake(buildMistake());
      persistMemory();
    }
    onDone();
  };

  // 编辑已有错题时：停止输入 900ms 后自动保存，防止忘点保存丢内容
  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const target = editingRef.current;
      if (!target || isBlocksEmpty(qBlocks) || (hasOptionContent() && answer === null)) return;
      const opts = answer !== null ? options.map(o => o.trim()) : [];
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
        <h2>
          {editing ? "编辑错题" : "录入错题"}
          {!editing && (
            <span className="entry-mode muted">
              {presetFolders?.length ? "· 文件夹录入" : presetTags?.length ? "· 标签录入" : "· 普通录入"}
            </span>
          )}
        </h2>
        {!editing && (
          <button className="btn btn-sm" title="把整个文件夹的截图一次性导入" onClick={onGoBatch}>
            批量导入
          </button>
        )}
      </div>

      {/* 元信息工具条：所属 + 标签（同款下拉，高度一致） + 记住开关 */}
      <div className="entry-meta">
        <FolderSelect value={folderIds} onChange={setFolderIds} />
        <TagSelect value={tags} onChange={setTags} suggestions={allTags} />
        {!editing && (
          <label
            className="entry-remember"
            title="记住当前的文件夹与标签，下次从任何入口（普通/文件夹/标签）录入都自动带上；不勾则清除记忆"
          >
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            记住
          </label>
        )}
      </div>

      <BlockEditor label="题目" blocks={qBlocks} onChange={setQBlocks} autoFocus={!editing} />

      {/* 选项条：字母标记正确答案（点已选字母即取消 = 转回非选择题），＋/－ 增减字母 */}
      <div className="options-bar">
        <span className="page-label">选项</span>
        <div className="option-flow">
          {options.map((o, i) => (
            <button
              type="button"
              key={i}
              className={`option-letter-btn ${answer === i ? "on" : ""}`}
              title={
                o.trim()
                  ? `标记 ${String.fromCharCode(65 + i)}（${o.trim()}）为正确答案`
                  : `标记 ${String.fromCharCode(65 + i)} 为正确答案`
              }
              onClick={() => setAnswer(answer === i ? null : i)}
            >
              {String.fromCharCode(65 + i)}
            </button>
          ))}
        </div>
        <span className="options-acts">
          {options.length < 8 && (
            <button type="button" className="opt-act" title="添加一个选项字母" onClick={() => setOptions(opts => [...opts, ""])}>
              ＋
            </button>
          )}
          {options.length > 2 && (
            <button
              type="button"
              className="opt-act"
              title="删除最后一个选项字母"
              onClick={() => {
                setOptions(opts => opts.slice(0, -1));
                setAnswer(a => (a !== null && a >= options.length - 1 ? null : a));
              }}
            >
              －
            </button>
          )}
        </span>
      </div>
      {/* 旧数据里已录的选项内容：只读展示，保存时原样保留 */}
      {hasOptionContent() && (
        <div className="muted option-content-note">
          已录选项内容：{options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.trim()}`).join("　")}
        </div>
      )}

      <BlockEditor label="解析" blocks={aBlocks} onChange={setABlocks} />

      <div className="entry-foot">
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
