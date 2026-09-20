import type { Block, TextBlock } from "../types";

export function uuid(): string {
  return crypto.randomUUID();
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 文件名自然排序：题2 排在 题10 前面 */
export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}

export function newTextNode(text = ""): TextBlock {
  return { id: uuid(), type: "text", text };
}

/** 没有任何有效内容（无文字且无图片）返回 true */
export function isBlocksEmpty(blocks: Block[]): boolean {
  return !blocks.some(b => (b.type === "text" ? b.text.trim().length > 0 : true));
}

export function blocksToPlainText(blocks: Block[]): string {
  return blocks
    .map(b => (b.type === "text" ? b.text : "[图]"))
    .join("\n")
    .trim();
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 只保留路径最后两级，用于顶栏展示 */
export function shortDir(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}
