import { useMemo, useState, type DragEvent } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Folder, Mistake } from "../types";
import { countCategorized, countInFolder, countUncategorized, descendantSet, groupByParent } from "../lib/folders";
import { DND_FOLDER, DND_MISTAKE } from "../lib/dnd";
import { useBook } from "../store";
import { NameModal } from "./NameModal";

interface Props {
  selected: string; // "" 全部 | "uncat" 未分类 | 文件夹 id
  onSelect: (s: string) => void;
  activeTags: string[];
  onToggleTag: (t: string) => void;
  onClearTags: () => void;
  tagMode: "and" | "or";
  onToggleTagMode: () => void;
  /** 当前文件夹范围内的错题，用于标签的范围内计数 */
  mistakesInFolder: Mistake[];
  /** 满足当前标签筛选的错题，用于文件夹计数随标签联动 */
  mistakesMatchingTags: Mistake[];
  /** 文件夹行上的 ✍：以该文件夹为预设所属进入录入（文件夹录入入口） */
  onNewInFolder: (folderId: string) => void;
  /** 标签行上的 ✍：以该标签为预设标签进入录入（标签录入入口） */
  onNewWithTag: (tag: string) => void;
}

export function Sidebar({
  selected,
  onSelect,
  activeTags,
  onToggleTag,
  onClearTags,
  tagMode,
  onToggleTagMode,
  mistakesInFolder,
  mistakesMatchingTags,
  onNewInFolder,
  onNewWithTag,
}: Props) {
  const { db, allTags, findOrCreateFolderPath, renameFolder, moveFolder, deleteFolder, createTag, getMistake, setMistakeFolders } =
    useBook();
  const [modal, setModal] = useState<
    { title: string; initial: string; placeholder?: string; onOk: (name: string) => void } | null
  >(null);
  // 拖动中的文件夹 id：dragover 阶段读不到负载数据，只能靠它把「自己/自己的后代」排除出可落目标
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [rootHover, setRootHover] = useState<"all" | "cat" | "uncat" | null>(null);
  const byParent = groupByParent(db.folders);

  // 标签计数限定在当前文件夹范围内，点选后数量对得上
  const tagCountsInView = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of mistakesInFolder) for (const t of x.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [mistakesInFolder]);

  // 名称支持 a/b/c：在 parent 下按层级逐级创建（顶层新建 = 从根开始）
  const askNewFolder = (parentId: string | null) =>
    setModal({
      title: parentId ? "新建子文件夹" : "新建文件夹",
      initial: "",
      placeholder: "名称，可用 / 分层（如 数学/三角函数）",
      onOk: name => {
        void findOrCreateFolderPath(name, parentId)
          .then(f => onSelect(f.id))
          .catch(() => {}); // 只输入了 / 的极端情况：静默忽略
      },
    });

  const askRename = (f: Folder) =>
    setModal({ title: "重命名文件夹", initial: f.name, onOk: name => void renameFolder(f.id, name) });

  // 预建标签：不挂在错题上也保留，方便提前规划标签体系；已存在（错题已带/已预建）时静默跳过
  const askNewTag = () =>
    setModal({ title: "新建标签", initial: "", placeholder: "标签名称", onOk: name => void createTag(name) });

  const askDelete = async (f: Folder) => {
    const ok = await ask(
      `删除文件夹「${f.name}」？\n其中的错题只是移出该文件夹（其他所属文件夹保留，全部移空的进「未分类」），子文件夹上移一级。`,
      { title: "删除文件夹" },
    );
    if (!ok) return;
    await deleteFolder(f.id);
    if (selected === f.id) onSelect("");
  };

  // ---------- 拖放：错题 ↔ 文件夹归类、文件夹 ↔ 重挂父级 ----------

  /** 错题落到文件夹上：默认移动（替换所属）；按住 ⌥/Ctrl 落下 = 追加所属（多文件夹） */
  const dropMistakeOn = (e: DragEvent, folderId: string | null) => {
    const id = e.dataTransfer.getData(DND_MISTAKE);
    if (!id) return false;
    e.preventDefault();
    e.stopPropagation();
    if (folderId === null) {
      void setMistakeFolders(id, []); // 「未分类」= 清空所属
    } else if (e.altKey || e.ctrlKey || e.metaKey) {
      const ids = getMistake(id)?.folderIds ?? [];
      if (!ids.includes(folderId)) void setMistakeFolders(id, [...ids, folderId]);
    } else {
      void setMistakeFolders(id, [folderId]);
    }
    return true;
  };

  /** 文件夹落到目标上重挂父级（parentId 为 null = 移到顶层，即落在「全部错题」上） */
  const dropFolderOn = (e: DragEvent, parentId: string | null) => {
    const fid = e.dataTransfer.getData(DND_FOLDER);
    if (!fid) return false;
    e.preventDefault();
    e.stopPropagation();
    void moveFolder(fid, parentId);
    return true;
  };

  const hasPayload = (e: DragEvent, ...types: string[]) => types.some(t => e.dataTransfer.types.includes(t));

  // 全部错题 = 树根：下分「已分类」（收着整个文件夹树）与「未分类」，均可折叠
  const [rootOpen, setRootOpen] = useState(true);
  const [catOpen, setCatOpen] = useState(true);
  const topLevel = byParent.get(null) ?? [];

  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-head">
          <span>文件夹</span>
          <button onClick={() => askNewFolder(null)}>＋ 新建</button>
        </div>
        <div
          className={`side-item ${selected === "" ? "active" : ""} ${rootHover === "all" ? "drop-target" : ""}`}
          title="全部错题；拖文件夹到此处 = 移到顶层（作为它的直接子级）"
          onClick={() => onSelect("")}
          onDragOver={e => {
            if (hasPayload(e, DND_FOLDER)) {
              e.preventDefault();
              setRootHover("all");
            }
          }}
          onDragLeave={() => setRootHover(h => (h === "all" ? null : h))}
          onDrop={e => {
            setRootHover(null);
            dropFolderOn(e, null);
          }}
        >
          <button
            className="fold-toggle"
            title={rootOpen ? "收起" : "展开"}
            onClick={e => {
              e.stopPropagation();
              setRootOpen(!rootOpen);
            }}
          >
            {topLevel.length > 0 ? (rootOpen ? "▾" : "▸") : "·"}
          </button>
          <span className="folder-name">全部错题</span>
          <span className="count">{mistakesMatchingTags.length}</span>
        </div>
        {(rootOpen || topLevel.length === 0) && (
          <>
            {/* 已分类：至少属于一个文件夹的题；文件夹树都收在它下面 */}
            <div
              className={`side-item ${selected === "cat" ? "active" : ""} ${rootHover === "cat" ? "drop-target" : ""}`}
              style={{ paddingLeft: 22 }}
              title="已分类：至少属于一个文件夹的题；拖文件夹到此处 = 移到顶层"
              onClick={() => onSelect("cat")}
              onDragOver={e => {
                if (hasPayload(e, DND_FOLDER)) {
                  e.preventDefault();
                  setRootHover("cat");
                }
              }}
              onDragLeave={() => setRootHover(h => (h === "cat" ? null : h))}
              onDrop={e => {
                setRootHover(null);
                dropFolderOn(e, null);
              }}
            >
              <button
                className="fold-toggle"
                title={catOpen ? "收起" : "展开"}
                onClick={e => {
                  e.stopPropagation();
                  setCatOpen(!catOpen);
                }}
              >
                {topLevel.length > 0 ? (catOpen ? "▾" : "▸") : "·"}
              </button>
              <span className="folder-name">已分类</span>
              <span className="count">{countCategorized(mistakesMatchingTags, db.folders)}</span>
            </div>
            {(catOpen || topLevel.length === 0) && (
              <div className="side-tree" style={{ paddingLeft: 36 }}>
                {topLevel.map(f => (
                  <FolderNode
                    key={f.id}
                    folder={f}
                    depth={0}
                    selected={selected}
                    onSelect={onSelect}
                    onNewSub={askNewFolder}
                    onNewIn={onNewInFolder}
                    onRename={askRename}
                    onDelete={f2 => void askDelete(f2)}
                    mistakes={mistakesMatchingTags}
                    folders={db.folders}
                    byParent={byParent}
                    draggingFolderId={draggingFolderId}
                    setDraggingFolderId={setDraggingFolderId}
                    dropMistakeOn={dropMistakeOn}
                    dropFolderOn={dropFolderOn}
                  />
                ))}
              </div>
            )}
            <button
              className={`side-item side-uncat ${selected === "uncat" ? "active" : ""} ${rootHover === "uncat" ? "drop-target" : ""}`}
              style={{ paddingLeft: 22 }}
              title="拖错题到此处 = 移出所有文件夹（未分类）"
              onClick={() => onSelect("uncat")}
              onDragOver={e => {
                if (hasPayload(e, DND_MISTAKE)) {
                  e.preventDefault();
                  setRootHover("uncat");
                }
              }}
              onDragLeave={() => setRootHover(h => (h === "uncat" ? null : h))}
              onDrop={e => {
                setRootHover(null);
                dropMistakeOn(e, null);
              }}
            >
              <span className="folder-name">未分类</span>
              <span className="count">{countUncategorized(mistakesMatchingTags, db.folders)}</span>
            </button>
          </>
        )}
      </div>

      <div className="side-section">
        <div className="side-head">
          <span>标签{activeTags.length > 0 ? `（${activeTags.length}）` : ""}</span>
          <span className="side-head-acts">
            <button title="新建标签（可先建好再给错题打）" onClick={askNewTag}>
              ＋ 新建
            </button>
            {activeTags.length >= 2 && (
              <button
                title="切换多标签匹配方式：交集（同时满足）/ 并集（任一满足）"
                onClick={onToggleTagMode}
              >
                {tagMode === "and" ? "同时满足" : "任一满足"}
              </button>
            )}
            {activeTags.length > 0 && <button onClick={onClearTags}>清除</button>}
          </span>
        </div>
        {allTags.length === 0 && <div className="muted side-pad">还没有标签，点「＋ 新建」预建，或在录入页给错题打标签</div>}
        {allTags.map(t => {
          const n = tagCountsInView.get(t) ?? 0;
          return (
            <div
              key={t}
              className={`side-tag ${activeTags.includes(t) ? "active" : ""} ${n === 0 ? "dim" : ""}`}
              title={n === 0 ? "当前文件夹范围内没有带此标签的题" : `${n} 题；✍ = 录入一道带此标签的题`}
              onClick={() => onToggleTag(t)}
            >
              <span className="folder-name">{t}</span>
              <span className="count">{n}</span>
              <span className="folder-acts" onClick={e => e.stopPropagation()}>
                <button title="录入一道带此标签的题（标签录入）" onClick={() => onNewWithTag(t)}>
                  ✍
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {modal && (
        <NameModal
          title={modal.title}
          initial={modal.initial}
          placeholder={modal.placeholder}
          onOk={name => {
            modal.onOk(name);
            setModal(null);
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </aside>
  );
}

interface NodeProps {
  folder: Folder;
  depth: number;
  selected: string;
  onSelect: (s: string) => void;
  onNewSub: (parentId: string) => void;
  onNewIn: (folderId: string) => void;
  onRename: (f: Folder) => void;
  onDelete: (f: Folder) => void;
  mistakes: Mistake[];
  folders: Folder[];
  byParent: Map<string | null, Folder[]>;
  draggingFolderId: string | null;
  setDraggingFolderId: (id: string | null) => void;
  dropMistakeOn: (e: DragEvent, folderId: string | null) => boolean;
  dropFolderOn: (e: DragEvent, parentId: string | null) => boolean;
}

function FolderNode({
  folder,
  depth,
  selected,
  onSelect,
  onNewSub,
  onNewIn,
  onRename,
  onDelete,
  mistakes,
  folders,
  byParent,
  draggingFolderId,
  setDraggingFolderId,
  dropMistakeOn,
  dropFolderOn,
}: NodeProps) {
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState(false);
  const children = byParent.get(folder.id) ?? [];

  // 文件夹拖动落点合法性：不能是自己或自己的后代（防环）
  const folderDropOk =
    !!draggingFolderId && draggingFolderId !== folder.id && !descendantSet(folders, draggingFolderId).has(folder.id);

  const dragOver = (e: DragEvent) => {
    const ok =
      e.dataTransfer.types.includes(DND_MISTAKE) ||
      (e.dataTransfer.types.includes(DND_FOLDER) && folderDropOk);
    if (!ok) return;
    e.preventDefault(); // 允许落下
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setHover(true);
  };

  return (
    <div>
      <div
        className={`side-item folder-row ${selected === folder.id ? "active" : ""} ${hover ? "drop-target" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title="拖错题到此归类（按住 ⌥ 追加所属）；拖到别的文件夹上调整层级"
        onClick={() => onSelect(folder.id)}
        draggable
        onDragStart={e => {
          e.dataTransfer.setData(DND_FOLDER, folder.id);
          e.dataTransfer.effectAllowed = "move";
          setDraggingFolderId(folder.id);
        }}
        onDragEnd={() => setDraggingFolderId(null)}
        onDragOver={dragOver}
        onDragLeave={() => setHover(false)}
        onDrop={e => {
          setHover(false);
          if (!dropMistakeOn(e, folder.id)) dropFolderOn(e, folder.id);
          setDraggingFolderId(null);
        }}
      >
        <button
          className="fold-toggle"
          onClick={e => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {children.length > 0 ? (open ? "▾" : "▸") : "·"}
        </button>
        <span className="folder-name" title={folder.name}>
          {folder.name}
        </span>
        <span className="count">{countInFolder(mistakes, folders, folder.id)}</span>
        <span className="folder-acts" onClick={e => e.stopPropagation()}>
          <button title="录入一道题到此文件夹（文件夹录入）" onClick={() => onNewIn(folder.id)}>
            ✍
          </button>
          <button title="新建子文件夹" onClick={() => onNewSub(folder.id)}>
            ＋
          </button>
          <button title="重命名" onClick={() => onRename(folder)}>
            ✎
          </button>
          <button title="删除" onClick={() => onDelete(folder)}>
            🗑
          </button>
        </span>
      </div>
      {open &&
        children.map(c => (
          <FolderNode
            key={c.id}
            folder={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
            onNewSub={onNewSub}
            onNewIn={onNewIn}
            onRename={onRename}
            onDelete={onDelete}
            mistakes={mistakes}
            folders={folders}
            byParent={byParent}
            draggingFolderId={draggingFolderId}
            setDraggingFolderId={setDraggingFolderId}
            dropMistakeOn={dropMistakeOn}
            dropFolderOn={dropFolderOn}
          />
        ))}
    </div>
  );
}
