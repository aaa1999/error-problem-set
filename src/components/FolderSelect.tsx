import { useBook } from "../store";
import { flatFolders } from "../lib/folders";

/** 文件树下拉选择（缩进展示层级），value 为 null 表示未分类 */
export function FolderSelect({
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
      title="选择所属文件夹"
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
