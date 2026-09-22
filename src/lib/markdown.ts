import { marked } from "marked";
import { fileSrc } from "./images";
import type { Note } from "../types";

/** assets 引用（assets/<hash>.<ext>）在 markdown 源文本和富文本 HTML 里都长这样，统一用一条正则收集 */
const ASSET_REF_RE = /assets\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|bmp|avif))/gi;

/** 数据目录下 assets/ 的 webview URL 前缀（已按需百分号编码），与 assetUrlFor 产出的形式一致 */
export function assetWebPrefix(dataDir: string): string {
  return fileSrc(`${dataDir.replace(/[\\/]+$/, "")}/assets`);
}

/** 相对引用 assets/xxx.png → webview 可显示的 URL */
export function resolveAssetRef(ref: string, dataDir: string): string {
  return `${assetWebPrefix(dataDir)}/${ref.slice("assets/".length)}`;
}

/** webview URL → 相对引用 assets/xxx.png；不是本库资源则原样返回（富文本编辑器序列化用） */
export function relativizeAssetUrl(url: string, dataDir: string): string {
  const prefix = assetWebPrefix(dataDir);
  if (url.startsWith(`${prefix}/`)) {
    try {
      return `assets/${decodeURIComponent(url.slice(prefix.length + 1))}`;
    } catch {
      return url;
    }
  }
  return url;
}

/** 富文本 HTML 里的 assets 引用按 map 换成目标地址（导出/预览用） */
export function mapAssetsInHtml(html: string, map: (ref: string) => string): string {
  return html.replace(/(\ssrc=")(assets\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|bmp|avif))(")/g, (_m, head, ref, tail) => `${head}${map(ref)}${tail}`);
}

/** 收集一段内容（markdown 源文本或富文本 HTML）里引用到的全部 assets 相对路径 */
export function collectAssetRefs(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(ASSET_REF_RE)) out.add(m[0]);
  return [...out];
}

/** 最低限度消毒：本地笔记应用里挡住粘贴内容带来的事件处理器与脚本（预览/导出前统一过一遍） */
export function sanitizeLite(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");
}

/** markdown → HTML；resolveImg 把 assets 相对引用换成目标地址，缺省保持原样（导出中间态用） */
export function renderMarkdown(md: string, resolveImg?: (ref: string) => string): string {
  const body = marked.parse(md, { gfm: true, breaks: true, async: false }) as string;
  const withImgs = resolveImg
    ? mapAssetsInHtml(body, resolveImg)
    : body;
  return sanitizeLite(withImgs);
}

/** 富文本 HTML 直接消毒（word 笔记预览/导出用） */
export function sanitizeWordHtml(html: string): string {
  return sanitizeLite(html);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 列表摘要：取第一段有字的纯文本，截 80 字 */
export function noteExcerpt(note: Note): string {
  let text: string;
  if (note.format === "markdown") {
    text = note.content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+.*$/gm, "") // 标题行整行跳过（和标题输入框重复）
      .trim();
  } else {
    text = decodeEntities(
      note.content
        .replace(/<\/?(?:b|strong|i|em|u|s|strike|span|code|sub|sup|font|a)\b[^>]*>/gi, "") // 行内标签直接剥掉不留空格
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 笔记是否完全没有内容（没标题、没文字、没图） */
export function isNoteEmpty(title: string, content: string, format: Note["format"]): boolean {
  if (title.trim().length > 0) return false;
  if (collectAssetRefs(content).length > 0) return false;
  const text = format === "markdown" ? content : content.replace(/<[^>]+>/g, " ");
  return text.replace(/\s|\u00a0/g, "").length === 0;
}
