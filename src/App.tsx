import { useState } from "react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { shortDir } from "./lib/utils";
import { useBook } from "./store";
import { BrowseView } from "./views/BrowseView";
import { EntryView } from "./views/EntryView";
import { BatchImportView } from "./views/BatchImportView";
import { WelcomeView } from "./views/WelcomeView";
import { NotesView } from "./views/NotesView";

/** 错题本内部的二级视图 */
type View = { name: "browse" } | { name: "entry"; editId?: string } | { name: "batch" };
/** 顶部一级导航 */
type TopMode = "book" | "notes";

export default function App() {
  const { status, dataDir, db, chooseDataDir } = useBook();
  const [top, setTop] = useState<TopMode>("book");
  const [view, setView] = useState<View>({ name: "browse" });
  // 浏览页当前选中的文件夹："" 全部 | "uncat" 未分类 | 文件夹 id；也作为录入/批量导入的默认文件夹
  const [folderSel, setFolderSel] = useState<string>("");
  const defaultFolderId = folderSel !== "" && folderSel !== "uncat" ? folderSel : null;

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
            📘 错题本
          </button>
          <button className={`tab tab-main ${top === "notes" ? "active" : ""}`} onClick={() => setTop("notes")}>
            📝 笔记
          </button>
        </nav>
        {top === "book" && (
          <nav className="tabs">
            <button className={`tab ${view.name === "browse" ? "active" : ""}`} onClick={() => setView({ name: "browse" })}>
              浏览
            </button>
            <button className={`tab ${view.name === "entry" ? "active" : ""}`} onClick={() => setView({ name: "entry" })}>
              录入
            </button>
            <button className={`tab ${view.name === "batch" ? "active" : ""}`} onClick={() => setView({ name: "batch" })}>
              批量导入
            </button>
          </nav>
        )}
        <div className="topbar-right">
          <span className="muted" title={dataDir}>
            {shortDir(dataDir)} · {db.mistakes.length} 题
          </span>
          <button className="btn btn-sm" onClick={() => void changeDir()}>
            更换目录
          </button>
        </div>
      </header>

      <main className="main">
        {top === "notes" ? (
          <NotesView />
        ) : (
          <>
            {view.name === "browse" && (
              <BrowseView
                onEdit={id => setView({ name: "entry", editId: id })}
                onNew={() => setView({ name: "entry" })}
                selected={folderSel}
                onSelect={setFolderSel}
              />
            )}
            {view.name === "entry" && (
              <EntryView
                key={view.editId ?? "new"}
                editId={view.editId}
                onDone={() => setView({ name: "browse" })}
                onGoBatch={() => setView({ name: "batch" })}
                defaultFolderId={defaultFolderId}
              />
            )}
            {view.name === "batch" && (
              <BatchImportView onDone={() => setView({ name: "browse" })} defaultFolderId={defaultFolderId} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
