import { useEffect, useState } from "react";
import { documentDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useBook } from "../store";

export function WelcomeView() {
  const { chooseDataDir } = useBook();
  const [defaultDir, setDefaultDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setDefaultDir(await join(await documentDir(), "错题本"));
      } catch {
        setDefaultDir("");
      }
    })();
  }, []);

  const go = async (dir: string) => {
    setBusy(true);
    setErr("");
    try {
      await chooseDataDir(dir);
    } catch (e) {
      setErr(`初始化失败：${String(e)}`);
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
        {defaultDir && (
          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void go(defaultDir)}>
            使用默认目录：{defaultDir}
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
