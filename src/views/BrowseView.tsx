import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ImageBlock, Mistake } from "../types";
import { descendantSet, folderPathName } from "../lib/folders";
import { DND_MISTAKE } from "../lib/dnd";
import { copyMistake } from "../lib/copy";
import { isBlocksEmpty, newShuffleSeed, seededShuffle, formatDay, formatTime } from "../lib/utils";
import { useBook } from "../store";
import { parseDeviceSel } from "../lib/devices";
import { BlockView } from "../components/BlockView";
import { Lightbox } from "../components/Lightbox";
import { Sidebar } from "../components/Sidebar";
import { FolderSelect } from "../components/FolderSelect";

/** 翻页排列：按录入时间（旧→新）/ 按错误率（高→低，仅带选项的题）/ 随机（稳定洗牌，重算不跳序） */
type BrowseOrder = "time" | "error" | "random";
const ORDER_KEY = "errorbook.browse.order";

function loadOrder(): BrowseOrder {
  const v = localStorage.getItem(ORDER_KEY);
  return v === "random" || v === "error" ? v : "time";
}

/** 错误率百分比（未作答按 0% 计） */
function optionRate(m: Mistake): number {
  return m.attempts > 0 ? Math.round((m.wrong / m.attempts) * 100) : 0;
}

export function BrowseView({
  onEdit,
  onNew,
  onNewInFolder,
  onNewWithTag,
  selected,
  onSelect,
}: {
  onEdit: (id: string) => void;
  onNew: () => void;
  onNewInFolder: (folderId: string) => void;
  onNewWithTag: (tag: string) => void;
  selected: string;
  onSelect: (s: string) => void;
}) {
  const { db, allTags, assetSrc, assetsDir, deleteMistake, setMistakeFolders, updateMistake, remoteDevices } = useBook();
  // 远程设备范围（侧栏「远程设备」选择 device:<id>[/子范围]）：数据源换成该设备的库，只读浏览
  const devSel = parseDeviceSel(selected);
  const remote = devSel ? remoteDevices.find(d => d.id === devSel.deviceId) ?? null : null;
  const activeDb = remote ? remote.db : db;
  const readOnly = remote !== null;
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"and" | "or">("and");
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [revealed, setRevealed] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string[]>([]);
  const [tagPopOpen, setTagPopOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [order, setOrder] = useState<BrowseOrder>(loadOrder);
  const [seed, setSeed] = useState(newShuffleSeed);
  // 题号总览：当前筛选（文件夹 + 标签）下的全部题展开成题号网格，点题号跳题
  const [numOpen, setNumOpen] = useState(false);
  const curCellRef = useRef<HTMLButtonElement | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  // 文件夹范围（含子文件夹）；"cat" = 已分类、"uncat" = 未分类；标签筛选叠加其上。
  // 远程设备范围：sub ""=该设备全部、"uncat"=该设备未分类、其余=该设备内文件夹（标签不适用）
  const inFolder = useMemo(() => {
    if (devSel) {
      let arr = activeDb.mistakes;
      if (devSel.sub === "uncat") {
        const ids = new Set(activeDb.folders.map(f => f.id));
        arr = arr.filter(m => !m.folderIds.some(id => ids.has(id)));
      } else if (devSel.sub) {
        const set = descendantSet(activeDb.folders, devSel.sub);
        arr = arr.filter(m => m.folderIds.some(id => set.has(id)));
      }
      return arr;
    }
    let arr = db.mistakes;
    if (selected === "uncat") {
      const ids = new Set(db.folders.map(f => f.id));
      arr = arr.filter(m => !m.folderIds.some(id => ids.has(id)));
    } else if (selected === "cat") {
      const ids = new Set(db.folders.map(f => f.id));
      arr = arr.filter(m => m.folderIds.some(id => ids.has(id)));
    } else if (selected) {
      const set = descendantSet(db.folders, selected);
      arr = arr.filter(m => m.folderIds.some(id => set.has(id)));
    }
    return arr;
  }, [db, activeDb, selected, devSel?.deviceId, devSel?.sub]);

  // 侧栏「本机」文件夹树的计数始终用本机库（远程设备树各自算自己的，见 RemoteDevices.tsx）；
  // 远程范围下标签筛选不适用，list 里会忽略 activeTags
  const mistakesMatchingTags = useMemo(() => {
    if (activeTags.length === 0) return db.mistakes;
    return tagMode === "and"
      ? db.mistakes.filter(m => activeTags.every(t => m.tags.includes(t)))
      : db.mistakes.filter(m => activeTags.some(t => m.tags.includes(t)));
  }, [db, activeTags, tagMode]);

  const list = useMemo(() => {
    let arr = inFolder;
    if (!devSel && activeTags.length > 0) {
      arr = tagMode === "and"
        ? inFolder.filter(m => activeTags.every(t => m.tags.includes(t)))
        : inFolder.filter(m => activeTags.some(t => m.tags.includes(t)));
    }
    if (order === "time") return [...arr].sort((a, b) => a.createdAt - b.createdAt);
    if (order === "error") {
      // 错误率排序：只含有选项且标记了正确答案的题（其余不参与）；错误率高 → 作答多 → 先录入在前
      return arr
        .filter(m => m.options.length > 0 && m.answer !== null)
        .sort((a, b) => optionRate(b) - optionRate(a) || b.attempts - a.attempts || a.createdAt - b.createdAt);
    }
    // 随机：seed 固定的稳定洗牌（换 seed 才换序）
    return seededShuffle(arr, seed);
  }, [inFolder, activeTags, tagMode, order, seed, devSel?.deviceId]);

  const cur = list.length > 0 ? list[Math.min(index, list.length - 1)] : undefined;

  // 题号总览按导入日期分组：组序跟随当前排列（时间排序下即由旧到新），同一天的题归到同组
  const numGroups = useMemo(() => {
    const groups: { day: string; items: { m: Mistake; i: number }[] }[] = [];
    const byDay = new Map<string, (typeof groups)[number]>();
    for (let i = 0; i < list.length; i++) {
      const day = formatDay(list[i].createdAt);
      let g = byDay.get(day);
      if (!g) {
        g = { day, items: [] };
        byDay.set(day, g);
        groups.push(g);
      }
      g.items.push({ m: list[i], i });
    }
    return groups;
  }, [list]);

  const crumb = devSel
    ? `${remote ? remote.name : "远程设备"}${devSel.sub === "" ? "" : devSel.sub === "uncat" ? " · 未分类" : ` · ${folderPathName(activeDb.folders, devSel.sub)}`}`
    : selected === "" ? "全部错题" : selected === "uncat" ? "未分类" : selected === "cat" ? "已分类" : folderPathName(db.folders, selected);

  // 进入远程设备范围时清掉标签筛选（标签属本机库，设备范围不适用）
  useEffect(() => {
    if (readOnly) setActiveTags([]);
  }, [readOnly]);

  const toggleTag = (t: string) =>
    setActiveTags(ts => (ts.includes(t) ? ts.filter(x => x !== t) : [...ts, t]));

  // 当前题打/移除标签：立即落盘
  const setCurTags = (tags: string[]) => {
    if (cur) void updateMistake({ ...cur, tags, updatedAt: Date.now() });
  };
  const toggleTagOnCur = (t: string) => {
    if (!cur) return;
    setCurTags(cur.tags.includes(t) ? cur.tags.filter(x => x !== t) : [...cur.tags, t]);
  };
  const addNewTagToCur = () => {
    if (!cur) return;
    const t = tagDraft.trim();
    setTagDraft("");
    if (t && !cur.tags.includes(t)) setCurTags([...cur.tags, t]);
  };

  const clearFilters = () => {
    setActiveTags([]);
    onSelect("");
  };

  // 选择题作答：本次浏览内每题只作答一次，答完自动翻开解析并累计统计（落盘）；远程设备只读不作答
  const [picked, setPicked] = useState<number | null>(null);
  const answerOption = (i: number) => {
    if (!cur || readOnly || picked !== null || cur.answer === null) return;
    setPicked(i);
    setRevealed(true);
    const ok = i === cur.answer;
    void updateMistake({
      ...cur,
      attempts: cur.attempts + 1,
      wrong: cur.wrong + (ok ? 0 : 1),
      updatedAt: Date.now(),
    });
  };

  // 一键复制：只复制题目 / 复制全部内容（富文本优先，图片内嵌；失败退纯文本）
  const [copied, setCopied] = useState<"" | "rich" | "text">("");
  const [copiedScope, setCopiedScope] = useState<"question" | "all">("all");
  const [copyPopOpen, setCopyPopOpen] = useState(false);
  const copyCur = async (scope: "question" | "all") => {
    if (!cur) return;
    setCopyPopOpen(false);
    const r = await copyMistake(cur, activeDb.folders, assetsDir, scope);
    setCopiedScope(scope);
    setCopied(r);
    window.setTimeout(() => setCopied(""), 1800);
  };

  // 切排列：进入随机模式换一批新顺序；随机模式下点「随机」= 重新洗牌
  const applyOrder = (o: BrowseOrder) => {
    if (o === order) return;
    localStorage.setItem(ORDER_KEY, o);
    setOrder(o);
    if (o === "random") setSeed(newShuffleSeed());
  };
  const reshuffle = () => setSeed(newShuffleSeed());

  // 筛选或排列变化回到第一题；删除/筛选导致列表变短时收敛下标
  useEffect(() => {
    setIndex(0);
    setRevealed(false);
    setTagPopOpen(false);
    setCopyPopOpen(false);
    setPicked(null);
    setNumOpen(false);
  }, [selected, activeTags, tagMode, order, seed]);

  useEffect(() => {
    setIndex(i => Math.min(i, Math.max(list.length - 1, 0)));
  }, [list.length]);

  const go = (d: 1 | -1) => {
    if (!cur) return;
    const n = index + d;
    if (n < 0 || n >= list.length) return;
    setDir(d);
    setIndex(n);
    setRevealed(false);
    setTagPopOpen(false);
    setCopyPopOpen(false);
    setPicked(null);
  };

  // 题号总览里点题号直接跳到那道题（重置内容与 go 一致）
  const jumpTo = (i: number) => {
    if (i < 0 || i >= list.length) return;
    setIndex(i);
    setRevealed(false);
    setTagPopOpen(false);
    setCopyPopOpen(false);
    setPicked(null);
    setNumOpen(false);
  };

  // 打开题号总览时滚到当前题
  useEffect(() => {
    if (numOpen) curCellRef.current?.scrollIntoView({ block: "center" });
  }, [numOpen]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (lightbox) return;
      if (tagPopOpen) {
        if (e.key === "Escape") setTagPopOpen(false);
        return;
      }
      const t = document.activeElement;
      const typing =
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === " ") {
        e.preventDefault();
        setRevealed(r => !r);
      } else if (e.key === "e" || e.key === "E") {
        if (cur && !readOnly) onEdit(cur.id);
      } else if (e.key === "n" || e.key === "N") {
        if (!readOnly) onNew();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, list.length, cur?.id, onEdit, onNew, lightbox, tagPopOpen, readOnly]);

  const remove = async () => {
    if (!cur) return;
    const ok = await ask("确定删除这道题吗？（旧数据在数据目录的 snapshots 里还有备份）", { title: "删除确认" });
    if (ok) await deleteMistake(cur.id);
  };

  const openMove = () => {
    if (!cur) return;
    setMoveTarget([...cur.folderIds]);
    setMoveOpen(true);
  };

  const confirmMove = async () => {
    if (cur) await setMistakeFolders(cur.id, moveTarget);
    setMoveOpen(false);
  };

  const openImage = (b: ImageBlock) => setLightbox(assetSrc(b));

  const sidebar = (
    <Sidebar
      selected={selected}
      onSelect={onSelect}
      activeTags={activeTags}
      onToggleTag={toggleTag}
      onClearTags={() => setActiveTags([])}
      tagMode={tagMode}
      onToggleTagMode={() => setTagMode(m => (m === "and" ? "or" : "and"))}
      mistakesInFolder={inFolder}
      mistakesMatchingTags={mistakesMatchingTags}
      onNewInFolder={onNewInFolder}
      onNewWithTag={onNewWithTag}
    />
  );

  // 排列方式切换：正常浏览在底栏，空态（如错误率排序下当前文件夹没有选择题）也渲染，避免被困住
  const orderSwitch = (
    <span className="order-switch" role="group" aria-label="排列方式">
      <button
        className={`seg ${order === "time" ? "on" : ""}`}
        title="按录入时间排列（旧 → 新）"
        onClick={() => applyOrder("time")}
      >
        时间
      </button>
      <button
        className={`seg ${order === "error" ? "on" : ""}`}
        title="按错误率从高到低（只显示录入时填了选项的题，优先复习错得多的）"
        onClick={() => applyOrder("error")}
      >
        错误率
      </button>
      <button
        className={`seg ${order === "random" ? "on" : ""}`}
        title={order === "random" ? "点击重新洗牌（换一批顺序）" : "随机排列，适合复习防背序"}
        onClick={() => (order === "random" ? reshuffle() : applyOrder("random"))}
      >
        随机
      </button>
    </span>
  );

  if (list.length === 0 || !cur) {
    return (
      <div className="browse-layout">
        {sidebar}
        <div className="browse-main">
          <div className="empty-state">
            <div className="empty-icon">{readOnly ? "📱" : "📚"}</div>
            {activeDb.mistakes.length === 0 ? (
              readOnly ? (
                <>
                  <h2>该设备还没有错题</h2>
                  <p>{remote?.name} 推送到服务端的库是空的。</p>
                </>
              ) : (
                <>
                  <h2>还没有错题</h2>
                  <p>先录入第一道题，或把攒了一堆的截图文件夹批量导入进来。</p>
                  <button className="btn btn-primary" onClick={onNew}>
                    ＋ 录入错题
                  </button>
                </>
              )
            ) : (
              <>
                <h2>当前条件下没有错题</h2>
                <p>
                  {crumb}
                  {activeTags.length > 0 &&
                    ` · ${tagMode === "and" ? "同时含" : "含任一"}标签：${activeTags.join(tagMode === "and" ? " + " : " / ")}`}
                  {order === "error" && " · 错误率排序只显示录入时填了选项并标记了正确答案的题"}
                </p>
                {orderSwitch}
                <button className="btn" onClick={clearFilters}>
                  清除筛选
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const analysisEmpty = isBlocksEmpty(cur.analysis);

  return (
    <>
      <div className="browse-layout">
        {sidebar}
        <div className="browse-main">
          <div
            key={index}
            className={`browse ${dir === 1 ? "anim-next" : "anim-prev"}`}
            title={readOnly ? "远程设备的数据，只读浏览" : "按住卡片可拖到左侧文件夹归类（按住 ⌥ 拖 = 追加所属，不清掉原有文件夹）"}
            draggable={!tagPopOpen && !readOnly}
            onDragStart={e => {
              e.dataTransfer.setData(DND_MISTAKE, cur.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onTouchStart={e => {
              touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }}
            onTouchEnd={e => {
              if (!touch.current) return;
              const dx = e.changedTouches[0].clientX - touch.current.x;
              const dy = e.changedTouches[0].clientY - touch.current.y;
              touch.current = null;
              if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
            }}
          >
            <div className="browse-top">
              <button className="icon-btn" onClick={() => go(-1)} disabled={index === 0} title="上一题 (←)">
                ←
              </button>
              <div className="crumb-wrap">
                {selected === "" ? (
                  <span className="crumb" title={crumb}>
                    {crumb}
                  </span>
                ) : (
                  <button
                    className="tag-chip chip-btn"
                    title="点击取消文件夹筛选（回到全部错题）"
                    onClick={() => onSelect("")}
                  >
                        {crumb} ✕
                  </button>
                )}
                {activeTags.map(t => (
                  <button key={t} className="tag-chip chip-btn" title="点击移除该标签筛选" onClick={() => toggleTag(t)}>
                    {t} ✕
                  </button>
                ))}
                {(selected !== "" || activeTags.length > 0) && (
                  <button
                    className="tag-chip chip-btn reset-chip"
                    title="重置全部筛选条件（文件夹 + 标签）"
                    onClick={() => {
                      setActiveTags([]);
                      onSelect("");
                    }}
                  >
                    ⟲ 重置
                  </button>
                )}
              </div>
              <div className="browse-progress">
                <button
                  type="button"
                  className="num-overview-btn"
                  title="题号总览：当前筛选（文件夹 / 标签）下的全部题按导入日期分组展开成题号，点题号跳题"
                  onClick={() => setNumOpen(true)}
                >
                  ▦ 第 {index + 1} / {list.length} 题
                </button>
              </div>
              <button className="icon-btn" onClick={() => go(1)} disabled={index === list.length - 1} title="下一题 (→)">
                →
              </button>
            </div>

            <div className="page-card">
              <div className="page-tags">
                {cur.folderIds.length === 0 ? (
                  <span className="tag-chip folder-chip" title="未分类：这道题不属于任何文件夹">
                    未分类
                  </span>
                ) : (
                  cur.folderIds.map(fid => {
                    const f = activeDb.folders.find(x => x.id === fid);
                    if (!f) return null;
                    return (
                      <span key={fid} className="tag-chip folder-chip" title={`所属文件夹：${folderPathName(activeDb.folders, fid)}`}>
                        {f.name}
                      </span>
                    );
                  })
                )}
                {!readOnly &&
                  cur.tags.map(t => (
                    <span key={t} className="tag-chip">
                      {t}
                      <button type="button" title="移除该标签" onClick={() => toggleTagOnCur(t)}>
                        ×
                      </button>
                    </span>
                  ))}
                {readOnly && cur.tags.map(t => <span key={t} className="tag-chip">{t}</span>)}
                {!readOnly && (
                  <button type="button" className="tag-add-btn" title="新增或选择标签" onClick={() => setTagPopOpen(o => !o)}>
                    ＋ 标签
                  </button>
                )}
                {tagPopOpen && !readOnly && (
                  <>
                    <div className="popover-backdrop" onClick={() => setTagPopOpen(false)} />
                    <div className="tag-pop">
                      <div className="tag-pop-list">
                        {allTags.length === 0 ? (
                          <span className="muted">还没有标签，在下面输入新建一个</span>
                        ) : (
                          allTags.map(t => (
                            <button
                              type="button"
                              key={t}
                              className={`tag-chip chip-btn ${cur.tags.includes(t) ? "tag-on" : ""}`}
                              title={cur.tags.includes(t) ? "点击移除" : "点击添加"}
                              onClick={() => toggleTagOnCur(t)}
                            >
                              {t}
                            </button>
                          ))
                        )}
                      </div>
                      <input
                        className="tag-pop-input"
                        autoFocus
                        value={tagDraft}
                        placeholder="新标签，回车添加"
                        onChange={e => setTagDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addNewTagToCur();
                          } else if (e.key === "Escape") {
                            setTagPopOpen(false);
    setCopyPopOpen(false);
                          }
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="page-label">题目</div>
              <BlockView blocks={cur.question} onImageClick={openImage} />

              {cur.options.length > 0 && cur.answer !== null && (
                <div className="opt-block">
                  <div className="opt-head">
                    <span>作答</span>
                    <span
                      className={`opt-rate ${cur.attempts === 0 ? "" : optionRate(cur) >= 50 ? "bad" : "good"}`}
                      title={`答错 ${cur.wrong} 次 / 共作答 ${cur.attempts} 次`}
                    >
                      错误率 {optionRate(cur)}%（{cur.wrong}/{cur.attempts}）
                    </span>
                  </div>
                  <div className="opt-list">
                    {cur.options.map((o, i) => {
                      const answered = picked !== null;
                      const isCorrect = i === cur.answer;
                      const isWrongPick = answered && i === picked && !isCorrect;
                      const cls = answered && isCorrect ? "correct" : isWrongPick ? "wrong-pick" : "";
                      return (
                        <button
                          type="button"
                          key={i}
                          className={`opt-item ${cls}`}
                          disabled={readOnly || answered}
                          title={readOnly ? "远程设备的数据，只读" : undefined}
                          onClick={() => answerOption(i)}
                        >
                          <span className="opt-letter">{String.fromCharCode(65 + i)}</span>
                          <span>{o}</span>
                          {answered && isCorrect && (
                            <span className="opt-mark" style={{ color: "#2e7d32" }}>
                              ✓ 正确答案{picked === i ? "（你选对了）" : ""}
                            </span>
                          )}
                          {isWrongPick && (
                            <span className="opt-mark" style={{ color: "#c62828" }}>
                              ✕ 你的选择
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className={`page-a ${revealed ? "" : "masked"}`}>
                <div className="page-label">解析</div>
                <div className="page-a-body">
                      {analysisEmpty ? (
                        <div className="a-empty">
                          这道题还没有解析
                          {!readOnly && (
                            <button className="btn btn-sm" onClick={() => onEdit(cur.id)}>
                              去补解析
                            </button>
                          )}
                        </div>
                      ) : (
                    <BlockView blocks={cur.analysis} onImageClick={openImage} />
                  )}
                </div>
                {!revealed && (
                  <button className="reveal-btn" onClick={() => setRevealed(true)}>
                    👁 点击查看解析（空格）
                  </button>
                )}
              </div>
            </div>

            <div className="browse-foot">
              {orderSwitch}
              <span className="muted">
                {copied
                  ? copied === "rich"
                    ? copiedScope === "question"
                      ? "已复制题目 ✓（含图片，可直接粘贴）"
                      : "已复制全部内容 ✓（含图片，可直接粘贴到 Word / 笔记）"
                    : "已复制 ✓（纯文本，此环境不支持带图复制）"
                  : readOnly ? (
                    <>
                      <kbd>←</kbd> <kbd>→</kbd> 翻页 · <kbd>空格</kbd> 看解析 · 远程设备只读
                    </>
                  ) : (
                    <>
                      <kbd>←</kbd> <kbd>→</kbd> 翻页 · <kbd>空格</kbd> 看解析 · <kbd>E</kbd> 编辑 · <kbd>N</kbd> 新增
                    </>
                  )}
              </span>
              <div className="row-actions">
                <div className="copy-menu">
                  <button className="btn btn-sm" title="只复制题目，或复制整道题的全部内容" onClick={() => setCopyPopOpen(o => !o)}>
                    复制 ▾
                  </button>
                  {copyPopOpen && (
                    <>
                      <div className="popover-backdrop" onClick={() => setCopyPopOpen(false)} />
                      <div className="copy-pop">
                        <button type="button" onClick={() => void copyCur("question")}>
                          只复制题目（含图片）
                        </button>
                        <button type="button" onClick={() => void copyCur("all")}>
                          复制全部内容（题目、选项、解析、标签、文件夹）
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {!readOnly && (
                  <>
                    <button className="btn btn-sm" onClick={() => onEdit(cur.id)}>
                      编辑
                    </button>
                    <button className="btn btn-sm" onClick={openMove}>
                      移动
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => void remove()}>
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {numOpen && (
        <div className="modal-mask" onMouseDown={() => setNumOpen(false)}>
          <div className="modal-card num-overview" onMouseDown={e => e.stopPropagation()}>
            <h3>题号总览（{list.length} 题）</h3>
            <div className="num-groups">
              {numGroups.map(g => (
                <section className="num-group" key={g.day}>
                  <div className="num-day">
                    <span className="num-day-date">{g.day}</span>
                    <span className="num-day-count">{g.items.length} 题</span>
                  </div>
                  <div className="num-grid">
                    {g.items.map(({ m, i }) => (
                      <button
                        type="button"
                        key={m.id}
                        ref={i === index ? curCellRef : undefined}
                        className={`num-cell ${m.wrong > 0 ? "bad" : m.attempts > 0 ? "good" : ""} ${i === index ? "cur" : ""}`}
                        title={`${formatTime(m.createdAt)} 导入；${m.wrong > 0 ? `错过 ${m.wrong} 次，点题号跳题` : m.attempts > 0 ? "作答全对" : "未作答 / 非选择题"}`}
                        onClick={() => jumpTo(i)}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <p className="muted">
              按导入日期分组 · 红 = 错过 · 绿 = 作答全对 · 灰 = 未作答 / 非选择题；蓝框 = 当前题。点击题号跳转，范围随文件夹与标签筛选、排列方式变化。
            </p>
          </div>
        </div>
      )}
      {moveOpen && (
        <div className="modal-mask" onMouseDown={() => setMoveOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <h3>调整所属文件夹</h3>
            <FolderSelect value={moveTarget} onChange={setMoveTarget} />
            <p className="muted">一道题可同时属于多个文件夹；全部取消勾选即回到「未分类」。</p>
            <div className="modal-foot">
              <button className="btn" onClick={() => setMoveOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void confirmMove()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
