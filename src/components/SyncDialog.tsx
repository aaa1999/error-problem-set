import { useRef, useState } from "react";
import { useBook } from "../store";
import {
  SyncAborted,
  clearSyncTarget,
  collectLibraryAssets,
  loadSyncTarget,
  normalizeServerAddr,
  pullAllDevices,
  pushToServer,
  saveSyncTarget,
  type PullProgress,
  type SyncProgress,
} from "../lib/sync";

type Mode = "push" | "pull";

/** 顶栏「☁ 同步」弹窗：推送整库到本设备在服务端的槽位 / 按设备拉取全部设备数据（不合并），两边都幂等可重入 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const { db, dataDir, remoteDevices, refreshRemoteDevices } = useBook();
  const [mode, setMode] = useState<Mode>("push");
  const [saved] = useState(loadSyncTarget);
  const [addr, setAddr] = useState(saved?.server ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [remember, setRemember] = useState(!!saved);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | PullProgress | null>(null);
  const [result, setResult] = useState("");
  const [err, setErr] = useState("");
  const abortRef = useRef(false);

  const assetCount = collectLibraryAssets(db).size;

  const resolveServer = () => {
    const server = normalizeServerAddr(addr);
    if (!server) {
      setErr("服务器地址无效。示例：192.168.1.100:8080（缺 http:// 前缀会自动补上）");
      return null;
    }
    if (server !== addr.trim()) setAddr(server);
    return server;
  };

  const rememberTarget = (server: string) => {
    if (remember) saveSyncTarget({ server, token: token.trim() });
    else clearSyncTarget();
  };

  // ---------- 推送 ----------

  const runPush = async () => {
    setErr("");
    setResult("");
    const server = resolveServer();
    if (!server) return;
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
      rememberTarget(server);
      const parts = [`上传图片 ${r.uploadedAssets}/${r.totalAssets} 张（其余服务器已有，跳过）`];
      if (r.missingLocal > 0) parts.push(`${r.missingLocal} 张本地文件缺失已跳过`);
      setResult(`同步完成：${parts.join("，")}；${r.mistakes} 道错题、${r.notes} 篇笔记、${r.folders} 个文件夹已推送到本设备的版本。`);
    } catch (e) {
      if (e instanceof SyncAborted) setErr(`已中止：本次已上传 ${e.uploaded} 张图片，重新同步会自动续传。`);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // ---------- 拉取（按设备，不合并） ----------

  const runPull = async () => {
    setErr("");
    setResult("");
    const server = resolveServer();
    if (!server) return;
    setBusy(true);
    abortRef.current = false;
    setProgress({ phase: "connect", done: 0, total: 0 });
    try {
      const r = await pullAllDevices(
        { server, token: token.trim() || undefined },
        dataDir,
        setProgress,
        () => abortRef.current,
      );
      rememberTarget(server);
      await refreshRemoteDevices();
      if (r.onlySelf) {
        setResult("服务器上还没有其他设备的数据（本机自己的推送不会重复拉取）。");
      } else {
        const parts = r.pulled.map(d => `${d.name}（${d.mistakes} 题 / ${d.notes} 笔记）`);
        const extras: string[] = [];
        if (r.downloadedAssets > 0) extras.push(`下载图片 ${r.downloadedAssets} 张`);
        if (r.missingAssets > 0) extras.push(`${r.missingAssets} 张图片服务端缺失已跳过`);
        setResult(
          `拉取完成：${r.pulled.length} 台设备已更新到本地（${parts.join("、")}）${extras.length > 0 ? `，${extras.join("，")}` : ""}。` +
            `在侧栏「远程设备」里按 设备 → 文件夹 浏览；本机数据未做任何改动。`,
        );
      }
    } catch (e) {
      if (e instanceof SyncAborted) setErr(`已中止：重新拉取会自动续上（已下载的保留）。`);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const switchMode = (m: Mode) => {
    if (busy) return;
    setMode(m);
    setErr("");
    setResult("");
    setProgress(null);
  };

  // ---------- 进度条与文案 ----------

  const pct = progress
    ? ((progress.done + (progress.phase === "data" || progress.phase === "done" ? 1 : 0)) /
        Math.max(progress.total + 1, 1)) *
      100
    : 0;
  const phaseText = progress
    ? progress.phase === "connect"
      ? mode === "push"
        ? "正在连接服务器、获取清单…"
        : "正在连接服务器、获取设备清单…"
      : progress.phase === "devices"
        ? `正在拉取设备数据 ${Math.min(progress.done + 1, progress.total)}/${progress.total}（${progress.current ?? ""}…）`
        : progress.phase === "assets"
          ? mode === "push"
            ? `正在上传图片 ${progress.done + 1}/${progress.total}（${progress.current?.slice(0, 16) ?? ""}…）`
            : `正在下载图片 ${Math.min(progress.done + 1, progress.total)}/${progress.total}（${progress.current?.slice(0, 16) ?? ""}…）`
          : mode === "push"
            ? "正在推送题库数据（data.json）…"
            : "拉取完成。"
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
        <div className="sync-tabs">
          <button className={`tab ${mode === "push" ? "active" : ""}`} disabled={busy} onClick={() => switchMode("push")}>
            ⬆ 推送到远程
          </button>
          <button className={`tab ${mode === "pull" ? "active" : ""}`} disabled={busy} onClick={() => switchMode("pull")}>
            ⬇ 按设备拉取
          </button>
        </div>
        <label className="field-label">服务器地址（ip:端口）</label>
        <input
          className="modal-input"
          value={addr}
          placeholder="例如 192.168.1.100:8080"
          disabled={busy}
          onChange={e => setAddr(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !busy) void (mode === "push" ? runPush() : runPull());
          }}
        />
        <label className="field-label">访问令牌（可选，服务端未启用验证可留空）</label>
        <input className="modal-input" value={token} disabled={busy} onChange={e => setToken(e.target.value)} />
        <label className="modal-check">
          <input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} />
          <span>记住此地址（下次自动填入，可随时改填新的）</span>
        </label>

        {mode === "push" ? (
          <p className="muted">
            推送 {db.mistakes.length} 道错题、{db.notes.length} 篇笔记及引用的 {assetCount} 张图片。推送只覆盖本设备在服务器上的版本，其他设备推送的数据不受影响。
          </p>
        ) : (
          <p className="muted">
            拉取服务器上全部设备各自推送的整库，每台设备单独保存到本数据目录的 devices/
            下，<b>不与本机数据合并</b>；之后在错题本侧栏「远程设备」里按 设备 → 文件夹 只读浏览、可复制。
            {remoteDevices.length > 0 ? `（本地已有 ${remoteDevices.length} 台设备的快照，重新拉取即刷新）` : ""}
          </p>
        )}

        {busy && progress && (
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
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {result ? "完成" : "取消"}
              </button>
              <button
                className="btn btn-primary"
                disabled={!addr.trim()}
                onClick={() => void (mode === "push" ? runPush() : runPull())}
              >
                {result ? (mode === "push" ? "再次同步" : "再次拉取") : mode === "push" ? "开始同步" : "拉取全部设备"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
