import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { join } from "@tauri-apps/api/path";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Note } from "../types";
import { collectAssetRefs, mapAssetsInHtml, renderMarkdown, sanitizeWordHtml } from "./markdown";
import { extOf } from "./images";

export type ExportResult = "saved" | "cancelled";

function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();
  return cleaned || "笔记";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 读取笔记引用到的全部图片，ref → 字节；缺文件跳过 */
async function loadAssets(dataDir: string, content: string): Promise<Map<string, Uint8Array>> {
  const map = new Map<string, Uint8Array>();
  for (const ref of collectAssetRefs(content)) {
    try {
      map.set(ref, await readFile(await join(dataDir, "assets", ref.slice("assets/".length))));
    } catch {
      // 图片文件缺失就跳过，导出里留空
    }
  }
  return map;
}

/** 生成导出正文 HTML：markdown 先渲染，assets 引用按 map 换地址；标题按需补一个 h1 */
function bodyHtmlForExport(note: Pick<Note, "format" | "content" | "title">, map: (ref: string) => string): string {
  const inner =
    note.format === "markdown" ? renderMarkdown(note.content, map) : sanitizeWordHtml(mapAssetsInHtml(note.content, map));
  const title = note.title.trim();
  // word 笔记标题在正文输入框之外，导出时补进正文；markdown 用户通常自己写 # 标题，开头已是标题就不重复补
  const startsWithHeading = note.format === "markdown" && /^\s*#{1,6}\s+\S/.test(note.content);
  const titleHtml = title && !startsWithHeading ? `<h1>${escapeHtml(title)}</h1>\n` : "";
  return titleHtml + inner;
}

/** 导出 PDF：离屏渲染成位图，按 A4 高度切片分页（文字为位图，不可选中复制） */
export async function exportNoteAsPdf(note: Pick<Note, "format" | "content" | "title">, dataDir: string): Promise<ExportResult> {
  const target = await saveDialog({
    defaultPath: `${safeFileName(note.title)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!target) return "cancelled";

  const assets = await loadAssets(dataDir, note.content);
  const blobUrls: string[] = [];
  const host = document.createElement("div");
  host.className = "note-print";
  try {
    host.innerHTML = bodyHtmlForExport(note, ref => {
      const bytes = assets.get(ref);
      if (!bytes) return "";
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      blobUrls.push(url);
      return url;
    });
    host.querySelectorAll('img:not([src]),img[src=""]').forEach(el => el.remove());
    Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", zIndex: "-1" });
    document.body.appendChild(host);

    const canvas = await html2canvas(host, { scale: 2, backgroundColor: "#ffffff" });
    if (canvas.width === 0 || canvas.height === 0) throw new Error("渲染内容为空");

    const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const ratio = pageW / canvas.width; // px → pt
    const sliceH = Math.max(1, Math.floor(pageH / ratio));
    for (let y = 0; y < canvas.height; y += sliceH) {
      const h = Math.min(sliceH, canvas.height - y);
      const page = document.createElement("canvas");
      page.width = canvas.width;
      page.height = h;
      const ctx = page.getContext("2d");
      if (!ctx) break;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, page.width, h);
      ctx.drawImage(canvas, 0, -y);
      if (y > 0) pdf.addPage();
      pdf.addImage(page.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageW, h * ratio);
    }
    await writeFile(target, new Uint8Array(pdf.output("arraybuffer")));
    return "saved";
  } finally {
    host.remove();
    for (const u of blobUrls) URL.revokeObjectURL(u);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n");
}

function mimeOf(ref: string): string {
  const ext = extOf(ref);
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/** Word 兼容的基础排版（Word 只认得一部分 CSS，保持简单） */
const WORD_CSS = [
  'body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.7;color:#111111}',
  "h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13.5pt}",
  "img{max-width:100%}",
  "pre{background:#f6f6f6;border:1px solid #dddddd;padding:8pt;white-space:pre-wrap;font-family:Consolas,Menlo,monospace;font-size:10pt}",
  "code{font-family:Consolas,Menlo,monospace;background:#f2f2f2}",
  "blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3pt solid #bbbbbb;color:#555555}",
  "table{border-collapse:collapse}th,td{border:1px solid #999999;padding:4pt 8pt}",
].join("");

/**
 * 导出 Word：MHTML 格式的 .doc——HTML 正文 + 图片 base64 内嵌在一个 MIME 文档里，
 * Word / WPS 直接打开，图片不依赖外部文件（老经典方案，兼容性最好）。
 */
export async function exportNoteAsDoc(note: Pick<Note, "format" | "content" | "title">, dataDir: string): Promise<ExportResult> {
  const target = await saveDialog({
    defaultPath: `${safeFileName(note.title)}.doc`,
    filters: [{ name: "Word 文档", extensions: ["doc"] }],
  });
  if (!target) return "cancelled";

  const assets = await loadAssets(dataDir, note.content);
  const mhtRef = (ref: string) => `file:///noteassets/${ref.slice("assets/".length)}`;
  const html =
    `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title><style>${WORD_CSS}</style></head>` +
    `<body>${bodyHtmlForExport(note, ref => (assets.has(ref) ? mhtRef(ref) : ""))}</body></html>`;

  const boundary = `----=_NoteExport_${Date.now().toString(36)}`;
  const part = (contentType: string, location: string, b64: string) =>
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${location}\r\n\r\n${wrap76(b64)}\r\n`;

  const parts: string[] = [
    part("text/html; charset=\"utf-8\"", "file:///note/note.html", bytesToBase64(new TextEncoder().encode(html))),
  ];
  for (const [ref, bytes] of assets) {
    parts.push(part(mimeOf(ref), mhtRef(ref), bytesToBase64(bytes)));
  }

  const mht = [
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    "This document is formatted in MHTML.",
    ...parts,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  await writeTextFile(target, mht);
  return "saved";
}
