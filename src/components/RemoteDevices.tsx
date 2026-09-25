import { useMemo, useState } from "react";
import type { Folder } from "../types";
import { countInFolder, countUncategorized, groupByParent } from "../lib/folders";
import { DEVICE_SEL_PREFIX, type RemoteDevice } from "../lib/devices";

/**
 * 侧栏「远程设备」区：拉取下来的每台设备一棵只读文件夹树（设备 → 文件夹）。
 * 点击即浏览该设备的数据（BrowseView 按选择范围切换数据源），不提供任何编辑/拖放。
 */

interface Props {
  devices: RemoteDevice[];
  selected: string;
  onSelect: (s: string) => void;
}

export function RemoteDevicesSection({ devices, selected, onSelect }: Props) {
  if (devices.length === 0) return null;
  return (
    <div className="side-section">
      <div className="side-head">
        <span>远程设备（只读）</span>
      </div>
      {devices.map(d => (
        <DeviceNode key={d.id} device={d} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function DeviceNode({ device, selected, onSelect }: { device: RemoteDevice } & Pick<Props, "selected" | "onSelect">) {
  const prefix = `${DEVICE_SEL_PREFIX}${device.id}`;
  const [open, setOpen] = useState(false);
  const byParent = useMemo(() => groupByParent(device.db.folders), [device.db.folders]);
  const topLevel = byParent.get(null) ?? [];
  const expanded = selected.startsWith(`${prefix}/`) || selected === prefix;

  return (
    <div className="remote-device">
      <div
        className={`side-item device-row ${selected === prefix || expanded ? "active-parent" : ""}`}
        title={`${device.name} 推送到服务端的整库（只读浏览，不并入本机数据）`}
        onClick={() => {
          setOpen(!open || selected !== prefix);
          onSelect(prefix);
        }}
      >
        <button
          className="fold-toggle"
          onClick={e => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {topLevel.length > 0 ? (open || expanded ? "▾" : "▸") : "·"}
        </button>
        <span className="folder-name">📱 {device.name}</span>
        <span className="count">{device.db.mistakes.length}</span>
      </div>
      {(open || expanded) && (
        <div className="side-tree" style={{ paddingLeft: 14 }}>
          {topLevel.map(f => (
            <RemoteFolderNode
              key={f.id}
              folder={f}
              depth={0}
              prefix={prefix}
              mistakes={device.db.mistakes}
              folders={device.db.folders}
              byParent={byParent}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
          <div
            className={`side-item ${selected === `${prefix}/uncat` ? "active" : ""}`}
            style={{ paddingLeft: 8 }}
            title="该设备上不属于任何文件夹的题"
            onClick={() => onSelect(`${prefix}/uncat`)}
          >
            <span className="folder-name">未分类</span>
            <span className="count">{countUncategorized(device.db.mistakes, device.db.folders)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteFolderNode({
  folder,
  depth,
  prefix,
  mistakes,
  folders,
  byParent,
  selected,
  onSelect,
}: {
  folder: Folder;
  depth: number;
  prefix: string;
  mistakes: RemoteDevice["db"]["mistakes"];
  folders: Folder[];
  byParent: Map<string | null, Folder[]>;
  selected: string;
  onSelect: (s: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const children = byParent.get(folder.id) ?? [];
  const sel = `${prefix}/${folder.id}`;
  const expanded = selected.startsWith(`${sel}/`);
  const count = countInFolder(mistakes, folders, folder.id);
  if (count === 0 && children.length === 0) return null; // 空文件夹不占位

  return (
    <div>
      <div
        className={`side-item folder-row ${selected === sel ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={`${folder.name}（来自远程设备，只读）`}
        onClick={() => onSelect(sel)}
      >
        <button
          className="fold-toggle"
          onClick={e => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {children.length > 0 ? (open || expanded ? "▾" : "▸") : "·"}
        </button>
        <span className="folder-name" title={folder.name}>
          {folder.name}
        </span>
        <span className="count">{count}</span>
      </div>
      {(open || expanded) &&
        children.map(c => (
          <RemoteFolderNode
            key={c.id}
            folder={c}
            depth={depth + 1}
            prefix={prefix}
            mistakes={mistakes}
            folders={folders}
            byParent={byParent}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
