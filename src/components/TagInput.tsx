import { useId, useRef, useState } from "react";

export function TagInput({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  const commit = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };

  const remaining = suggestions.filter(s => !value.includes(s));

  return (
    <div className="tag-input">
      <div className="tag-main">
        {value.map(t => (
          <span key={t} className="tag-chip">
            {t}
            <button type="button" title="移除标签" onClick={() => onChange(value.filter(x => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          list={listId}
          value={draft}
          placeholder="新标签，回车确认"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === "," || e.key === "，") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
        <datalist id={listId}>
          {remaining.map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {remaining.length > 0 && (
        <div className="tag-suggest">
          {remaining.map(s => (
            <button type="button" key={s} className="tag-suggest-chip" title="点击添加该标签" onClick={() => onChange([...value, s])}>
              ＋ {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 标签下拉选择：与 FolderSelect 同款紧凑按钮（高度一致），弹层勾选已有标签 + 输入新建 */
export function TagSelect({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // 弹层快溢出窗口右缘时改为右对齐展开
  const [popRight, setPopRight] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const toggleOpen = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPopRight(r.left + 330 > window.innerWidth);
    setOpen(o => !o);
  };

  const label =
    value.length === 0 ? "标签" : value.length === 1 ? value[0] : `${value[0]} +${value.length - 1}`;

  const toggle = (t: string) => onChange(value.includes(t) ? value.filter(x => x !== t) : [...value, t]);

  const commit = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };

  return (
    <div className="folder-select-wrap tag-select-wrap">
      <button ref={btnRef} type="button" className="folder-select-btn" title="选择标签，可多选" onClick={toggleOpen}>
        <span className="folder-select-label">{label}</span>
        <span className="folder-select-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className={`folder-pop ${popRight ? "pop-right" : ""}`}>
            {suggestions.map(t => (
              <button
                type="button"
                key={t}
                className={`folder-pop-row ${value.includes(t) ? "on" : ""}`}
                onClick={() => toggle(t)}
              >
                <span className="folder-pop-check">{value.includes(t) ? "✓" : ""}</span>
                {t}
              </button>
            ))}
            {suggestions.length === 0 && <div className="muted folder-pop-empty">还没有标签，在下面输入新建</div>}
            <div className="folder-pop-create">
              <input
                className="modal-input"
                value={draft}
                placeholder="新标签，回车确认"
                autoFocus
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === "," || e.key === "，") {
                    e.preventDefault();
                    commit();
                  }
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
