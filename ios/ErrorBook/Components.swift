import SwiftUI
import UIKit
import WebKit

// MARK: - 本地资源图（assets/<hash>.<ext>）带内存缓存

final class AssetImageCache {
  static let shared = NSCache<NSURL, UIImage>()
  static func load(_ url: URL) -> UIImage? {
    if let hit = shared.object(forKey: url as NSURL) { return hit }
    guard let img = UIImage(contentsOfFile: url.path) else { return nil }
    shared.setObject(img, forKey: url as NSURL)
    return img
  }
}

struct AssetImage: View {
  let url: URL
  var onTap: (() -> Void)? = nil

  @State private var img: UIImage?

  var body: some View {
    Group {
      if let img {
        Image(uiImage: img)
          .resizable()
          .scaledToFit()
          .cornerRadius(8)
      } else {
        Rectangle()
          .fill(Color(.systemGray5))
          .frame(height: 80)
          .overlay(Text("图片缺失").font(.caption).foregroundStyle(.secondary))
      }
    }
    .onAppear { img = AssetImageCache.load(url) }
    .onTapGesture { onTap?() }
  }
}

// MARK: - 灯箱（全屏可缩放）

struct LightboxView: View {
  let url: URL
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1
  @State private var offset: CGSize = .zero

  var body: some View {
    NavigationStack {
      GeometryReader { geo in
        if let img = AssetImageCache.load(url) {
          Image(uiImage: img)
            .resizable()
            .scaledToFit()
            .frame(width: geo.size.width, height: geo.size.height)
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
              MagnificationGesture()
                .onChanged { v in
                  scale = max(1, min(6, lastScale * v))
                }
                .onEnded { _ in lastScale = scale }
            )
            .simultaneousGesture(
              DragGesture().onChanged { v in
                if scale > 1 { offset = v.translation }
              }.onEnded { _ in
                if scale <= 1 { offset = .zero }
              }
            )
            .onTapGesture(count: 2) {
              withAnimation { scale = scale > 1 ? 1 : 2.5; lastScale = scale; if scale == 1 { offset = .zero } }
            }
        }
      }
      .background(Color.black)
      .ignoresSafeArea()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("关闭") { dismiss() }
        }
      }
    }
  }
}

// MARK: - HTML 预览（Markdown 渲染结果 / Word 笔记）

struct HTMLPreview: UIViewRepresentable {
  let html: String

  func makeUIView(context: Context) -> WKWebView {
    let wv = WKWebView()
    wv.isOpaque = false
    wv.backgroundColor = .systemBackground
    wv.scrollView.bouncesZoom = false
    return wv
  }

  func updateUIView(_ wv: WKWebView, context: Context) {
    let doc = """
    <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>
    body{font-family:-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif;font-size:16px;line-height:1.75;color:#1a1a1a;
         padding:14px 14px calc(14px + env(safe-area-inset-bottom));word-break:break-word;-webkit-text-size-adjust:100%}
    img{max-width:100%;border-radius:8px}
    pre{background:#f4f4f4;padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap}
    code{font-family:Menlo,monospace;background:#f2f2f2;border-radius:3px;padding:0 4px}
    pre code{background:none;padding:0}
    blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid #bbb;color:#555}
    table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #999;padding:4px 8px}
    a{color:#2563af}
    </style></head><body>\(html)</body></html>
    """
    wv.loadHTMLString(doc, baseURL: nil)
  }
}

// MARK: - 标签

struct TagChip: View {
  let text: String
  var onRemove: (() -> Void)? = nil

  var body: some View {
    HStack(spacing: 3) {
      Text(text)
      if let onRemove {
        Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
      }
    }
    .font(.caption)
    .padding(.horizontal, 9)
    .padding(.vertical, 4)
    .background(Capsule().fill(Color.accentColor.opacity(0.14)))
    .foregroundStyle(Color.accentColor)
  }
}

/// 标签输入：已选 chips + 输入框 + 全库标签建议
struct TagInput: View {
  @Binding var tags: [String]
  let suggestions: [String]
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !tags.isEmpty {
        FlowLayout(spacing: 6) {
          ForEach(tags, id: \.self) { t in
            TagChip(text: t) {
              tags.removeAll { $0 == t }
            }
          }
        }
      }
      HStack {
        TextField("输入标签，回车添加", text: $draft)
          .textFieldStyle(.roundedBorder)
          .focused($focused)
          .onSubmit(addDraft)
        Button("添加", action: addDraft).font(.subheadline)
      }
      let others = suggestions.filter { !tags.contains($0) }
      if !others.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(others.prefix(20), id: \.self) { t in
              Button {
                tags.append(t)
              } label: {
                Text("＋ \(t)")
                  .font(.caption)
                  .padding(.horizontal, 9)
                  .padding(.vertical, 4)
                  .background(Capsule().fill(Color(.systemGray5)))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
  }

  private func addDraft() {
    let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    draft = ""
    guard !t.isEmpty, !tags.contains(t) else { return }
    tags.append(t)
  }
}

/// 简易流式布局（chips 换行）
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? 320
    var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(.unspecified)
      if x > 0, x + s.width > width {
        x = 0
        y += rowH + spacing
        rowH = 0
      }
      x += s.width + spacing
      rowH = max(rowH, s.height)
    }
    return CGSize(width: width, height: y + rowH)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
    for v in subviews {
      let s = v.sizeThatFits(.unspecified)
      if x > bounds.minX, x + s.width > bounds.maxX {
        x = bounds.minX
        y += rowH + spacing
        rowH = 0
      }
      v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
      x += s.width + spacing
      rowH = max(rowH, s.height)
    }
  }
}

// MARK: - 文件夹选择

struct FolderPicker: View {
  let folders: [Folder]
  @Binding var value: String?

  var body: some View {
    Menu {
      ForEach(flatFolders(folders), id: \.folder.id) { item in
        Button {
          value = item.folder.id
        } label: {
          Text(String(repeating: "　", count: item.depth) + item.folder.name)
        }
      }
      if folders.contains(where: { $0.id == value }) {
        Divider()
        Button("移出文件夹（未分类）") { value = nil }
      }
    } label: {
      HStack {
        Image(systemName: "folder")
        Text(folderPathName(folders, value))
          .lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(.caption2)
      }
    }
  }
}

/// 多选入口按钮：显示当前所属（多个时「第一个 +N」），点开勾选弹层；空数组 = 未分类
struct FolderMultiPicker: View {
  let folders: [Folder]
  @Binding var value: [String]
  @State private var open = false

  private var label: String {
    if value.isEmpty { return "未分类" }
    let first = folderPathName(folders, value[0])
    return value.count == 1 ? first : "\(first) +\(value.count - 1)"
  }

  var body: some View {
    Button {
      open = true
    } label: {
      HStack {
        Image(systemName: "folder")
        Text(label).lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(.caption2)
      }
    }
    .sheet(isPresented: $open) {
      FolderMultiPickerSheet(folders: folders, value: $value)
    }
  }
}

private struct FolderMultiPickerSheet: View {
  @Environment(\.dismiss) private var dismiss
  let folders: [Folder]
  @Binding var value: [String]

  var body: some View {
    NavigationStack {
      List {
        Section {
          Button {
            value = []
          } label: {
            HStack {
              Text("未分类")
              Spacer()
              if value.isEmpty { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
          }
        }
        Section("文件夹（可多选）") {
          ForEach(flatFolders(folders), id: \.folder.id) { item in
            Button {
              if let i = value.firstIndex(of: item.folder.id) {
                value.remove(at: i)
              } else {
                value.append(item.folder.id)
              }
            } label: {
              HStack {
                Text(String(repeating: "　", count: item.depth) + item.folder.name)
                Spacer()
                if value.contains(item.folder.id) {
                  Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                }
              }
            }
          }
          if folders.isEmpty {
            Text("还没有文件夹，可在设置 → 文件夹管理里新建").foregroundStyle(.secondary)
          }
        }
      }
      .navigationTitle("所属文件夹")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } }
      }
    }
  }
}

// MARK: - 空状态

struct EmptyStateView: View {
  let icon: String
  let title: String
  let message: String
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 44))
        .foregroundStyle(Color.accentColor.opacity(0.6))
        .padding(.bottom, 4)
      Text(title).font(.title3.bold())
      Text(message)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      if let actionTitle, let action {
        Button(action: action) {
          Text(actionTitle).bold()
        }
        .buttonStyle(.borderedProminent)
        .padding(.top, 6)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }
}

// MARK: - 分享面板

struct ShareSheet: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
