import { useRef, useState } from "react";
import { useBook } from "../store";
import { flatFolders, folderPathName } from "../lib/folders";

/** 文件夹多选：弹层复选树（缩进展示层级），value 为空数组 = 未分类；弹层里可输入名称直接新建并勾选 */
export function FolderSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { db, findOrCreateFolderPath } = useBook();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // 弹层快溢出窗口右缘时改为右对齐展开
  const [popRight, setPopRight] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const toggleOpen = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPopRight(r.left + 330 > window.innerWidth);
    setOpen(o => !o);
  };

  const label =
    value.length === 0
      ? "未分类"
      : value.length === 1
        ? folderPathName(db.folders, value[0])
        : `${folderPathName(db.folders, value[0])} +${value.length - 1}`;

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);

  // 新建并勾选：名称支持 a/b/c 层级，从根逐级创建（已存在的层级复用），勾选最深层级
  const createAndSelect = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    try {
      const f = await findOrCreateFolderPath(name, null);
      if (!value.includes(f.id)) onChange([...value, f.id]);
    } catch {
      /* 只输入了 / ：忽略 */
    }
  };

  return (
    <div className="folder-select-wrap">
      <button
        ref={btnRef}
        type="button"
        className="folder-select-btn"
        title="选择所属文件夹，可多选"
        onClick={toggleOpen}
      >
        <span className="folder-select-label">{label}</span>
        <span className="folder-select-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className={`folder-pop ${popRight ? "pop-right" : ""}`}>
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
            {db.folders.length === 0 && <div className="muted folder-pop-empty">还没有文件夹，在下面输入名称新建</div>}
            <div className="folder-pop-create">
              <input
                className="modal-input"
                value={draft}
                placeholder="名称，可用 / 分层（如 数学/三角函数）"
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createAndSelect();
                  }
                }}
              />
              <button type="button" className="btn btn-sm" disabled={!draft.trim()} onClick={() => void createAndSelect()}>
                新建
              </button>
            </div>
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
