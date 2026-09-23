import Foundation

// MARK: - Markdown 渲染与文本工具（对应桌面端 src/lib/markdown.ts）
// 自带一个小型 GFM 子集渲染器：标题/粗斜删/行内代码/围栏代码/引用/有序无序列表/任务列表/
// 表格/链接/图片/分隔线；单个换行渲染为 <br>（与桌面端 marked { gfm, breaks } 一致）。

let assetRefPattern = try! NSRegularExpression(
  pattern: "assets/([A-Za-z0-9_-]+\\.(?:png|jpe?g|webp|gif|bmp|avif))",
  options: [.caseInsensitive]
)

/// 收集一段内容（markdown 源文本或富文本 HTML）里引用到的全部 assets 相对路径
func collectAssetRefs(_ content: String) -> [String] {
  let ns = content as NSString
  let matches = assetRefPattern.matches(in: content, range: NSRange(location: 0, length: ns.length))
  var out = Set<String>()
  for m in matches { out.insert(ns.substring(with: m.range)) }
  return Array(out)
}

func escapeHtml(_ s: String) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
    .replacingOccurrences(of: "\"", with: "&quot;")
}

/// 最低限度消毒：挡住粘贴内容带来的事件处理器与脚本
func sanitizeLite(_ html: String) -> String {
  var out = html
  let patterns = [
    "(?is)<(script|iframe|object|embed)[\\s\\S]*?</\\1\\s*>",
    "(?is)<(script|iframe|object|embed)\\b[^>]*/?>",
    "(?i)\\son\\w+\\s*=\\s*\"[^\"]*\"",
    "(?i)\\son\\w+\\s*=\\s*'[^']*'",
    "(?i)\\son\\w+\\s*=\\s*[^\\s>]+",
    "(?i)javascript:",
  ]
  for p in patterns {
    out = out.replacingOccurrences(
      of: p,
      with: "",
      options: .regularExpression
    )
  }
  return out
}

enum Markdown {

  /// markdown → HTML；mapAsset 把 assets/xxx.png 相对引用换成目标地址，缺省保持原样
  static func render(_ md: String, mapAsset: ((String) -> String)? = nil) -> String {
    let lines = md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var html: [String] = []
    var i = 0
    let n = lines.count

    while i < n {
      let line = lines[i]

      // 围栏代码块
      if fenceMarker(line) != nil {
        var code: [String] = []
        i += 1
        while i < n, fenceMarker(lines[i]) == nil {
          code.append(lines[i])
          i += 1
        }
        i += 1 // 跳过收尾围栏
        html.append("<pre><code>" + escapeHtml(code.joined(separator: "\n")) + "</code></pre>\n")
        continue
      }

      // 空行
      if line.trimmingCharacters(in: .whitespaces).isEmpty {
        i += 1
        continue
      }

      // 分隔线
      if isHr(line) {
        html.append("<hr>\n")
        i += 1
        continue
      }

      // 标题（#~######）
      if let (level, text) = heading(line) {
        html.append("<h\(level)>" + inline(text) + "</h\(level)>\n")
        i += 1
        continue
      }

      // 引用块
      if line.hasPrefix(">") {
        var quoted: [String] = []
        while i < n, lines[i].hasPrefix(">") {
          quoted.append(String(lines[i].dropFirst(lines[i].hasPrefix("> ") ? 2 : 1)))
          i += 1
        }
        html.append("<blockquote>\n" + render(quoted.joined(separator: "\n"), mapAsset: nil) + "</blockquote>\n")
        continue
      }

      // 表格（当前行含 | 且下一行是分隔行）
      if line.contains("|"), i + 1 < n, isTableDivider(lines[i + 1]) {
        let headerCells = splitTableRow(line)
        let aligns = splitTableRow(lines[i + 1]).map(cellAlign)
        i += 2
        var body: [String] = []
        while i < n, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
          body.append(lines[i])
          i += 1
        }
        var t = "<table><thead><tr>"
        for (idx, cell) in headerCells.enumerated() {
          let a = idx < aligns.count ? aligns[idx] : ""
          t += "<th\(a)>" + inline(cell) + "</th>"
        }
        t += "</tr></thead><tbody>"
        for row in body {
          t += "<tr>"
          for (idx, cell) in splitTableRow(row).enumerated() {
            let a = idx < aligns.count ? aligns[idx] : ""
            t += "<td\(a)>" + inline(cell) + "</td>"
          }
          t += "</tr>"
        }
        t += "</tbody></table>\n"
        html.append(t)
        continue
      }

      // 列表（ul/ol/任务列表，两空格一级缩进）
      if let marker = listMarker(line) {
        var items: [(checked: Bool?, content: String)] = []
        while i < n, let m = listMarker(lines[i]) {
          var text = m.content
          var checked: Bool? = nil
          if !marker.ordered, let task = taskMarker(m.content) {
            checked = task.0
            text = task.1
          }
          // 收集该列表项的续行
          var segs = [text]
          i += 1
          while i < n, lines[i].trimmingCharacters(in: .whitespaces).isEmpty == false,
                listMarker(lines[i]) == nil, !lines[i].hasPrefix(">") {
            // 缩进续行属于上一项
            segs.append(lines[i].trimmingCharacters(in: .whitespaces))
            i += 1
          }
          items.append((checked, segs.joined(separator: "\n")))
        }
        let tag = marker.ordered ? "ol" : "ul"
        var out = "<\(tag)>\n"
        for item in items {
          if let c = item.checked {
            out += "<li><input type=\"checkbox\" disabled\(c ? " checked" : "")> " + inline(item.content) + "</li>\n"
          } else {
            out += "<li>" + inline(item.content) + "</li>\n"
          }
        }
        out += "</\(tag)>\n"
        html.append(out)
        continue
      }

      // 段落：连续的非结构行合并，单个换行渲染为 <br>
      var para: [String] = []
      while i < n {
        let l = lines[i]
        if l.trimmingCharacters(in: .whitespaces).isEmpty { break }
        if fenceMarker(l) != nil || heading(l) != nil || isHr(l) || l.hasPrefix(">") || listMarker(l) != nil { break }
        if l.contains("|"), i + 1 < n, isTableDivider(lines[i + 1]) { break }
        para.append(l)
        i += 1
      }
      html.append("<p>" + para.map(inline).joined(separator: "<br>\n") + "</p>\n")
    }

    var body = html.joined()
    if let mapAsset {
      body = mapAssetsInHtml(body) { ref in
        mapAsset(ref.hasPrefix("assets/") ? ref : "assets/\(ref)")
      }
    }
    return sanitizeLite(body)
  }

  /// 富文本 HTML 里的 assets 引用按 map 换成目标地址
  static func mapAssetsInHtml(_ html: String, map: (String) -> String) -> String {
    let ns = html as NSString
    let out = NSMutableString(string: html)
    let matches = assetRefPattern.matches(in: html, range: NSRange(location: 0, length: ns.length))
    for m in matches.reversed() {
      let ref = ns.substring(with: m.range)
      out.replaceCharacters(in: m.range, with: map(ref))
    }
    return out as String
  }

  // MARK: 行内规则（先转义，再用占位符保护行内代码）

  private static func inline(_ raw: String) -> String {
    var s = escapeHtml(raw)
    // 行内代码先摘出来（占位符保护，避免内部内容被其他规则处理）
    var codes: [String] = []
    if let re = try? NSRegularExpression(pattern: "(`+)([\\s\\S]*?)\\1") {
      let ns = NSMutableString(string: s)
      let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
      for m in matches.reversed() {
        let full = ns.substring(with: m.range)
        let inner = String(full.dropFirst(1).dropLast(1)).replacingOccurrences(of: "\n", with: " ")
        codes.append("<code>" + inner + "</code>")
        ns.replaceCharacters(in: m.range, with: "\u{0}\(codes.count - 1)\u{0}")
      }
      s = ns as String
    }

    // 图片 ![alt](src)
    s = s.replacingOccurrences(
      of: "!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)",
      with: "<img src=\"$2\" alt=\"$1\">",
      options: .regularExpression
    )
    // 链接 [text](url)
    s = s.replacingOccurrences(
      of: "\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)",
      with: "<a href=\"$2\">$1</a>",
      options: .regularExpression
    )
    // 粗斜体
    s = s.replacingOccurrences(of: "\\*\\*\\*([^*]+)\\*\\*\\*", with: "<strong><em>$1</em></strong>", options: .regularExpression)
    s = s.replacingOccurrences(of: "___([^_]+)___", with: "<strong><em>$1</em></strong>", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*", with: "<strong>$1</strong>", options: .regularExpression)
    s = s.replacingOccurrences(of: "__([^_]+)__", with: "<strong>$1</strong>", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\*([^*\\n]+)\\*", with: "<em>$1</em>", options: .regularExpression)
    s = s.replacingOccurrences(of: "(?<!\\w)_([^_\\n]+)_(?!\\w)", with: "<em>$1</em>", options: [.regularExpression])
    s = s.replacingOccurrences(of: "~~([^~]+)~~", with: "<del>$1</del>", options: .regularExpression)
    // 自动链接 http(s)://…
    s = s.replacingOccurrences(
      of: "(?<![\"'=\\(>])(https?://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]+)",
      with: "<a href=\"$1\">$1</a>",
      options: [.regularExpression]
    )
    // 还原行内代码
    for (idx, code) in codes.enumerated() {
      s = s.replacingOccurrences(of: "\u{0}\(idx)\u{0}", with: code)
    }
    return s
  }

  // MARK: 块级识别

  private static func fenceMarker(_ line: String) -> String? {
    let t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("```") { return "```" }
    if t.hasPrefix("~~~") { return "~~~" }
    return nil
  }

  private static func isHr(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    guard t.count >= 3 else { return false }
    for m in ["-", "*", "_"] {
      if t.allSatisfy({ String($0) == m || $0 == " " }), t.filter { String($0) == m }.count >= 3 { return true }
    }
    return false
  }

  private static func heading(_ line: String) -> (Int, String)? {
    var t = line
    var level = 0
    while level < t.count, level < 6, t[t.index(t.startIndex, offsetBy: level)] == "#" { level += 1 }
    guard level >= 1, level <= 6 else { return nil }
    t = String(t.dropFirst(level))
    guard t.hasPrefix(" ") || t.isEmpty else { return nil }
    return (level, t.trimmingCharacters(in: .whitespaces))
  }

  private static func listMarker(_ line: String) -> (ordered: Bool, content: String)? {
    let t = line
    var indent = 0
    for ch in t {
      if ch == " " { indent += 1 } else if ch == "\t" { indent += 4 } else { break }
    }
    // 仅支持顶层列表（嵌套列表场景少，保持简单）
    guard indent < 2 else { return nil }
    let body = String(t.dropFirst(indent))
    if body.hasPrefix("- ") || body.hasPrefix("* ") || body.hasPrefix("+ ") {
      return (false, String(body.dropFirst(2)))
    }
    if body.hasPrefix("-") || body.hasPrefix("*") || body.hasPrefix("+") {
      let rest = body.dropFirst(1)
      if rest.isEmpty || rest.first == " " { return (false, String(rest).trimmingCharacters(in: .whitespaces)) }
    }
    // 有序：1. / 1)
    let digits = body.prefix { $0.isNumber }
    if !digits.isEmpty, digits.count <= 9 {
      let after = body.dropFirst(digits.count)
      if after.hasPrefix(". ") || after.hasPrefix(") ") {
        return (true, String(after.dropFirst(2)))
      }
      if after == "." || after == ")" {
        return (true, "")
      }
    }
    return nil
  }

  private static func taskMarker(_ content: String) -> (Bool, String)? {
    guard content.hasPrefix("[ ] ") || content.hasPrefix("[x] ") || content.hasPrefix("[X] ") else { return nil }
    let checked = content.hasPrefix("[x] ") || content.hasPrefix("[X] ")
    return (checked, String(content.dropFirst(4)))
  }

  private static func isTableDivider(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    guard t.contains("-"), t.contains("|") else { return false }
    let cells = splitTableRow(t)
    guard !cells.isEmpty else { return false }
    return cells.allSatisfy { cell in
      let c = cell.trimmingCharacters(in: .whitespaces)
      guard !c.isEmpty else { return false }
      let ok = (c.hasPrefix(":") ? 1 : 0) + (c.hasSuffix(":") ? 1 : 0)
      let core = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
      return core.allSatisfy { $0 == "-" } && (ok > 0 ? !core.isEmpty : !core.isEmpty)
    }
  }

  private static func cellAlign(_ cell: String) -> String {
    let c = cell.trimmingCharacters(in: .whitespaces)
    let left = c.hasPrefix(":")
    let right = c.hasSuffix(":")
    if left && right { return " style=\"text-align:center\"" }
    if right { return " style=\"text-align:right\"" }
    return ""
  }

  private static func splitTableRow(_ line: String) -> [String] {
    var t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("|") { t = String(t.dropFirst()) }
    if t.hasSuffix("|") { t = String(t.dropLast()) }
    return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
  }
}

// MARK: - 笔记摘要（对应 noteExcerpt）

private func decodeEntities(_ s: String) -> String {
  s.replacingOccurrences(of: "&nbsp;", with: " ")
    .replacingOccurrences(of: "&lt;", with: "<")
    .replacingOccurrences(of: "&gt;", with: ">")
    .replacingOccurrences(of: "&quot;", with: "\"")
    .replacingOccurrences(of: "&#39;", with: "'")
    .replacingOccurrences(of: "&amp;", with: "&")
}

/// 列表摘要：取第一段有字的纯文本，截 80 字
func noteExcerpt(_ note: Note) -> String {
  var text: String
  if note.format == .markdown {
    text = note.content
      .replacingOccurrences(of: "(?s)```[\\s\\S]*?```", with: " ", options: .regularExpression)
      .replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: " ", options: .regularExpression)
      .replacingOccurrences(of: "(?m)^\\s{0,3}#{1,6}\\s+.*$", with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  } else {
    text = decodeEntities(
      note.content
        .replacingOccurrences(of: "</?(?:b|strong|i|em|u|s|strike|span|code|sub|sup|font|a)\\b[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
        .replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    )
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
  return text.count > 80 ? String(text.prefix(80)) + "…" : text
}

/// 笔记是否完全没有内容（没标题、没文字、没图）
func isNoteEmpty(title: String, content: String, format: NoteFormat) -> Bool {
  if !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
  if !collectAssetRefs(content).isEmpty { return false }
  let text = format == .markdown ? content : content.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
  return text.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\u{00a0}", with: "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}
