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

/** 天级时间（本地时区），用于按导入日期分组 */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 只保留路径最后两级，用于顶栏展示 */
export function shortDir(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

/** mulberry32 伪随机数（0..1）：种子固定则序列固定 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 以 seed 为种子的稳定洗牌：同 seed 同输入 → 同顺序（随机翻页用，重算不会跳序） */
export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 新洗牌种子（1..2^32-1，避开 0） */
export function newShuffleSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
}
