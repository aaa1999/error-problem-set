import { useId, useState } from "react";

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
