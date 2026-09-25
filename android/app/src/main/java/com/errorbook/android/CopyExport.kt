package com.errorbook.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Base64
import java.io.File

// MARK: - 一键复制整道错题（对应桌面端 src/lib/copy.ts、iOS 端 CopyExport.swift）
// 题目（含图片）+ 选项（含正确答案）+ 解析（含图片）+ 标签 + 所属文件夹。
// 剪贴板用 ClipData.newHtmlText 同时带纯文本与 HTML 两个分量：HTML 里图片以 base64 内嵌，
// 粘贴到支持富文本的地方（部分备忘录 / Word / WPS / 邮件）图随文走，纯文本场景落到纯文本版。

private val copyMime = mapOf(
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "webp" to "image/webp",
    "gif" to "image/gif",
    "bmp" to "image/bmp",
    "avif" to "image/avif",
)

private fun copyLetter(i: Int): String =
    if (i < 26) "${'A' + i}" else "${i + 1}"

private fun copyEscapeHtml(s: String): String = s
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")

private fun metaText(m: Mistake, folders: List<Folder>): String {
    val parts = mutableListOf<String>()
    if (m.tags.isNotEmpty()) parts.add("标签：${m.tags.joinToString("、")}")
    val paths = m.folderIds.map { folderPathName(folders, it) }.filter { it != "未分类" }
    if (paths.isNotEmpty()) parts.add("文件夹：${paths.joinToString("、")}")
    return parts.joinToString("　")
}

/** 图片 → data URL；文件缺失返回 null（用占位） */
private fun assetDataUrl(dataDir: File, hash: String, ext: String): String? {
    val file = ImageStore.assetFile(dataDir, hash, ext)
    if (!file.exists()) return null
    val data = file.readBytes()
    if (data.isEmpty()) return null
    val mime = copyMime[ext.lowercase()] ?: "application/octet-stream"
    return "data:$mime;base64," + Base64.encodeToString(data, Base64.NO_WRAP)
}

/** 纯文本版（图片以 [图片] 占位）；questionOnly = 只复制题目 */
fun mistakePlainText(m: Mistake, folders: List<Folder>, questionOnly: Boolean = false): String {
    fun blocks(bs: List<Block>) = bs.joinToString("\n") { b ->
        when (b) {
            is Block.Text -> b.text
            is Block.Image -> "[图片]"
        }
    }
    val lines = mutableListOf("【题目】", blocks(m.question))
    if (!questionOnly) {
        if (m.options.isNotEmpty()) {
            lines.add("")
            lines.add("【选项】")
            m.options.forEachIndexed { i, o ->
                lines.add("${copyLetter(i)}. $o${if (m.answer == i) "　✓ 正确答案" else ""}")
            }
        }
        lines.add("")
        lines.add("【解析】")
        lines.add(blocks(m.analysis))
        val meta = metaText(m, folders)
        if (meta.isNotEmpty()) {
            lines.add("")
            lines.add(meta)
        }
    }
    return lines.joinToString("\n")
}

/** 富文本版（图片 base64 内嵌）；questionOnly = 只复制题目 */
fun mistakeHtml(m: Mistake, folders: List<Folder>, dataDir: File, questionOnly: Boolean = false): String {
    fun renderBlocks(bs: List<Block>): String = bs.joinToString("") { b ->
        when (b) {
            is Block.Text -> "<p style=\"margin:4px 0;white-space:pre-wrap\">${copyEscapeHtml(b.text)}</p>"
            is Block.Image -> {
                val url = assetDataUrl(dataDir, b.hash, b.ext)
                if (url != null) {
                    "<img src=\"$url\" style=\"max-width:100%;border-radius:6px;margin:4px 0\" />"
                } else {
                    "<p style=\"color:#999;margin:4px 0\">[图片缺失]</p>"
                }
            }
        }
    }
    fun h(t: String) = "<h4 style=\"margin:12px 0 4px;font-size:14px\">$t</h4>"

    var html = "<div style=\"font-family:system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif;font-size:14px;line-height:1.7\">"
    html += h("题目") + renderBlocks(m.question)
    if (!questionOnly) {
        if (m.options.isNotEmpty()) {
            html += h("选项") + "<ul style=\"margin:4px 0;padding-left:22px;list-style:none\">"
            m.options.forEachIndexed { i, o ->
                val correct = m.answer == i
                html += "<li style=\"margin:3px 0;${if (correct) "color:#2e7d32;font-weight:600" else ""}\">" +
                    "${copyLetter(i)}. ${copyEscapeHtml(o)}${if (correct) "　✓ 正确答案" else ""}</li>"
            }
            html += "</ul>"
        }
        html += h("解析") + renderBlocks(m.analysis)
        val meta = metaText(m, folders)
        if (meta.isNotEmpty()) {
            html += "<p style=\"color:#888;font-size:12px;margin-top:10px\">${copyEscapeHtml(meta)}</p>"
        }
    }
    return "$html</div>"
}

/** 写入剪贴板：纯文本 + HTML 双分量，粘贴目标各取所需；questionOnly = 只复制题目 */
fun copyMistakeToClipboard(context: Context, m: Mistake, folders: List<Folder>, dataDir: File, questionOnly: Boolean = false) {
    val text = mistakePlainText(m, folders, questionOnly)
    val html = mistakeHtml(m, folders, dataDir, questionOnly)
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newHtmlText("错题本", text, html))
}
