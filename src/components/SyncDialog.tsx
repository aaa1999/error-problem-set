import { useRef, useState } from "react";
import { useBook } from "../store";
import { mergeOutcomeText, MergeAborted, type MergePlan } from "../lib/merge";
import {
  SyncAborted,
  clearSyncTarget,
  collectLibraryAssets,
  fetchRemotePlan,
  loadSyncTarget,
  normalizeServerAddr,
  pullFromServer,
  pushToServer,
  saveSyncTarget,
  type PullOutcome,
  type PullProgress,
  type SyncProgress,
} from "../lib/sync";

type Mode = "push" | "pull";

/** 顶栏「☁ 同步」弹窗：推送整库到自建服务端 / 从服务端拉取合并（v2 协议，两边都幂等可重入） */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const { db, dataDir, findOrCreateFolder, addMistakes, addNotes, addTags, addPendingImports } = useBook();
  const [mode, setMode] = useState<Mode>("push");
  const [saved] = useState(loadSyncTarget);
  const [addr, setAddr] = useState(saved?.server ?? "");
  const [token, setToken] = useState(saved?.token ?? "");
  const [remember, setRemember] = useState(!!saved);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | PullProgress | null>(null);
  const [result, setResult] = useState("");
  const [err, setErr] = useState("");
  // 拉取两步走：先取远端库算差量给用户确认，再执行合并
  const [pullPlan, setPullPlan] = useState<MergePlan | null>(null);
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
    setPullPlan(null);
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
      setResult(`同步完成：${parts.join("，")}；${r.mistakes} 道错题、${r.notes} 篇笔记、${r.folders} 个文件夹已推送。`);
    } catch (e) {
      if (e instanceof SyncAborted) setErr(`已中止：本次已上传 ${e.uploaded} 张图片，重新同步会自动续传。`);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // ---------- 拉取 ----------

  const runPullCheck = async () => {
    setErr("");
    setResult("");
    setPullPlan(null);
    const server = resolveServer();
    if (!server) return;
    setBusy(true);
    abortRef.current = false;
    setProgress({ phase: "connect", done: 0, total: 0 });
    try {
      const plan = await fetchRemotePlan({ server, token: token.trim() || undefined }, db);
      setPullPlan(plan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const pullNothingNew = (p: MergePlan) =>
    p.newMistakes.length === 0 && p.newNotes.length === 0 && p.newTags.length === 0 && p.assetKeys.length === 0;

  const runPullMerge = async () => {
    if (!pullPlan) return;
    setErr("");
    setBusy(true);
    abortRef.current = false;
    try {
      const server = resolveServer();
      if (!server) return;
      const r: PullOutcome = await pullFromServer(
        { server, token: token.trim() || undefined },
        dataDir,
        pullPlan,
        { findOrCreateFolder, addMistakes, addNotes, addTags, addPendingImports },
        setProgress,
        () => abortRef.current,
      );
      rememberTarget(server);
      setResult(`${mergeOutcomeText(pullPlan, r)}本次下载图片 ${r.downloadedAssets} 张。`);
      setPullPlan(null);
    } catch (e) {
      // 中止只发生在图片下载间隙：已下载的保留（哈希命名），重新拉取自动续上
      if (e instanceof MergeAborted) setErr(`已中止：已下载 ${e.fetched} 张图片，重新拉取会自动续上。`);
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
    setPullPlan(null);
    setProgress(null);
  };

  // ---------- 进度条与文案 ----------

  const pct = progress
    ? ((progress.done + (progress.phase === "data" || progress.phase === "merge" ? 1 : 0)) /
        Math.max(progress.total + 1, 1)) *
      100
    : 0;
  const phaseText = progress
    ? progress.phase === "connect"
      ? mode === "push"
        ? "正在连接服务器、获取清单…"
        : "正在连接服务器、拉取题库数据…"
      : progress.phase === "assets"
        ? mode === "push"
          ? `正在上传图片 ${progress.done + 1}/${progress.total}（${progress.current?.slice(0, 16) ?? ""}…）`
          : `正在下载图片 ${Math.min(progress.done + 1, progress.total)}/${progress.total}（${progress.current?.slice(0, 16) ?? ""}…）`
        : mode === "push"
          ? "正在推送题库数据（data.json）…"
          : "正在并入本地库…"
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
            ⬇ 从远程拉取
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
            if (e.key === "Enter" && !busy) void (mode === "push" ? runPush() : runPullCheck());
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
            推送 {db.mistakes.length} 道错题、{db.notes.length} 篇笔记及引用的 {assetCount} 张图片；服务器已有的图片自动跳过，可随时重复同步。服务端接口说明见
            docs/sync-protocol.md。
          </p>
        ) : pullPlan ? (
          <p className="muted">
            {pullNothingNew(pullPlan)
              ? "服务器数据已全部在本地，无需合并。"
              : `服务器上有 ${pullPlan.source.mistakes.length} 道错题、${pullPlan.source.notes.length} 篇笔记、${pullPlan.source.folders.length} 个文件夹：将合并新增 ${pullPlan.newMistakes.length} 道错题、${pullPlan.newNotes.length} 篇笔记、${pullPlan.newTags.length} 个标签（含 ${pullPlan.assetKeys.length} 张图片），其余本地已存在自动跳过。合并不会覆盖或删除本地任何数据。`}
          </p>
        ) : (
          <p className="muted">
            拉取服务器上的整份题库并合并到本地：新增的错题/笔记/文件夹/标签并入，本地已有的自动跳过，缺的图片按内容哈希下载。换新设备恢复数据、或多端互相同步都用它，可随时重复执行。
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
          ) : mode === "push" ? (
            result ? (
              <>
                <button className="btn" onClick={onClose}>
                  完成
                </button>
                <button className="btn btn-primary" onClick={() => void runPush()}>
                  再次同步
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={onClose}>
                  取消
                </button>
                <button className="btn btn-primary" disabled={!addr.trim()} onClick={() => void runPush()}>
                  开始同步
                </button>
              </>
            )
          ) : pullPlan ? (
            pullNothingNew(pullPlan) ? (
              <>
                <button className="btn" onClick={onClose}>
                  完成
                </button>
                <button className="btn btn-primary" onClick={() => void runPullCheck()}>
                  重新检查
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn"
                  onClick={() => {
                    setPullPlan(null);
                    setErr("");
                  }}
                >
                  取消
                </button>
                <button className="btn btn-primary" onClick={() => void runPullMerge()}>
                  开始合并
                </button>
              </>
            )
          ) : result ? (
            <>
              <button className="btn" onClick={onClose}>
                完成
              </button>
              <button className="btn btn-primary" onClick={() => void runPullCheck()}>
                再次拉取
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button className="btn btn-primary" disabled={!addr.trim()} onClick={() => void runPullCheck()}>
                检查并预览
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
