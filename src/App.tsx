import { useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { shortDir } from "./lib/utils";
import { useBook } from "./store";
import { BrowseView } from "./views/BrowseView";
import { EntryView } from "./views/EntryView";
import { BatchImportView } from "./views/BatchImportView";
import { WelcomeView } from "./views/WelcomeView";
import { NotesView } from "./views/NotesView";
import { PracticeView, type PracticeSession } from "./views/PracticeView";
import { SyncDialog } from "./components/SyncDialog";
import { FolderSelect } from "./components/FolderSelect";
import { TagInput } from "./components/TagInput";

/** 错题本内部的二级视图；录入可带预设（文件夹录入 / 标签录入） */
type View =
  | { name: "browse" }
  | { name: "entry"; editId?: string; presetFolders?: string[]; presetTags?: string[] }
  | { name: "batch" };
/** 顶部一级导航 */
type TopMode = "book" | "notes" | "practice";

export default function App() {
  const { status, dataDir, db, allTags, chooseDataDir, remoteDevices } = useBook();
  const [top, setTop] = useState<TopMode>("book");
  const [view, setView] = useState<View>({ name: "browse" });
  // 浏览页当前选中的范围："" 全部 | "cat" 已分类 | "uncat" 未分类 | 文件夹 id | "device:<id>[/子范围]" 远程设备（只读浏览）
  const [folderSel, setFolderSel] = useState<string>("");
  const defaultFolderId =
    folderSel !== "" && folderSel !== "cat" && folderSel !== "uncat" && !folderSel.startsWith("device:") ? folderSel : null;
  const [syncOpen, setSyncOpen] = useState(false);
  // 做题会话提升到 App 层：切 tab 不丢答题进度
  const [practice, setPractice] = useState<PracticeSession | null>(null);
  // 录入入口菜单 + 文件夹/标签录入的目标选择
  const [entryMenuOpen, setEntryMenuOpen] = useState(false);
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  const [folderPickSel, setFolderPickSel] = useState<string[]>([]);
  const [tagPickOpen, setTagPickOpen] = useState(false);
  const [tagPickSel, setTagPickSel] = useState<string[]>([]);

  if (status === "welcome") return <WelcomeView />;
  if (status !== "ready") {
    return (
      <div className="loading">
        <span className="muted">加载中…</span>
      </div>
    );
  }

  const changeDir = async () => {
    const ok = await ask("更换数据目录会切换到另一份数据（当前数据不会被删除），继续？", { title: "更换数据目录" });
    if (!ok) return;
    const res = await openDialog({ directory: true, title: "选择新的数据目录" });
    if (typeof res === "string" && res) {
      await chooseDataDir(res);
      setView({ name: "browse" });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <nav className="tabs tabs-main">
          <button className={`tab tab-main ${top === "book" ? "active" : ""}`} onClick={() => setTop("book")}>
            错题本
          </button>
          <button className={`tab tab-main ${top === "notes" ? "active" : ""}`} onClick={() => setTop("notes")}>
            笔记
          </button>
          <button className={`tab tab-main ${top === "practice" ? "active" : ""}`} onClick={() => setTop("practice")}>
            做题
          </button>
        </nav>
        {top === "book" && (
          <nav className="tabs">
            <button className={`tab ${view.name === "browse" ? "active" : ""}`} onClick={() => setView({ name: "browse" })}>
              浏览
            </button>
            {/* 录入三入口：主按钮 = 普通录入；▾ = 文件夹录入 / 标签录入 */}
            <span className={`tab-split ${view.name === "entry" ? "active" : ""}`}>
              <button className="tab-part-main" onClick={() => setView({ name: "entry" })}>
                录入
              </button>
              <button
                className="tab-part-caret"
                title="选择录入方式：普通 / 文件夹 / 标签"
                onClick={() => setEntryMenuOpen(o => !o)}
              >
                ▾
              </button>
              {entryMenuOpen && (
                <>
                  <div className="popover-backdrop" onClick={() => setEntryMenuOpen(false)} />
                  <div className="entry-menu">
                    <button
                      onClick={() => {
                        setEntryMenuOpen(false);
                        setView({ name: "entry" });
                      }}
                    >
                      普通录入
                    </button>
                    <button
                      onClick={() => {
                        setEntryMenuOpen(false);
                        setFolderPickSel([]);
                        setFolderPickOpen(true);
                      }}
                    >
                      文件夹录入
                    </button>
                    <button
                      onClick={() => {
                        setEntryMenuOpen(false);
                        setTagPickSel([]);
                        setTagPickOpen(true);
                      }}
                    >
                      标签录入
                    </button>
                  </div>
                </>
              )}
            </span>
            <button className={`tab ${view.name === "batch" ? "active" : ""}`} onClick={() => setView({ name: "batch" })}>
              批量导入
            </button>
          </nav>
        )}
        <div className="topbar-right">
          <span className="muted" title={dataDir}>
            {shortDir(dataDir)} · {db.mistakes.length} 题 · {db.notes.length} 笔记
            {remoteDevices.length > 0 &&
              ` · 📱${remoteDevices.length} 台远程设备（侧栏只读浏览）`}
          </span>
          <button className="btn btn-sm" onClick={() => setSyncOpen(true)}>
            同步
          </button>
          <button className="btn btn-sm" onClick={() => void changeDir()}>
            更换目录
          </button>
        </div>
      </header>

      <main className="main">
        {top === "notes" ? (
          <NotesView />
        ) : top === "practice" ? (
          <PracticeView session={practice} setSession={setPractice} />
        ) : (
          <>
            {view.name === "browse" && (
              <BrowseView
                onEdit={id => setView({ name: "entry", editId: id })}
                onNew={() => setView({ name: "entry" })}
                onNewInFolder={folderId => setView({ name: "entry", presetFolders: [folderId] })}
                onNewWithTag={tag => setView({ name: "entry", presetTags: [tag] })}
                selected={folderSel}
                onSelect={setFolderSel}
              />
            )}
            {view.name === "entry" && (
              <EntryView
                key={`${view.editId ?? "new"}|${(view.presetFolders ?? []).join(",")}|${(view.presetTags ?? []).join(",")}`}
                editId={view.editId}
                onDone={() => setView({ name: "browse" })}
                onGoBatch={() => setView({ name: "batch" })}
                defaultFolderId={defaultFolderId}
                presetFolders={view.presetFolders}
                presetTags={view.presetTags}
              />
            )}
            {view.name === "batch" && (
              <BatchImportView onDone={() => setView({ name: "browse" })} defaultFolderId={defaultFolderId} />
            )}
          </>
        )}
      </main>

      {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}

      {/* 文件夹录入：先选目标文件夹（可多选），再进录入页；进去后仍可调整、加标签 */}
      {folderPickOpen && (
        <div className="modal-mask" onMouseDown={() => setFolderPickOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <h3>文件夹录入：选择文件夹</h3>
            <FolderSelect value={folderPickSel} onChange={setFolderPickSel} />
            <div className="modal-foot">
              <button className="btn" onClick={() => setFolderPickOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={folderPickSel.length === 0}
                onClick={() => {
                  setFolderPickOpen(false);
                  setView({ name: "entry", presetFolders: [...folderPickSel] });
                }}
              >
                开始录入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 标签录入：先选标签（可从已有标签挑或新建），再进录入页 */}
      {tagPickOpen && (
        <div className="modal-mask" onMouseDown={() => setTagPickOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <h3>标签录入：选择标签</h3>
            <TagInput value={tagPickSel} onChange={setTagPickSel} suggestions={allTags} />
            <div className="modal-foot">
              <button className="btn" onClick={() => setTagPickOpen(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={tagPickSel.length === 0}
                onClick={() => {
                  setTagPickOpen(false);
                  setView({ name: "entry", presetTags: [...tagPickSel] });
                }}
              >
                开始录入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
