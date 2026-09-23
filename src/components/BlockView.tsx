import type { Block, ImageBlock } from "../types";
import { useBook } from "../store";

export function BlockView({ blocks, onImageClick }: { blocks: Block[]; onImageClick?: (b: ImageBlock) => void }) {
  const { assetSrc } = useBook();
  if (blocks.length === 0) {
    return <div className="bv-empty">（空）</div>;
  }
  return (
    <div className="blockview">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <p key={b.id} className="bv-text">
            {b.text}
          </p>
        ) : (
          <img
            key={`${b.hash}-${i}`}
            className="bv-img"
            src={assetSrc(b)}
            alt=""
            loading="lazy"
            draggable={false}
            onClick={() => onImageClick?.(b)}
          />
        ),
      )}
    </div>
  );
}
