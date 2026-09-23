import { useEffect, useRef, useState } from "react";

export function NameModal({
  title,
  initial,
  placeholder = "文件夹名称",
  onOk,
  onCancel,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  onOk: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const confirm = () => {
    const v = value.trim();
    if (v) onOk(v);
  };

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
        />
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={confirm}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
