import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readFile, writeFile } from "@tauri-apps/plugin-fs";
import type { ImageBlock } from "../types";

/** 本地路径 → webview 可显示的 URL；统一成正斜杠，避免 Windows 下混用分隔符 */
export function fileSrc(path: string): string {
  return convertFileSrc(path.replace(/\\/g, "/"));
}

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

/** 取扩展名（小写，不带点） */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-1", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // webview 上下文异常时退化为 FNV 变体哈希，仅用于本地去重
    let h1 = (0x811c9dc5 ^ bytes.length) >>> 0;
    let h2 = 0x9dc5811c;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
      h2 = Math.imul(h2 ^ (bytes[i] + i), 2654435761) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
}

/** 图片统一入库：按内容哈希命名存进 assets/，重复图片只存一份 */
export async function saveImage(dataDir: string, bytes: Uint8Array, ext: string): Promise<ImageBlock> {
  const hash = await hashBytes(bytes);
  const safeExt = IMAGE_EXTS.includes(ext) ? ext : "png";
  const path = await join(dataDir, "assets", `${hash}.${safeExt}`);
  if (!(await exists(path))) await writeFile(path, bytes);
  return { type: "image", hash, ext: safeExt };
}

export function assetUrlFor(assetsDir: string, b: ImageBlock): string {
  return fileSrc(`${assetsDir}/${b.hash}.${b.ext}`);
}

/** 从本地文件路径导入图片，非图片返回 null */
export async function importImageFile(dataDir: string, filePath: string): Promise<ImageBlock | null> {
  const ext = extOf(filePath);
  if (!IMAGE_EXTS.includes(ext)) return null;
  const bytes = await readFile(filePath);
  return saveImage(dataDir, bytes, ext);
}

/** 从剪贴板/拖拽的 Blob 导入图片 */
export async function importBlobAsImage(dataDir: string, blob: Blob): Promise<ImageBlock> {
  let ext = (blob.type.split("/")[1] ?? "png").toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) ext = "png";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return saveImage(dataDir, bytes, ext);
}
