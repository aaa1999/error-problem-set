import { useMemo, useState } from "react";
import type { Mistake, PendingImport } from "../types";
import { formatTime, uuid } from "../lib/utils";
import { useBook } from "../store";

/**
 * 做题 tab：外部刷题的答题卡。流程：输文件夹名 + 题数（1–100）→ 逐题选 A/B/C/D 作答
 * （可标记「值得导入」）→ 做完手动输入正确答案比对 → 答错的和标记过的提醒导入错题本
 * （在所选文件夹生成题目条目，题干为占位，之后可在录入页补内容与图）。
 */

export type PracticeOpt = "A" | "B" | "C" | "D";
export const PRACTICE_OPTS: PracticeOpt[] = ["A", "B", "C", "D"];

export interface PracticeSession {
  phase: "answer" | "key" | "result";
  folderName: string;
  count: number;
  /** 我的答案（未作为 null） */
  mine: (PracticeOpt | null)[];
  /** 正确答案（未对为 null） */
  key: (PracticeOpt | null)[];
  /** 做题过程中标记「值得导入」 */
  flagged: boolean[];
  /** 已导入错题本 */
  imported: boolean[];
  /** 结果页的导入勾选（进入结果时按「答错 ∪ 标记⭐」预勾，可自行增减） */
  importSel: boolean[];
}

/** 做题文件夹跨启动记住：开始新的一组时写入，设置页带出 */
const FOLDER_KEY = "errorbook.practice.folder";

export function PracticeView({
  session,
  setSession,
}: {
  session: PracticeSession | null;
  setSession: (s: PracticeSession | null) => void;
}) {
  const { db, addMistake, findOrCreateFolderPath, removePendingImport } = useBook();

  // ---------- 设置 ----------
  const [folderName, setFolderName] = useState(session?.folderName ?? localStorage.getItem(FOLDER_KEY) ?? "");
  const [count, setCount] = useState(session?.count ?? 100);

  const start = () => {
    const n = Math.min(100, Math.max(1, Math.floor(count) || 1));
    setCount(n);
    localStorage.setItem(FOLDER_KEY, folderName.trim());
    setSession({
      phase: "answer",
      folderName: folderName.trim(),
      count: n,
      mine: Array(n).fill(null),
      key: Array(n).fill(null),
      flagged: Array(n).fill(false),
      imported: Array(n).fill(false),
      importSel: Array(n).fill(false),
    });
  };

  // ---------- 会话工具 ----------

  const setMine = (i: number, o: PracticeOpt) =>
    setSession(session ? { ...session, mine: session.mine.map((x, j) => (j === i ? o : x)) } : session);
  const setKey = (i: number, o: PracticeOpt) =>
    setSession(session ? { ...session, key: session.key.map((x, j) => (j === i ? o : x)) } : session);
  const toggleFlag = (i: number) =>
    setSession(session ? { ...session, flagged: session.flagged.map((x, j) => (j === i ? !x : x)) } : session);

  // 批量导入正确答案：每行「题号 分隔符 答案」（分隔符兼容若干空格/Tab/全角空格/逗号/顿号/句点/冒号；答案不分大小写，全角 ａ/Ａ/１ 先转半角），如「1  A」
  const [keyBulk, setKeyBulk] = useState("");
  const [keyBulkMsg, setKeyBulkMsg] = useState("");
  const importKeyBulk = () => {
    if (!session) return;
    let applied = 0;
    let bad = 0;
    const next = [...session.key];
    for (const raw of keyBulk.split(/\r?\n/)) {
      // 全角字母/数字（！-～）转半角：中文输入法打出的 ａ/Ａ/１ 也能解析
      const line = raw.trim().replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      if (!line) continue;
      const m = line.match(/^(\d{1,3})[\s,，.、:：]*([A-Da-d])/);
      if (!m) {
        bad++;
        continue;
      }
      const n = parseInt(m[1], 10);
      const o = m[2].toUpperCase() as PracticeOpt;
      if (n < 1 || n > session.count) {
        bad++;
        continue;
      }
      next[n - 1] = o;
      applied++;
    }
    setSession({ ...session, key: next });
    setKeyBulkMsg(`已填入 ${applied} 条${bad > 0 ? `，跳过无效行 ${bad} 行` : ""}`);
    setKeyBulk("");
    window.setTimeout(() => setKeyBulkMsg(""), 2500);
  };

  /** i 的比对结果：correct / wrong / blank（未作答）/ unknown（未对答案） */
  const verdict = (i: number): "correct" | "wrong" | "blank" | "unknown" => {
    if (!session) return "unknown";
    if (session.key[i] === null) return "unknown";
    if (session.mine[i] === null) return "blank";
    return session.mine[i] === session.key[i] ? "correct" : "wrong";
  };

  const stats = useMemo(() => {
    if (!session) return { correct: 0, wrong: 0, blank: 0, unknown: 0 };
    const v = [...Array(session.count).keys()].map(verdict);
    return {
      correct: v.filter(x => x === "correct").length,
      wrong: v.filter(x => x === "wrong").length,
      blank: v.filter(x => x === "blank").length,
      unknown: v.filter(x => x === "unknown").length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** 候选导入 = 答错 ∪ 做题过程中标记「值得导入」；是否真导由结果页勾选决定 */
  const suggest = useMemo(() => {
    if (!session) return [];
    return [...Array(session.count).keys()].filter(i => verdict(i) === "wrong" || session.flagged[i]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const importOne = async (i: number) => {
    if (!session) return;
    const folder = session.folderName ? await findOrCreateFolderPath(session.folderName, null) : null;
    const m: Mistake = {
      id: uuid(),
      folderIds: folder ? [folder.id] : [],
      options: [],
      answer: null,
      attempts: 0,
      wrong: 0,
      question: [{ id: uuid(), type: "text", text: `第 ${i + 1} 题（做题导入，待补充题目内容）` }],
      analysis: [
        {
          id: uuid(),
          type: "text",
          text: `做题批改（${formatTime(Date.now())}）：我选 ${session.mine[i] ?? "未作答"}，正确答案 ${session.key[i] ?? "未对"}。`,
        },
      ],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await addMistake(m);
    setSession({ ...session, imported: session.imported.map((x, j) => (j === i ? true : x)) });
  };

  /** 只导入结果页勾选了的题 */
  const importChecked = async () => {
    if (!session) return;
    for (const i of [...Array(session.count).keys()]) {
      if (session.importSel[i] && !session.imported[i]) await importOne(i);
    }
  };

  const toggleImportSel = (i: number) =>
    setSession(session ? { ...session, importSel: session.importSel.map((x, j) => (j === i ? !x : x)) } : session);

  // ---------- 来自手机的待导入清单 ----------

  const [busyPending, setBusyPending] = useState("");

  const importPending = async (p: PendingImport) => {
    setBusyPending(p.id);
    try {
      const folder = p.folderName ? await findOrCreateFolderPath(p.folderName, null) : null;
      for (const e of p.entries) {
        await addMistake({
          id: uuid(),
          folderIds: folder ? [folder.id] : [],
          options: [],
          answer: null,
          attempts: 0,
          wrong: 0,
          question: [{ id: uuid(), type: "text", text: `第 ${e.no} 题（做题导入，待补充题目内容）` }],
          analysis: [
            {
              id: uuid(),
              type: "text",
              text: `做题批改（${formatTime(p.createdAt)}）：我选 ${e.mine ?? "未作答"}，正确答案 ${e.key ?? "未对"}${e.flagged ? "（标记 ⭐" : ""}${e.flagged ? "）" : ""}。来自手机做题清单。`,
            },
          ],
          tags: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await removePendingImport(p.id);
    } finally {
      setBusyPending("");
    }
  };

  // ---------- 渲染 ----------

  const folderNames = useMemo(() => [...new Set(db.folders.map(f => f.name))], [db.folders]);
  const segRow = (i: number, value: PracticeOpt | null, onPick: (o: PracticeOpt) => void, extra?: React.ReactNode) => (
    <div key={i} className="prac-row">
      <span className="prac-no">{i + 1}</span>
      <span className="prac-opts">
        {PRACTICE_OPTS.map(o => (
          <button
            key={o}
            type="button"
            className={`prac-opt ${value === o ? "on" : ""}`}
            onClick={() => onPick(o)}
          >
            {o}
          </button>
        ))}
      </span>
      {extra}
    </div>
  );

  return (
    <div className="practice">
      {!session ? (
        // ---------- 设置 ----------
        <>
        <div className="page-card" style={{ maxWidth: 560 }}>
          <div className="page-label">做题设置</div>
          <label className="field-label">文件夹名</label>
          <input
            className="modal-input"
            value={folderName}
            placeholder="例如：数学 / 三角函数"
            list="prac-folders"
            onChange={e => setFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") start();
            }}
          />
          <datalist id="prac-folders">
            {folderNames.map(n => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <label className="field-label">题数（1–100）</label>
          <div className="row-actions">
            <input
              className="modal-input prac-count"
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={e => setCount(Number(e.target.value))}
            />
            {[10, 20, 50, 100].map(n => (
              <button key={n} type="button" className="btn btn-sm" onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
          <div className="modal-foot">
            <button className="btn btn-primary" onClick={() => void start()}>
              开始做题
            </button>
          </div>
        </div>

        {db.pendingImports.length > 0 && (
          <div className="page-card" style={{ maxWidth: 720 }}>
            <div className="page-label">来自手机做题的待导入清单（{db.pendingImports.length} 份，随 ☁ 同步流转）</div>
            <p className="muted">
              手机上做完题存下来的清单会随同步到这边；「导入」按清单在对应文件夹生成占位错题（题干待补），
              「丢弃」删除该清单。导入后去错题本逐题补题目内容和图即可。
            </p>
            {db.pendingImports.map(p => (
              <div key={p.id} className="prac-row pending-card">
                <div className="pending-info">
                  <div className="pending-title">
                    {p.folderName ? `📁 ${p.folderName}` : "未分类"} · 共 {p.total} 题 · 勾选导入 {p.entries.length} 题
                    <span className="muted" style={{ fontWeight: 400 }}>（{formatTime(p.createdAt)}）</span>
                  </div>
                  <div className="muted pending-nos" title="待导入题号">
                    {p.entries.map(e => e.no).join("、")}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn btn-primary btn-sm" disabled={busyPending === p.id} onClick={() => void importPending(p)}>
                    {busyPending === p.id ? "导入中…" : `导入 ${p.entries.length} 题`}
                  </button>
                  <button className="btn btn-sm" disabled={busyPending === p.id} onClick={() => void removePendingImport(p.id)}>
                    丢弃
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        </>
      ) : session.phase === "answer" ? (
        // ---------- 作答 ----------
        <div className="page-card">
          <div className="prac-head">
            <div>
              <div className="page-label">
                做题中{session.folderName ? ` · ${session.folderName}` : ""}
              </div>
              <p className="muted">
                已答 {session.mine.filter(Boolean).length} / {session.count} 题；⭐ = 值得导入错题本
              </p>
            </div>
            <div className="row-actions">
              <button
                className="btn"
                onClick={() => {
                  if (confirm("放弃本次做题记录？")) setSession(null);
                }}
              >
                放弃
              </button>
              <button className="btn btn-primary" onClick={() => setSession({ ...session, phase: "key" })}>
                完成作答，去对答案 →
              </button>
            </div>
          </div>
          <div className="prac-list">
            {[...Array(session.count).keys()].map(i =>
              segRow(
                i,
                session.mine[i],
                o => setMine(i, o),
                <button
                  key="flag"
                  type="button"
                  className={`prac-flag ${session.flagged[i] ? "on" : ""}`}
                  title={session.flagged[i] ? "已标记值得导入，点击取消" : "标记为值得导入错题本"}
                  onClick={() => toggleFlag(i)}
                >
                  ⭐
                </button>,
              ),
            )}
          </div>
        </div>
      ) : session.phase === "key" ? (
        // ---------- 输入正确答案 ----------
        <div className="page-card">
          <div className="prac-head">
            <div>
              <div className="page-label">对答案：逐题输入正确答案</div>
              <p className="muted">
                已对 {session.key.filter(Boolean).length} / {session.count} 题；没对的题按「未比对」处理，不算错
              </p>
            </div>
            <div className="row-actions">
              <button className="btn" onClick={() => setSession({ ...session, phase: "answer" })}>
                ← 返回作答
              </button>
              <button
                className="btn btn-primary"
                onClick={() =>
                  setSession({
                    ...session,
                    phase: "result",
                    // 进入结果页时预勾「答错 ∪ 标记⭐」，之后由用户自行增减
                    importSel: [...Array(session.count).keys()].map(
                      i => verdict(i) === "wrong" || session.flagged[i],
                    ),
                  })
                }
              >
                完成比对 →
              </button>
            </div>
          </div>
          <div className="prac-bulk">
            <label className="field-label">批量导入正确答案（每行一条：题号 + 空格或 Tab + 答案，不分大小写，如「1&nbsp;&nbsp;A」）</label>
            <textarea
              className="modal-input prac-bulk-input"
              value={keyBulk}
              placeholder={"1 A\n2 C\n3 B"}
              rows={4}
              onChange={e => setKeyBulk(e.target.value)}
            />
            <div className="row-actions">
              <button type="button" className="btn btn-sm" disabled={!keyBulk.trim()} onClick={importKeyBulk}>
                从文本填入
              </button>
              {keyBulkMsg && <span className="muted">{keyBulkMsg}</span>}
            </div>
          </div>
          <div className="prac-list">
            {[...Array(session.count).keys()].map(i =>
              segRow(i, session.key[i], o => setKey(i, o), (
                <span key="mine" className={`prac-mine ${session.mine[i] === session.key[i] ? "ok" : "bad"}`}>
                  我选 {session.mine[i] ?? "—"}
                </span>
              )),
            )}
          </div>
        </div>
      ) : (
        // ---------- 结果 ----------
        <div className="page-card">
          <div className="prac-head">
            <div>
              <div className="page-label">
                比对结果{session.folderName ? ` · ${session.folderName}` : ""}
              </div>
              <p className="muted">
                ✅ 答对 {stats.correct} · ❌ 答错 {stats.wrong} · 未答 {stats.blank} · 未比对 {stats.unknown}
                {stats.correct + stats.wrong > 0 &&
                  ` · 正确率 ${Math.round((stats.correct / (stats.correct + stats.wrong)) * 100)}%`}
              </p>
            </div>
            <div className="row-actions">
              {session.importSel.some((on, i) => on && !session.imported[i]) && (
                <button className="btn btn-primary" onClick={() => void importChecked()}>
                  导入勾选的{" "}
                  {session.importSel.filter((on, i) => on && !session.imported[i]).length} 题
                </button>
              )}
              <button className="btn" onClick={() => setSession(null)}>
                再来一组
              </button>
            </div>
          </div>

          <div className="prac-suggest">
            <span className="page-label">是否导入错题本（答错 / 做题时标记 ⭐ 默认勾选，可自行调整）</span>
            {suggest.length === 0 ? (
              <p className="muted">没有候选题——全对且没有标记 ⭐，干得漂亮 👏</p>
            ) : (
              <div className="prac-list">
                {suggest.map(i => (
                  <div key={i} className={`prac-row ${verdict(i) === "wrong" ? "bad" : ""}`}>
                    <label className="prac-check" title="勾选 = 导入错题本">
                      <input
                        type="checkbox"
                        checked={session.importSel[i] || session.imported[i]}
                        disabled={session.imported[i]}
                        onChange={() => toggleImportSel(i)}
                      />
                    </label>
                    <span className="prac-no">{i + 1}</span>
                    <span className="prac-verdict">
                      {verdict(i) === "wrong"
                        ? `我选 ${session.mine[i]} ✕ · 正确 ${session.key[i]}`
                        : verdict(i) === "blank"
                          ? `未作答 · 正确 ${session.key[i]}`
                          : `答对 ✓${session.flagged[i] ? " · 标记 ⭐" : ""}`}
                    </span>
                    {session.imported[i] ? <span className="prac-imported">已导入 ✓</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="prac-suggest">
            <span className="page-label">全部题目</span>
            <div className="prac-grid">
              {[...Array(session.count).keys()].map(i => {
                const v = verdict(i);
                return (
                  <span
                    key={i}
                    className={`prac-cell ${v} ${session.imported[i] ? "imported" : ""} ${session.flagged[i] && v !== "wrong" ? "flagged" : ""}`}
                    title={`第 ${i + 1} 题：${
                      v === "correct" ? "答对" : v === "wrong" ? "答错" : v === "blank" ? "未答" : "未比对"
                    }${session.flagged[i] ? " · 标记 ⭐" : ""}${session.imported[i] ? " · 已导入" : ""}`}
                  >
                    {i + 1}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
