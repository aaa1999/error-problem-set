import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ImageBlock } from "../types";
import { descendantSet, folderPathName } from "../lib/folders";
import { isBlocksEmpty } from "../lib/utils";
import { useBook } from "../store";
import { BlockView } from "../components/BlockView";
import { Lightbox } from "../components/Lightbox";
import { Sidebar } from "../components/Sidebar";
import { FolderSelect } from "../components/FolderSelect";

export function BrowseView({
  onEdit,
  onNew,
  selected,
  onSelect,
}: {
  onEdit: (id: string) => void;
  onNew: () => void;
  selected: string;
  onSelect: (s: string) => void;
}) {
  const { db, allTags, assetSrc, deleteMistake, setMistakeFolder, updateMistake } = useBook();
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"and" | "or">("and");
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [revealed, setRevealed] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [tagPopOpen, setTagPopOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const touch = useRef<{ x: number; y: number } | null>(null);

  // 文件夹范围（含子文件夹）；标签筛选叠加其上，两者同时生效
  const inFolder = useMemo(() => {
    let arr = db.mistakes;
    if (selected === "uncat") {
      const ids = new Set(db.folders.map(f => f.id));
      arr = arr.filter(m => !m.folderId || !ids.has(m.folderId));
    } else if (selected) {
      const set = descendantSet(db.folders, selected);
      arr = arr.filter(m => m.folderId !== null && set.has(m.folderId));
    }
    return arr;
  }, [db, selected]);

  const mistakesMatchingTags = useMemo(() => {
    if (activeTags.length === 0) return db.mistakes;
    return tagMode === "and"
      ? db.mistakes.filter(m => activeTags.every(t => m.tags.includes(t)))
      : db.mistakes.filter(m => activeTags.some(t => m.tags.includes(t)));
  }, [db, activeTags, tagMode]);

  const list = useMemo(() => {
    if (activeTags.length === 0) return inFolder;
    return tagMode === "and"
      ? inFolder.filter(m => activeTags.every(t => m.tags.includes(t)))
      : inFolder.filter(m => activeTags.some(t => m.tags.includes(t)));
  }, [inFolder, activeTags, tagMode]);

  const cur = list.length > 0 ? list[Math.min(index, list.length - 1)] : undefined;

  const crumb = selected === "" ? "全部错题" : selected === "uncat" ? "未分类" : folderPathName(db.folders, selected);

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

  // 筛选变化回到第一题；删除/筛选导致列表变短时收敛下标
  useEffect(() => {
    setIndex(0);
    setRevealed(false);
    setTagPopOpen(false);
  }, [selected, activeTags, tagMode]);

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
  };

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
        if (cur) onEdit(cur.id);
      } else if (e.key === "n" || e.key === "N") {
        onNew();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, list.length, cur?.id, onEdit, onNew, lightbox, tagPopOpen]);

  const remove = async () => {
    if (!cur) return;
    const ok = await ask("确定删除这道题吗？（旧数据在数据目录的 snapshots 里还有备份）", { title: "删除确认" });
    if (ok) await deleteMistake(cur.id);
  };

  const openMove = () => {
    if (!cur) return;
    setMoveTarget(cur.folderId ?? null);
    setMoveOpen(true);
  };

  const confirmMove = async () => {
    if (cur) await setMistakeFolder(cur.id, moveTarget);
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
    />
  );

  if (list.length === 0 || !cur) {
    return (
      <div className="browse-layout">
        {sidebar}
        <div className="browse-main">
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            {db.mistakes.length === 0 ? (
              <>
                <h2>还没有错题</h2>
                <p>先录入第一道题，或把攒了一堆的截图文件夹批量导入进来。</p>
                <button className="btn btn-primary" onClick={onNew}>
                  ＋ 录入错题
                </button>
              </>
            ) : (
              <>
                <h2>当前条件下没有错题</h2>
                <p>
                  {crumb}
                  {activeTags.length > 0 &&
                    ` · ${tagMode === "and" ? "同时含" : "含任一"}标签：${activeTags.join(tagMode === "and" ? " + " : " / ")}`}
                </p>
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
                <span className="crumb" title={crumb}>
                  {crumb}
                </span>
                {activeTags.map(t => (
                  <button key={t} className="tag-chip chip-btn" title="点击移除该标签筛选" onClick={() => toggleTag(t)}>
                    {t} ✕
                  </button>
                ))}
              </div>
              <div className="browse-progress">
                第 {index + 1} / {list.length} 题
              </div>
              <button className="icon-btn" onClick={() => go(1)} disabled={index === list.length - 1} title="下一题 (→)">
                →
              </button>
            </div>

            <div className="page-card">
              <div className="page-tags">
                {cur.tags.map(t => (
                  <span key={t} className="tag-chip">
                    {t}
                    <button type="button" title="移除该标签" onClick={() => toggleTagOnCur(t)}>
                      ×
                    </button>
                  </span>
                ))}
                <button type="button" className="tag-add-btn" title="新增或选择标签" onClick={() => setTagPopOpen(o => !o)}>
                  ＋ 标签
                </button>
                {tagPopOpen && (
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
                          }
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="page-label">题目</div>
              <BlockView blocks={cur.question} onImageClick={openImage} />

              <div className={`page-a ${revealed ? "" : "masked"}`}>
                <div className="page-label">解析</div>
                <div className="page-a-body">
                  {analysisEmpty ? (
                    <div className="a-empty">
                      这道题还没有解析
                      <button className="btn btn-sm" onClick={() => onEdit(cur.id)}>
                        去补解析
                      </button>
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
              <span className="muted">
                <kbd>←</kbd> <kbd>→</kbd> 翻页 · <kbd>空格</kbd> 看解析 · <kbd>E</kbd> 编辑 · <kbd>N</kbd> 新增
              </span>
              <div className="row-actions">
                <button className="btn btn-sm" onClick={() => onEdit(cur.id)}>
                  编辑
                </button>
                <button className="btn btn-sm" onClick={openMove}>
                  移动
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => void remove()}>
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {moveOpen && (
        <div className="modal-mask" onMouseDown={() => setMoveOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <h3>移动到文件夹</h3>
            <FolderSelect value={moveTarget} onChange={setMoveTarget} />
            <p className="muted">选「未分类」即移出所有文件夹；也可以之后在编辑页修改。</p>
            <div className="modal-foot">
              <button className="btn" onClick={() => setMoveOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void confirmMove()}>
                移动
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
