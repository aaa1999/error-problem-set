import Foundation
import UIKit

// MARK: - 笔记导出（对应桌面端 src/lib/noteExport.ts）
// PDF：HTML 经 UIMarkupTextPrintFormatter 原生分页渲染（文字可选中，比桌面版位图切片更好）；
// Word：MHTML 格式 .doc（HTML + 图片 base64 内嵌），Word / WPS 直接打开。

private func safeFileName(_ title: String) -> String {
  let cleaned = title.replacingOccurrences(of: "[\\\\/:*?\"<>|\\r\\n]+", with: "_", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return cleaned.isEmpty ? "笔记" : cleaned
}

/// 读取笔记引用到的全部图片，ref → 字节；缺文件跳过
private func loadAssets(_ dataDir: URL, content: String) -> [String: Data] {
  var map: [String: Data] = [:]
  for ref in collectAssetRefs(content) {
    let url = dataDir.appendingPathComponent(ref) // ref 本身就是 assets/xxx.png
    if let data = try? Data(contentsOf: url) { map[ref] = data }
  }
  return map
}

/// 生成导出正文 HTML：markdown 先渲染，assets 引用按 map 换地址；标题按需补一个 h1
func bodyHtmlForExport(note: Note, map: @escaping (String) -> String) -> String {
  let inner: String
  switch note.format {
  case .markdown:
    inner = Markdown.render(note.content, mapAsset: { ref in map(ref) })
  case .word:
    inner = sanitizeLite(Markdown.mapAssetsInHtml(note.content) { ref in map(ref) })
  }
  let title = note.title.trimmingCharacters(in: .whitespacesAndNewlines)
  let startsWithHeading = note.format == .markdown
    && note.content.range(of: "^\\s{0,3}#{1,6}\\s+\\S", options: [.regularExpression, .anchored]) != nil
  let titleHtml = !title.isEmpty && !startsWithHeading ? "<h1>\(escapeHtml(title))</h1>\n" : ""
  return titleHtml + inner
}

private func dataUrl(_ data: Data, ext: String) -> String {
  let mime = "image/\(ext == "jpg" ? "jpeg" : ext)"
  return "data:\(mime);base64,\(data.base64EncodedString())"
}

enum NoteExporter {

  /// 导出 PDF：图片以 data: URL 内嵌，渲染成 A4 分页 PDF，写到临时文件后由分享面板送出
  static func exportPdf(note: Note, dataDir: URL) async throws -> URL {
    let assets = loadAssets(dataDir, content: note.content)
    let html = """
    <!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif;font-size:11pt;line-height:1.7;color:#111}
    img{max-width:100%}
    pre{background:#f6f6f6;border:0.5pt solid #ddd;padding:8pt;white-space:pre-wrap;font-family:Menlo,monospace;font-size:10pt}
    code{font-family:Menlo,monospace;background:#f2f2f2}
    blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3pt solid #bbb;color:#555}
    table{border-collapse:collapse}th,td{border:0.5pt solid #999;padding:4pt 8pt}
    </style></head><body>
    \(bodyHtmlForExport(note: note) { ref in assets[ref].map { dataUrl($0, ext: extOf(ref)) } ?? "" })
    </body></html>
    """

    let formatter = UIMarkupTextPrintFormatter(markupText: html)
    let renderer = PageRenderer()
    renderer.addPrintFormatter(formatter, startingAtPageAt: 0)

    let pageRect = CGRect(x: 0, y: 0, width: 595.2, height: 841.8) // A4 pt
    let insets = UIEdgeInsets(top: 36, left: 40, bottom: 36, right: 40)
    let pdfData = renderer.pdfData(pageRect: pageRect, insets: insets)

    let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(safeFileName(note.title)).pdf")
    try pdfData.write(to: out, options: .atomic)
    return out
  }

  /// 导出 Word：MHTML 的 .doc——HTML 正文 + 图片 base64 内嵌在一个 MIME 文档里
  static func exportDoc(note: Note, dataDir: URL) async throws -> URL {
    let assets = loadAssets(dataDir, content: note.content)
    func mhtRef(_ ref: String) -> String { "file:///noteassets/\(String(ref.dropFirst("assets/".count)))" }
    let wordCss = [
      "body{font-family:\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:11pt;line-height:1.7;color:#111111}",
      "h1{font-size:20pt}h2{font-size:16pt}h3{font-size:13.5pt}",
      "img{max-width:100%}",
      "pre{background:#f6f6f6;border:1pt solid #dddddd;padding:8pt;white-space:pre-wrap;font-family:Consolas,Menlo,monospace;font-size:10pt}",
      "code{font-family:Consolas,Menlo,monospace;background:#f2f2f2}",
      "blockquote{margin:8pt 0;padding:2pt 12pt;border-left:3pt solid #bbbbbb;color:#555555}",
      "table{border-collapse:collapse}th,td{border:1pt solid #999999;padding:4pt 8pt}",
    ].joined()
    let html =
      "<!DOCTYPE html><html xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:w=\"urn:schemas-microsoft-com:office:word\">"
      + "<head><meta charset=\"utf-8\"><title>\(escapeHtml(note.title))</title><style>\(wordCss)</style></head>"
      + "<body>\(bodyHtmlForExport(note: note) { ref in assets[ref] != nil ? mhtRef(ref) : "" })</body></html>"

    let boundary = "----=_NoteExport_\(String(Int(Date().timeIntervalSince1970), radix: 36))"
    func part(_ contentType: String, _ location: String, _ b64: String) -> String {
      var wrapped = ""
      var idx = b64.startIndex
      while idx < b64.endIndex {
        let end = b64.index(idx, offsetBy: 76, limitedBy: b64.endIndex) ?? b64.endIndex
        wrapped += b64[idx..<end]
        wrapped += "\r\n"
        idx = end
      }
      return "--\(boundary)\r\nContent-Type: \(contentType)\r\nContent-Transfer-Encoding: base64\r\nContent-Location: \(location)\r\n\r\n\(wrapped)"
    }

    var mht = "MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"\(boundary)\"\r\n\r\nThis document is formatted in MHTML.\r\n"
    mht += part("text/html; charset=\"utf-8\"", "file:///note/note.html", html.data(using: .utf8)!.base64EncodedString())
    for (ref, data) in assets {
      let ext = extOf(ref)
      let mime = "image/\(ext == "jpg" ? "jpeg" : ext)"
      mht += part(mime, mhtRef(ref), data.base64EncodedString())
    }
    mht += "--\(boundary)--\r\n"

    let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(safeFileName(note.title)).doc")
    try mht.data(using: .utf8)?.write(to: out, options: .atomic)
    return out
  }
}

/// 固定纸张的打印渲染器（公开 API 子类化，避免 KVC 设置 paperRect）
final class PageRenderer: UIPrintPageRenderer {
  private var page: CGRect = .zero
  private var margin: UIEdgeInsets = .zero

  func pdfData(pageRect: CGRect, insets: UIEdgeInsets) -> Data {
    page = pageRect
    margin = insets
    let pdfRenderer = UIGraphicsPDFRenderer(bounds: pageRect)
    return pdfRenderer.pdfData { ctx in
      for i in 0..<self.numberOfPages {
        ctx.beginPage()
        self.drawPage(at: i, in: pageRect)
      }
    }
  }

  override var paperRect: CGRect { page }
  override var printableRect: CGRect {
    CGRect(x: margin.left, y: margin.top, width: page.width - margin.left - margin.right, height: page.height - margin.top - margin.bottom)
  }
}
