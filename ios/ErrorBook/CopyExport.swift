import Foundation
import UIKit
import UniformTypeIdentifiers

// MARK: - 一键复制整道错题（对应桌面端 src/lib/copy.ts）
// 题目（含图片）+ 选项（含正确答案）+ 解析（含图片）+ 标签 + 所属文件夹。
// 剪贴板同时写 plainText + HTML 两个分量：HTML 里图片以 base64 内嵌，
// 粘贴到备忘录 / Word / 邮件等支持富文本的地方图随文走。

private let copyMime: [String: String] = [
  "png": "image/png",
  "jpg": "image/jpeg",
  "jpeg": "image/jpeg",
  "webp": "image/webp",
  "gif": "image/gif",
  "bmp": "image/bmp",
  "avif": "image/avif",
]

private func copyLetter(_ i: Int) -> String {
  guard i < 26 else { return "\(i + 1)" }
  return String(UnicodeScalar(UInt8(65 + i)))
}

private func copyEscapeHtml(_ s: String) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
}

private func metaText(_ m: Mistake, _ folders: [Folder]) -> String {
  var parts: [String] = []
  if !m.tags.isEmpty { parts.append("标签：\(m.tags.joined(separator: "、"))") }
  let paths = m.folderIds.map { folderPathName(folders, $0) }.filter { $0 != "未分类" }
  if !paths.isEmpty { parts.append("文件夹：\(paths.joined(separator: "、"))") }
  return parts.joined(separator: "　")
}

/// 图片 → data URL；文件缺失返回 nil（用占位）
private func assetDataUrl(_ dataDir: URL, hash: String, ext: String) -> String? {
  let url = ImageStore.assetURL(dataDir, hash: hash, ext: ext)
  guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
  let mime = copyMime[ext.lowercased()] ?? "application/octet-stream"
  return "data:\(mime);base64,\(data.base64EncodedString())"
}

/// 纯文本版（图片以 [图片] 占位）；questionOnly = 只复制题目
func mistakePlainText(_ m: Mistake, _ folders: [Folder], questionOnly: Bool = false) -> String {
  func blocks(_ bs: [Block]) -> String {
    bs.map { b in
      if case let .text(_, t) = b { return t }
      return "[图片]"
    }.joined(separator: "\n")
  }
  var lines = ["【题目】", blocks(m.question)]
  if !questionOnly {
    if !m.options.isEmpty {
      lines.append(contentsOf: ["", "【选项】"])
      for (i, o) in m.options.enumerated() {
        lines.append("\(copyLetter(i)). \(o)\(m.answer == i ? "　✓ 正确答案" : "")")
      }
    }
    lines.append(contentsOf: ["", "【解析】", blocks(m.analysis)])
    let meta = metaText(m, folders)
    if !meta.isEmpty { lines.append(contentsOf: ["", meta]) }
  }
  return lines.joined(separator: "\n")
}

/// 富文本版（图片 base64 内嵌）；questionOnly = 只复制题目
func mistakeHtml(_ m: Mistake, _ folders: [Folder], dataDir: URL, questionOnly: Bool = false) -> String {
  func renderBlocks(_ bs: [Block]) -> String {
    bs.map { b -> String in
      switch b {
      case let .text(_, t):
        return "<p style=\"margin:4px 0;white-space:pre-wrap\">\(copyEscapeHtml(t))</p>"
      case let .image(hash, ext):
        if let url = assetDataUrl(dataDir, hash: hash, ext: ext) {
          return "<img src=\"\(url)\" style=\"max-width:100%;border-radius:6px;margin:4px 0\" />"
        }
        return "<p style=\"color:#999;margin:4px 0\">[图片缺失]</p>"
      }
    }.joined()
  }
  func h(_ t: String) -> String { "<h4 style=\"margin:12px 0 4px;font-size:14px\">\(t)</h4>" }

  var html = "<div style=\"font-family:-apple-system,'PingFang SC',sans-serif;font-size:14px;line-height:1.7\">"
  html += h("题目") + renderBlocks(m.question)
  if !questionOnly {
    if !m.options.isEmpty {
      html += h("选项") + "<ul style=\"margin:4px 0;padding-left:22px;list-style:none\">"
      for (i, o) in m.options.enumerated() {
        let correct = m.answer == i
        html += "<li style=\"margin:3px 0;\(correct ? "color:#2e7d32;font-weight:600" : "")\">\(copyLetter(i)). \(copyEscapeHtml(o))\(correct ? "　✓ 正确答案" : "")</li>"
      }
      html += "</ul>"
    }
    html += h("解析") + renderBlocks(m.analysis)
    let meta = metaText(m, folders)
    if !meta.isEmpty {
      html += "<p style=\"color:#888;font-size:12px;margin-top:10px\">\(copyEscapeHtml(meta))</p>"
    }
  }
  return html + "</div>"
}

/// 写入剪贴板：plainText + HTML 双分量，粘贴目标各取所需；questionOnly = 只复制题目
func copyMistakeToPasteboard(_ m: Mistake, folders: [Folder], dataDir: URL, questionOnly: Bool = false) {
  let text = mistakePlainText(m, folders, questionOnly: questionOnly)
  let html = mistakeHtml(m, folders, dataDir: dataDir, questionOnly: questionOnly)
  UIPasteboard.general.items = [[
    UTType.plainText.identifier: text,
    UTType.html.identifier: html,
  ]]
}
