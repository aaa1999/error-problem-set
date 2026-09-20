import { useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Folder, Mistake } from "../types";
import { countInFolder, countUncategorized, groupByParent } from "../lib/folders";
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
}: Props) {
  const { db, allTags, createFolder, renameFolder, deleteFolder } = useBook();
  const [modal, setModal] = useState<{ title: string; initial: string; onOk: (name: string) => void } | null>(null);
  const byParent = groupByParent(db.folders);

  // 标签计数限定在当前文件夹范围内，点选后数量对得上
  const tagCountsInView = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of mistakesInFolder) for (const t of x.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [mistakesInFolder]);

  const askNewFolder = (parentId: string | null) =>
    setModal({
      title: parentId ? "新建子文件夹" : "新建文件夹",
      initial: "",
      onOk: name => {
        void createFolder(name, parentId).then(f => onSelect(f.id));
      },
    });

  const askRename = (f: Folder) =>
    setModal({ title: "重命名文件夹", initial: f.name, onOk: name => void renameFolder(f.id, name) });

  const askDelete = async (f: Folder) => {
    const ok = await ask(
      `删除文件夹「${f.name}」？\n其中的错题会移到「未分类」，子文件夹会上移一级。`,
      { title: "删除文件夹" },
    );
    if (!ok) return;
    await deleteFolder(f.id);
    if (selected === f.id) onSelect("");
  };

  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-head">
          <span>文件夹</span>
          <button onClick={() => askNewFolder(null)}>＋ 新建</button>
        </div>
        <button className={`side-item ${selected === "" ? "active" : ""}`} onClick={() => onSelect("")}>
          <span className="folder-name">全部错题</span>
          <span className="count">{mistakesMatchingTags.length}</span>
        </button>
        <button className={`side-item ${selected === "uncat" ? "active" : ""}`} onClick={() => onSelect("uncat")}>
          <span className="folder-name">未分类</span>
          <span className="count">{countUncategorized(mistakesMatchingTags, db.folders)}</span>
        </button>
        <div className="side-tree">
          {(byParent.get(null) ?? []).map(f => (
            <FolderNode
              key={f.id}
              folder={f}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onNewSub={askNewFolder}
              onRename={askRename}
              onDelete={f2 => void askDelete(f2)}
              mistakes={mistakesMatchingTags}
              folders={db.folders}
              byParent={byParent}
            />
          ))}
        </div>
      </div>

      <div className="side-section">
        <div className="side-head">
          <span>标签{activeTags.length > 0 ? `（${activeTags.length}）` : ""}</span>
          <span className="side-head-acts">
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
        {allTags.length === 0 && <div className="muted side-pad">还没有标签，在录入页给错题打标签</div>}
        {allTags.map(t => {
          const n = tagCountsInView.get(t) ?? 0;
          return (
            <button
              key={t}
              className={`side-tag ${activeTags.includes(t) ? "active" : ""} ${n === 0 ? "dim" : ""}`}
              title={n === 0 ? "当前文件夹范围内没有带此标签的题" : `${n} 题`}
              onClick={() => onToggleTag(t)}
            >
              <span className="folder-name">{t}</span>
              <span className="count">{n}</span>
            </button>
          );
        })}
        {allTags.length > 0 && (
          <div className="muted side-pad">
            {activeTags.length === 0
              ? "点击筛选，可多选，并与文件夹筛选叠加"
              : tagMode === "and"
                ? "显示同时包含所有所选标签的题"
                : "显示包含任一所选标签的题"}
            ，文件夹与标签同时生效
          </div>
        )}
      </div>

      {modal && (
        <NameModal
          title={modal.title}
          initial={modal.initial}
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
  onRename: (f: Folder) => void;
  onDelete: (f: Folder) => void;
  mistakes: Mistake[];
  folders: Folder[];
  byParent: Map<string | null, Folder[]>;
}

function FolderNode({
  folder,
  depth,
  selected,
  onSelect,
  onNewSub,
  onRename,
  onDelete,
  mistakes,
  folders,
  byParent,
}: NodeProps) {
  const [open, setOpen] = useState(true);
  const children = byParent.get(folder.id) ?? [];

  return (
    <div>
      <div
        className={`side-item folder-row ${selected === folder.id ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(folder.id)}
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
            onRename={onRename}
            onDelete={onDelete}
            mistakes={mistakes}
            folders={folders}
            byParent={byParent}
          />
        ))}
    </div>
  );
}
