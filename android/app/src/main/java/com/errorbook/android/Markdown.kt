package com.errorbook.android

// MARK: - Markdown 渲染与文本工具（对应桌面端 src/lib/markdown.ts、iOS 端 Markdown.swift）
// 自带一个小型 GFM 子集渲染器：标题/粗斜删/行内代码/围栏代码/引用/有序无序列表/任务列表/
// 表格/链接/图片/分隔线；单个换行渲染为 <br>（与桌面端 marked { gfm, breaks } 一致）。

private val assetRefPattern = Regex("assets/([A-Za-z0-9_-]+\\.(?:png|jpe?g|webp|gif|bmp|avif))", RegexOption.IGNORE_CASE)

/** 收集一段内容（markdown 源文本或富文本 HTML）里引用到的全部 assets 相对路径 */
fun collectAssetRefs(content: String): List<String> =
    assetRefPattern.findAll(content).map { it.value }.distinct().toList()

fun escapeHtml(s: String): String = s
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")

/** 最低限度消毒：挡住粘贴内容带来的事件处理器与脚本 */
fun sanitizeLite(html: String): String {
    var out = html
    val patterns = listOf(
        Regex("(?is)<(script|iframe|object|embed)[\\s\\S]*?</\\1\\s*>"),
        Regex("(?is)<(script|iframe|object|embed)\\b[^>]*/?>"),
        Regex("(?i)\\son\\w+\\s*=\\s*\"[^\"]*\""),
        Regex("(?i)\\son\\w+\\s*=\\s*'[^']*'"),
        Regex("(?i)\\son\\w+\\s*=\\s*[^\\s>]+"),
        Regex("(?i)javascript:"),
    )
    for (p in patterns) out = out.replace(p, "")
    return out
}

object Markdown {

    /** markdown → HTML；mapAsset 把 assets/xxx.png 相对引用换成目标地址，缺省保持原样 */
    fun render(md: String, mapAsset: ((String) -> String)? = null): String {
        val lines = md.replace("\r\n", "\n").split("\n")
        val html = StringBuilder()
        var i = 0
        val n = lines.size

        while (i < n) {
            val line = lines[i]

            // 围栏代码块
            if (fenceMarker(line) != null) {
                val code = StringBuilder()
                i++
                while (i < n && fenceMarker(lines[i]) == null) {
                    code.appendLine(lines[i])
                    i++
                }
                i++ // 跳过收尾围栏
                if (code.isNotEmpty()) code.setLength(code.length - 1) // 去掉末尾换行
                html.append("<pre><code>").append(escapeHtml(code.toString())).append("</code></pre>\n")
                continue
            }

            // 空行
            if (line.isBlank()) {
                i++
                continue
            }

            // 分隔线
            if (isHr(line)) {
                html.append("<hr>\n")
                i++
                continue
            }

            // 标题（#~######）
            heading(line)?.let { (level, text) ->
                html.append("<h$level>").append(inline(text)).append("</h$level>\n")
                i++
                return@let
            } ?: run {
                // 引用块
                if (line.startsWith(">")) {
                    val quoted = mutableListOf<String>()
                    while (i < n && lines[i].startsWith(">")) {
                        val l = lines[i]
                        quoted.add(l.drop(if (l.startsWith("> ")) 2 else 1))
                        i++
                    }
                    html.append("<blockquote>\n").append(render(quoted.joinToString("\n"))).append("</blockquote>\n")
                    return@run
                }

                // 表格（当前行含 | 且下一行是分隔行）
                if (line.contains("|") && i + 1 < n && isTableDivider(lines[i + 1])) {
                    val headerCells = splitTableRow(line)
                    val aligns = splitTableRow(lines[i + 1]).map { cellAlign(it) }
                    i += 2
                    val body = mutableListOf<String>()
                    while (i < n && lines[i].contains("|") && lines[i].isNotBlank()) {
                        body.add(lines[i])
                        i++
                    }
                    html.append("<table><thead><tr>")
                    headerCells.forEachIndexed { idx, cell ->
                        val a = if (idx < aligns.size) aligns[idx] else ""
                        html.append("<th$a>").append(inline(cell)).append("</th>")
                    }
                    html.append("</tr></thead><tbody>")
                    for (row in body) {
                        html.append("<tr>")
                        splitTableRow(row).forEachIndexed { idx, cell ->
                            val a = if (idx < aligns.size) aligns[idx] else ""
                            html.append("<td$a>").append(inline(cell)).append("</td>")
                        }
                        html.append("</tr>")
                    }
                    html.append("</tbody></table>\n")
                    return@run
                }

                // 列表（ul/ol/任务列表，两空格一级缩进）
                listMarker(line)?.let { marker ->
                    val items = mutableListOf<Pair<Boolean?, String>>() // checked?, content
                    while (i < n) {
                        val m = listMarker(lines[i]) ?: break
                        var text = m.second
                        var checked: Boolean? = null
                        if (!marker.first) {
                            taskMarker(m.second)?.let { task ->
                                checked = task.first
                                text = task.second
                            }
                        }
                        // 收集该列表项的续行
                        val segs = mutableListOf(text)
                        i++
                        while (i < n && lines[i].isNotBlank() && listMarker(lines[i]) == null && !lines[i].startsWith(">")) {
                            segs.add(lines[i].trim())
                            i++
                        }
                        items.add(checked to segs.joinToString("\n"))
                    }
                    val tag = if (marker.first) "ol" else "ul"
                    html.append("<$tag>\n")
                    for ((checked, content) in items) {
                        if (checked != null) {
                            html.append("<li><input type=\"checkbox\" disabled").append(if (checked) " checked" else "")
                                .append("> ").append(inline(content)).append("</li>\n")
                        } else {
                            html.append("<li>").append(inline(content)).append("</li>\n")
                        }
                    }
                    html.append("</$tag>\n")
                    return@let
                } ?: run {
                    // 段落：连续的非结构行合并，单个换行渲染为 <br>
                    val para = mutableListOf<String>()
                    while (i < n) {
                        val l = lines[i]
                        if (l.isBlank()) break
                        if (fenceMarker(l) != null || heading(l) != null || isHr(l) || l.startsWith(">") || listMarker(l) != null) break
                        if (l.contains("|") && i + 1 < n && isTableDivider(lines[i + 1])) break
                        para.add(l)
                        i++
                    }
                    html.append("<p>").append(para.joinToString("<br>\n") { inline(it) }).append("</p>\n")
                }
            }
        }

        var body = html.toString()
        if (mapAsset != null) {
            body = mapAssetsInHtml(body) { ref -> mapAsset(if (ref.startsWith("assets/")) ref else "assets/$ref") }
        }
        return sanitizeLite(body)
    }

    /** 富文本 HTML 里的 assets 引用按 map 换成目标地址 */
    fun mapAssetsInHtml(html: String, map: (String) -> String): String {
        val matches = assetRefPattern.findAll(html).toList()
        var out = html
        for (m in matches.asReversed()) {
            out = out.replaceRange(m.range, map(m.value))
        }
        return out
    }

    // MARK: 行内规则（先转义，再用占位符保护行内代码）

    private val inlineCodeRegex = Regex("(`+)([\\s\\S]*?)\\1")
    private val imgRegex = Regex("!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
    private val linkRegex = Regex("\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
    private val boldItalic1 = Regex("\\*\\*\\*([^*]+)\\*\\*\\*")
    private val boldItalic2 = Regex("___([^_]+)___")
    private val bold1 = Regex("\\*\\*([^*]+)\\*\\*")
    private val bold2 = Regex("__([^_]+)__")
    private val italic1 = Regex("\\*([^*\\n]+)\\*")
    private val italic2 = Regex("(?<!\\w)_([^_\\n]+)_(?!\\w)")
    private val strike = Regex("~~([^~]+)~~")
    private val autolink = Regex("(?<![\"'=\\(>])(https?://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]+)")

    private fun inline(raw: String): String {
        var s = escapeHtml(raw)
        // 行内代码先摘出来（占位符保护，避免内部内容被其他规则处理）
        val codes = mutableListOf<String>()
        inlineCodeRegex.findAll(s).toList().asReversed().forEach { m ->
            val inner = m.groupValues[2].replace("\n", " ")
            codes.add("<code>$inner</code>")
            s = s.replaceRange(m.range, "\u0000${codes.size - 1}\u0000")
        }

        s = imgRegex.replace(s) { "<img src=\"${it.groupValues[2]}\" alt=\"${it.groupValues[1]}\">" }
        s = linkRegex.replace(s) { "<a href=\"${it.groupValues[2]}\">${it.groupValues[1]}</a>" }
        s = boldItalic1.replace(s) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        s = boldItalic2.replace(s) { "<strong><em>${it.groupValues[1]}</em></strong>" }
        s = bold1.replace(s) { "<strong>${it.groupValues[1]}</strong>" }
        s = bold2.replace(s) { "<strong>${it.groupValues[1]}</strong>" }
        s = italic1.replace(s) { "<em>${it.groupValues[1]}</em>" }
        s = italic2.replace(s) { "<em>${it.groupValues[1]}</em>" }
        s = strike.replace(s) { "<del>${it.groupValues[1]}</del>" }
        s = autolink.replace(s) { "<a href=\"${it.groupValues[1]}\">${it.groupValues[1]}</a>" }
        // 还原行内代码
        for ((idx, code) in codes.withIndex()) {
            s = s.replace("\u0000$idx\u0000", code)
        }
        return s
    }

    // MARK: 块级识别

    private fun fenceMarker(line: String): String? {
        val t = line.trim()
        return when {
            t.startsWith("```") -> "```"
            t.startsWith("~~~") -> "~~~"
            else -> null
        }
    }

    private fun isHr(line: String): Boolean {
        val t = line.trim()
        if (t.length < 3) return false
        for (m in listOf("-", "*", "_")) {
            if (t.all { it.toString() == m || it == ' ' } && t.count { it.toString() == m } >= 3) return true
        }
        return false
    }

    private fun heading(line: String): Pair<Int, String>? {
        var level = 0
        while (level < line.length && level < 6 && line[level] == '#') level++
        if (level < 1 || level > 6) return null
        val t = line.drop(level)
        if (!(t.startsWith(" ") || t.isEmpty())) return null
        return level to t.trim()
    }

    private fun listMarker(line: String): Pair<Boolean, String>? {
        var indent = 0
        for (ch in line) {
            if (ch == ' ') indent++
            else if (ch == '\t') indent += 4
            else break
        }
        // 仅支持顶层列表（嵌套列表场景少，保持简单）
        if (indent >= 2) return null
        val body = line.drop(indent)
        if (body.startsWith("- ") || body.startsWith("* ") || body.startsWith("+ ")) {
            return false to body.drop(2)
        }
        if (body.startsWith("-") || body.startsWith("*") || body.startsWith("+")) {
            val rest = body.drop(1)
            if (rest.isEmpty() || rest.first() == ' ') return false to rest.trim()
        }
        // 有序：1. / 1)
        var dl = 0
        while (dl < body.length && body[dl].isDigit()) dl++
        if (dl in 1..9) {
            val after = body.drop(dl)
            if (after.startsWith(". ") || after.startsWith(") ")) return true to after.drop(2)
            if (after == "." || after == ")") return true to ""
        }
        return null
    }

    private fun taskMarker(content: String): Pair<Boolean, String>? {
        if (content.startsWith("[ ] ")) return false to content.drop(4)
        if (content.startsWith("[x] ") || content.startsWith("[X] ")) return true to content.drop(4)
        return null
    }

    private fun isTableDivider(line: String): Boolean {
        val t = line.trim()
        if (!t.contains("-") || !t.contains("|")) return false
        val cells = splitTableRow(t)
        if (cells.isEmpty()) return false
        return cells.all { cell ->
            val c = cell.trim()
            if (c.isEmpty()) return@all false
            val core = c.trim(':')
            core.isNotEmpty() && core.all { it == '-' }
        }
    }

    private fun cellAlign(cell: String): String {
        val c = cell.trim()
        val left = c.startsWith(":")
        val right = c.endsWith(":")
        if (left && right) return " style=\"text-align:center\""
        if (right) return " style=\"text-align:right\""
        return ""
    }

    private fun splitTableRow(line: String): List<String> {
        var t = line.trim()
        if (t.startsWith("|")) t = t.drop(1)
        if (t.endsWith("|")) t = t.dropLast(1)
        return t.split("|").map { it.trim() }
    }
}

// MARK: - 笔记摘要（对应 noteExcerpt）

private fun decodeEntities(s: String): String = s
    .replace("&nbsp;", " ")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&amp;", "&")

private val mdCodeBlockTrim = Regex("(?s)```[\\s\\S]*?```")
private val mdImgTrim = Regex("!\\[[^\\]]*\\]\\([^)]*\\)")
private val mdHeadingTrim = Regex("(?m)^\\s{0,3}#{1,6}\\s+.*$")
private val wordInlineTags = Regex("</?(?:b|strong|i|em|u|s|strike|span|code|sub|sup|font|a)\\b[^>]*>", RegexOption.IGNORE_CASE)
private val anyTag = Regex("<[^>]+>")
private val whitespaces = Regex("\\s+")

/** 列表摘要：取第一段有字的纯文本，截 80 字 */
fun noteExcerpt(note: Note): String {
    val text: String = if (note.format == NoteFormat.MARKDOWN) {
        note.content
            .replace(mdCodeBlockTrim, " ")
            .replace(mdImgTrim, " ")
            .replace(mdHeadingTrim, "")
            .trim()
    } else {
        decodeEntities(
            note.content.replace(wordInlineTags, "").replace(anyTag, " ")
        ).replace(whitespaces, " ").trim()
    }
    return if (text.length > 80) text.take(80) + "…" else text
}

/** 笔记是否完全没有内容（没标题、没文字、没图） */
fun isNoteEmpty(title: String, content: String, format: NoteFormat): Boolean {
    if (title.trim().isNotEmpty()) return false
    if (collectAssetRefs(content).isNotEmpty()) return false
    val text = if (format == NoteFormat.MARKDOWN) content else content.replace(anyTag, " ")
    return text.replace(" ", "").replace("\u00A0", "").trim().isEmpty()
}
