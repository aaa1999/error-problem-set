import { useState } from "react";
import { useBook } from "../store";
import { flatFolders, folderPathName } from "../lib/folders";

/** 文件夹多选：弹层复选树（缩进展示层级），value 为空数组 = 未分类 */
export function FolderSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { db } = useBook();
  const [open, setOpen] = useState(false);

  const label =
    value.length === 0
      ? "📁 未分类"
      : value.length === 1
        ? `📁 ${folderPathName(db.folders, value[0])}`
        : `📁 ${folderPathName(db.folders, value[0])} +${value.length - 1}`;

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);

  return (
    <div className="folder-select-wrap">
      <button
        type="button"
        className="folder-select-btn"
        title="选择所属文件夹，可多选"
        onClick={() => setOpen(o => !o)}
      >
        <span className="folder-select-label">{label}</span>
        <span className="folder-select-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="folder-pop">
            <button
              type="button"
              className={`folder-pop-row ${value.length === 0 ? "on" : ""}`}
              onClick={() => onChange([])}
            >
              <span className="folder-pop-check">{value.length === 0 ? "✓" : ""}</span>
              未分类
            </button>
            {flatFolders(db.folders).map(({ folder, depth }) => {
              const on = value.includes(folder.id);
              return (
                <button
                  type="button"
                  key={folder.id}
                  className={`folder-pop-row ${on ? "on" : ""}`}
                  style={{ paddingLeft: 10 + depth * 16 }}
                  title={folderPathName(db.folders, folder.id)}
                  onClick={() => toggle(folder.id)}
                >
                  <span className="folder-pop-check">{on ? "✓" : ""}</span>
                  {folder.name}
                </button>
              );
            })}
            {db.folders.length === 0 && <div className="muted folder-pop-empty">还没有文件夹，可在左侧边栏新建</div>}
            <div className="muted folder-pop-tip">一道题可同时属于多个文件夹</div>
          </div>
        </>
      )}
    </div>
  );
}

/** 单选下拉（批量导入的目标文件夹等场景用），value 为 null 表示未分类 */
export function FolderSingleSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { db } = useBook();
  return (
    <select
      className="folder-select"
      value={value ?? ""}
      title="选择目标文件夹"
      onChange={e => onChange(e.target.value || null)}
    >
      <option value="">未分类</option>
      {flatFolders(db.folders).map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {"　".repeat(depth)}
          {folder.name}
        </option>
      ))}
    </select>
  );
}
