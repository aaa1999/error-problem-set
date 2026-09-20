import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useBook } from "../store";

export function WelcomeView() {
  const { chooseDataDir } = useBook();
  const [docDir, setDocDir] = useState("");
  const [exeDataDir, setExeDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setDocDir(await join(await documentDir(), "错题本"));
      } catch {
        // 拿不到文档目录时只保留自定义选择
      }
      // Windows：默认推荐安装目录下的 data 文件夹（便携模式）。
      // macOS 的"安装目录"在 .app 包内，写入会破坏签名且更新即丢，不用此默认值。
      if (navigator.userAgent.includes("Windows")) {
        try {
          const p = await invoke<string | null>("exe_data_dir");
          if (p) setExeDataDir(p);
        } catch {
          // 命令不可用时忽略
        }
      }
    })();
  }, []);

  const go = async (dir: string) => {
    setBusy(true);
    setErr("");
    try {
      await chooseDataDir(dir);
    } catch (e) {
      setErr(`初始化失败：${String(e)}。若该位置不可写（如 Program Files），请改选其他文件夹。`);
      setBusy(false);
    }
  };

  const pick = async () => {
    const res = await openDialog({ directory: true, title: "选择错题本数据目录" });
    if (typeof res === "string" && res) await go(res);
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">📘</div>
        <h1>错题本</h1>
        <p>题目 + 解析，一页一题，离线翻页复习。</p>
        <p className="muted">
          所有数据保存在你选择的本地文件夹里（data.json + assets 图片），
          备份就是把整个文件夹拷走，也可以放进网盘实现多设备同步。
        </p>
        {exeDataDir && (
          <>
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void go(exeDataDir)}>
              使用安装目录：{exeDataDir}
            </button>
            <p className="muted install-note">
              便携模式：数据放在程序所在目录的 data 文件夹，程序文件夹整个拷走即完成备份迁移。
            </p>
          </>
        )}
        {docDir && (
          <button className={`btn btn-block ${exeDataDir ? "" : "btn-primary"}`} disabled={busy} onClick={() => void go(docDir)}>
            使用文档目录：{docDir}
          </button>
        )}
        <button className="btn btn-block" disabled={busy} onClick={() => void pick()}>
          选择其他文件夹…
        </button>
        {err && <div className="be-error">{err}</div>}
      </div>
    </div>
  );
}
