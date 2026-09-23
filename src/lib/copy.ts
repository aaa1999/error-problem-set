import { join } from "@tauri-apps/api/path";
import { exists, readFile } from "@tauri-apps/plugin-fs";
import type { Block, Folder, Mistake } from "../types";
import { folderPathName } from "./folders";

/**
 * 一键复制整道错题：题目（含图片）+ 选项（含正确答案）+ 解析（含图片）+ 标签 + 所属文件夹。
 * 富文本（text/html）优先——图片以 base64 data URL 内嵌，粘贴到 Word/笔记/邮件里图随文走；
 * 剪贴板不支持富文本时退化为纯文本（图片位置以 [图片] 占位）。
 */

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 图片文件 → data URL；文件缺失返回 null（用占位符） */
async function assetDataUrl(assetsDir: string, hash: string, ext: string): Promise<string | null> {
  const path = await join(assetsDir, `${hash}.${ext}`);
  if (!(await exists(path))) return null;
  try {
    const bytes = await readFile(path);
    let bin = "";
    const chunk = 0x8000; // String.fromCharCode 参数上限，分块转
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:${MIME[ext] ?? "application/octet-stream"};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

function metaText(m: Mistake, folders: Folder[]): string {
  const parts: string[] = [];
  if (m.tags.length > 0) parts.push(`标签：${m.tags.join("、")}`);
  const paths = m.folderIds.map(id => folderPathName(folders, id)).filter(p => p !== "未分类");
  if (paths.length > 0) parts.push(`文件夹：${paths.join("、")}`);
  return parts.join("　");
}

/** 复制范围：question = 只复制题目；all = 题目 + 选项 + 解析 + 标签 + 文件夹 */
export type CopyScope = "question" | "all";

/** 纯文本版（图片以 [图片] 占位），作为富文本不可用时的兜底与 text/plain 分量 */
export function mistakeToText(m: Mistake, folders: Folder[], scope: CopyScope = "all"): string {
  const blocks = (bs: Block[]) => bs.map(b => (b.type === "text" ? b.text : "[图片]")).join("\n");
  const lines: string[] = ["【题目】", blocks(m.question)];
  if (scope === "all") {
    if (m.options.length > 0) {
      lines.push("", "【选项】");
      m.options.forEach((o, i) => {
        lines.push(`${LETTERS[i] ?? i + 1}. ${o}${m.answer === i ? "　✓ 正确答案" : ""}`);
      });
    }
    lines.push("", "【解析】", blocks(m.analysis));
    const meta = metaText(m, folders);
    if (meta) lines.push("", meta);
  }
  return lines.join("\n");
}

/** 富文本版：图片内嵌 data URL，粘贴到支持 HTML 的地方图随文走 */
export async function mistakeToHtml(
  m: Mistake,
  folders: Folder[],
  assetsDir: string,
  scope: CopyScope = "all",
): Promise<string> {
  const renderBlocks = async (bs: Block[]) =>
    (
      await Promise.all(
        bs.map(async b => {
          if (b.type === "text") return `<p style="margin:4px 0;white-space:pre-wrap">${escapeHtml(b.text)}</p>`;
          const url = await assetDataUrl(assetsDir, b.hash, b.ext);
          return url
            ? `<img src="${url}" style="max-width:100%;border-radius:6px;margin:4px 0" />`
            : `<p style="color:#999;margin:4px 0">[图片缺失]</p>`;
        }),
      )
    ).join("");

  const h = (t: string) => `<h4 style="margin:12px 0 4px;font-size:14px">${t}</h4>`;
  let html = `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7">`;
  html += h("题目") + (await renderBlocks(m.question));
  if (scope === "all") {
    if (m.options.length > 0) {
      html += h("选项") + `<ul style="margin:4px 0;padding-left:22px;list-style:none">`;
      m.options.forEach((o, i) => {
        const correct = m.answer === i;
        html += `<li style="margin:3px 0;${correct ? "color:#2e7d32;font-weight:600" : ""}">${LETTERS[i] ?? i + 1}. ${escapeHtml(o)}${correct ? "　✓ 正确答案" : ""}</li>`;
      });
      html += `</ul>`;
    }
    html += h("解析") + (await renderBlocks(m.analysis));
    const meta = metaText(m, folders);
    if (meta) html += `<p style="color:#888;font-size:12px;margin-top:10px">${escapeHtml(meta)}</p>`;
  }
  return html + `</div>`;
}

export type CopyResult = "rich" | "text";

/** 复制到剪贴板：优先富文本（text/html + text/plain 双分量），失败退回纯文本 */
export async function copyMistake(
  m: Mistake,
  folders: Folder[],
  assetsDir: string,
  scope: CopyScope = "all",
): Promise<CopyResult> {
  const text = mistakeToText(m, folders, scope);
  try {
    const html = await mistakeToHtml(m, folders, assetsDir, scope);
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return "rich";
    }
  } catch {
    // 富文本写入失败（环境不支持/权限）→ 纯文本兜底
  }
  await navigator.clipboard.writeText(text);
  return "text";
}
