import { useRef, useState } from "react";
import { useBook } from "../store";
import {
  SyncAborted,
  clearSyncTarget,
  collectLibraryAssets,
  loadSyncTarget,
  normalizeServerAddr,
  pushToServer,
  saveSyncTarget,
  type SyncProgress,
} from "../lib/sync";

/** 顶栏「☁ 同步」打开的推送弹窗：填服务器地址（可记住）→ 增量上传图片 → 推送整份库 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const { db, dataDir } = useBook();
  const [saved] = useState(loadSyncTarget);
  const [addr, setAddr] = useState(saved?.server ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [remember, setRemember] = useState(!!saved);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState("");
  const [err, setErr] = useState("");
  const abortRef = useRef(false);

  const assetCount = collectLibraryAssets(db).size;

  const run = async () => {
    setErr("");
    setResult("");
    const server = normalizeServerAddr(addr);
    if (!server) {
      setErr("服务器地址无效。示例：192.168.1.100:8080（缺 http:// 前缀会自动补上）");
      return;
    }
    if (server !== addr.trim()) setAddr(server);
    setBusy(true);
    abortRef.current = false;
    setProgress(null);
    try {
      const r = await pushToServer(
        { server, token: token.trim() || undefined },
        db,
        dataDir,
        setProgress,
        () => abortRef.current,
      );
      if (remember) saveSyncTarget({ server, token: token.trim() });
      else clearSyncTarget();
      const parts = [`上传图片 ${r.uploadedAssets}/${r.totalAssets} 张（其余服务器已有，跳过）`];
      if (r.missingLocal > 0) parts.push(`${r.missingLocal} 张本地文件缺失已跳过`);
      setResult(`同步完成：${parts.join("，")}；${r.mistakes} 道错题、${r.notes} 篇笔记、${r.folders} 个文件夹已推送。`);
    } catch (e) {
      if (e instanceof SyncAborted) setErr(`已中止：本次已上传 ${e.uploaded} 张图片，重新同步会自动续传。`);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const pct = progress
    ? ((progress.done + (progress.phase === "data" ? 1 : 0)) / Math.max(progress.total + 1, 1)) * 100
    : 0;
  const phaseText =
    progress?.phase === "connect"
      ? "正在连接服务器、获取清单…"
      : progress?.phase === "assets"
        ? `正在上传图片 ${progress.done + 1}/${progress.total}（${progress.current?.slice(0, 16) ?? ""}…）`
        : progress?.phase === "data"
          ? "正在推送题库数据（data.json）…"
          : "";

  return (
    <div className="modal-mask" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal-card sync-card"
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <h3>☁ 同步到远程</h3>
        <label className="field-label">服务器地址（ip:端口）</label>
        <input
          className="modal-input"
          value={addr}
          placeholder="例如 192.168.1.100:8080"
          disabled={busy}
          onChange={e => setAddr(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !busy) void run();
          }}
        />
        <label className="field-label">访问令牌（可选，服务端未启用验证可留空）</label>
        <input className="modal-input" value={token} disabled={busy} onChange={e => setToken(e.target.value)} />
        <label className="modal-check">
          <input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} />
          <span>记住此地址（下次自动填入，可随时改填新的）</span>
        </label>
        <p className="muted">
          推送 {db.mistakes.length} 道错题、{db.notes.length} 篇笔记及引用的 {assetCount} 张图片；服务器已有的图片自动跳过，可随时重复同步。服务端接口说明见
          docs/sync-protocol.md。
        </p>
        {busy && (
          <div className="import-progress">
            <div className="progress-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <span className="muted">{phaseText}</span>
          </div>
        )}
        {err && <div className="be-error">{err}</div>}
        {result && <div className="sync-ok">{result}</div>}
        <div className="modal-foot">
          {busy ? (
            <button className="btn" onClick={() => (abortRef.current = true)}>
              中止
            </button>
          ) : result ? (
            <>
              <button className="btn" onClick={onClose}>
                完成
              </button>
              <button className="btn btn-primary" onClick={() => void run()}>
                再次同步
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!addr.trim()} onClick={() => void run()}>
                开始同步
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
