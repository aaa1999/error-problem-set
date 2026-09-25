package com.errorbook.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.util.Base64
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.content.FileProvider
import java.io.File
import java.util.Locale

// MARK: - 笔记导出（对应桌面端 src/lib/noteExport.ts、iOS 端 NoteExporter.swift）
// PDF：HTML 经 WebView + 系统打印框架原生分页渲染（文字可选中），打印面板里可选「保存为 PDF」；
// Word：MHTML 格式 .doc（HTML + 图片 base64 内嵌），Word / WPS 直接打开。

private fun safeFileName(title: String): String {
    val cleaned = title.replace(Regex("[\\\\/:*?\"<>|\\r\\n]+"), "_").trim()
    return cleaned.ifEmpty { "笔记" }
}

/** 读取笔记引用到的全部图片，ref → 字节；缺文件跳过 */
private fun loadAssets(dataDir: File, content: String): Map<String, ByteArray> {
    val map = mutableMapOf<String, ByteArray>()
    for (ref in collectAssetRefs(content)) {
        val f = File(dataDir, ref) // ref 本身就是 assets/xxx.png
        if (f.exists()) map[ref] = f.readBytes()
    }
    return map
}

/** 生成导出正文 HTML：markdown 先渲染，assets 引用按 map 换地址；标题按需补一个 h1 */
fun bodyHtmlForExport(note: Note, map: (String) -> String): String {
    val inner = when (note.format) {
        NoteFormat.MARKDOWN -> Markdown.render(note.content) { ref -> map(ref) }
        NoteFormat.WORD -> sanitizeLite(Markdown.mapAssetsInHtml(note.content) { ref -> map(ref) })
    }
    val title = note.title.trim()
    val startsWithHeading = note.format == NoteFormat.MARKDOWN &&
        Regex("^\\s{0,3}#{1,6}\\s+\\S").containsMatchIn(note.content)
    val titleHtml = if (title.isNotEmpty() && !startsWithHeading) "<h1>${escapeHtml(title)}</h1>\n" else ""
    return titleHtml + inner
}

private fun dataUrl(data: ByteArray, ext: String): String {
    val mime = "image/" + (if (ext == "jpg") "jpeg" else ext)
    return "data:$mime;base64," + Base64.encodeToString(data, Base64.NO_WRAP)
}

private fun exportHtml(note: Note, dataDir: File): String {
    val assets = loadAssets(dataDir, note.content)
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
        "body{font-family:system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif;font-size:11pt;line-height:1.7;color:#111}" +
        "img{max-width:100%}" +
        "pre{background:#f6f6f6;border:0.5pt solid #ddd;padding:8pt;white-space:pre-wrap;font-family:Menlo,monospace;font-size:10pt}" +
        "code{font-family:Menlo,monospace;background:#f2f2f2}" +
        "blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3pt solid #bbb;color:#555}" +
        "table{border-collapse:collapse}th,td{border:0.5pt solid #999;padding:4pt 8pt}" +
        "</style></head><body>" +
        bodyHtmlForExport(note) { ref -> assets[ref]?.let { dataUrl(it, extOf(ref)) } ?: "" } +
        "</body></html>"
}

object NoteExporter {

    private fun exportsDir(context: Context): File =
        File(context.cacheDir, "exports").apply { mkdirs() }

    /**
     * 导出 PDF：WebView 渲染后交给系统打印框架（A4 分页、文字可选中），
     * 用户在打印面板选「保存为 PDF」即可落盘/分享。
     */
    fun exportPdf(activity: Activity, note: Note, dataDir: File) {
        val html = exportHtml(note, dataDir)
        val decor = activity.window.decorView as? ViewGroup ?: return
        val webView = WebView(activity)
        webView.visibility = android.view.View.INVISIBLE // 不可见但保持布局，供打印适配器量取内容
        webView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        decor.addView(webView)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                view.post {
                    // 等一帧让图片（data URL）完成布局再进打印
                    view.postDelayed({
                        try {
                            val printAttrs = PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                .build()
                            val printManager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
                            printManager.print(
                                safeFileName(note.title),
                                view.createPrintDocumentAdapter(safeFileName(note.title)),
                                printAttrs,
                            )
                        } finally {
                            Handler(Looper.getMainLooper()).postDelayed({ decor.removeView(view) }, 8_000)
                        }
                    }, 500)
                }
            }
        }
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    /** 导出 Word：MHTML 的 .doc——HTML 正文 + 图片 base64 内嵌在一个 MIME 文档里；返回临时文件 */
    fun exportDoc(note: Note, dataDir: File, outDir: File): File {
        val assets = loadAssets(dataDir, note.content)

        fun mhtRef(ref: String) = "file:///noteassets/${ref.removePrefix("assets/")}"
        val wordCss = listOf(
            "body{font-family:\"PingFang SC\",\"Microsoft YaHei\",sans-serif;font-size:11pt;line-height:1.7;color:#111111}",
            "h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13.5pt}",
            "img{max-width:100%}",
            "pre{background:#f6f6f6;border:1pt solid #dddddd;padding:8pt;white-space:pre-wrap;font-family:Consolas,Menlo,monospace;font-size:10pt}",
            "code{font-family:Consolas,Menlo,monospace;background:#f2f2f2}",
            "blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3pt solid #bbbbbb;color:#555555}",
            "table{border-collapse:collapse}th,td{border:1pt solid #999999;padding:4pt 8pt}",
        ).joinToString("")
        val html =
            "<!DOCTYPE html><html xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:w=\"urn:schemas-microsoft-com:office:word\">" +
                "<head><meta charset=\"utf-8\"><title>${escapeHtml(note.title)}</title><style>$wordCss</style></head>" +
                "<body>${bodyHtmlForExport(note) { ref -> if (assets.containsKey(ref)) mhtRef(ref) else "" }}</body></html>"

        val boundary = "----=_NoteExport_" + java.lang.Long.toString(System.currentTimeMillis() / 1000, 36)

        fun part(contentType: String, location: String, b64: String): String {
            val sb = StringBuilder()
            sb.append("--").append(boundary).append("\r\n")
            sb.append("Content-Type: ").append(contentType).append("\r\n")
            sb.append("Content-Transfer-Encoding: base64\r\n")
            sb.append("Content-Location: ").append(location).append("\r\n\r\n")
            var idx = 0
            while (idx < b64.length) {
                val end = minOf(idx + 76, b64.length)
                sb.append(b64, idx, end)
                sb.append("\r\n")
                idx = end
            }
            return sb.toString()
        }

        val sb = StringBuilder()
        sb.append("MIME-Version: 1.0\r\n")
        sb.append("Content-Type: multipart/related; boundary=\"").append(boundary).append("\"\r\n\r\n")
        sb.append("This document is formatted in MHTML.\r\n")
        sb.append(part("text/html; charset=\"utf-8\"", "file:///note/note.html", Base64.encodeToString(html.toByteArray(), Base64.NO_WRAP)))
        for ((ref, data) in assets) {
            val ext = extOf(ref)
            val mime = "image/" + (if (ext == "jpg") "jpeg" else ext)
            sb.append(part(mime, mhtRef(ref), Base64.encodeToString(data, Base64.NO_WRAP)))
        }
        sb.append("--").append(boundary).append("--\r\n")

        val out = File(outDir, "${safeFileName(note.title)}.doc")
        out.writeText(sb.toString())
        return out
    }

    /** 用系统分享面板送出导出文件 */
    fun shareFile(context: Context, file: File, mime: String) {
        val uri: Uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, file.name))
    }
}
