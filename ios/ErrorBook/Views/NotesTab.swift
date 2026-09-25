import SwiftUI
import PhotosUI

// MARK: - 笔记列表（对应桌面端 NotesView）

struct NotesTab: View {
  @EnvironmentObject private var store: BookStore
  @State private var query = ""
  // 远程设备范围（「☁ 同步 → 按设备拉取」后可浏览）：nil = 本机；设备范围只读
  @State private var deviceScope: String?
  @State private var path: [String] = [String]()
  @State private var autoOpenNote: Bool?

  private var remote: RemoteDevice? {
    guard let id = deviceScope else { return nil }
    return store.remoteDevices.first { $0.id == id }
  }
  private var activeNotes: [Note] { remote?.db.notes ?? store.db.notes }
  private var readOnly: Bool { remote != nil }

  private var notes: [Note] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return activeNotes
      .filter { n in
        q.isEmpty || n.title.lowercased().contains(q) || n.content.lowercased().contains(q)
      }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if activeNotes.isEmpty {
          EmptyStateView(
            icon: readOnly ? "iphone" : "note.text",
            title: readOnly ? "\(remote?.name ?? "该设备") 的笔记" : "笔记",
            message: readOnly
              ? "该设备还没有推送过笔记，或库是空的。"
              : "Markdown 笔记（即时预览、可插入图片），均支持导出 PDF / Word。\nWord 富文本笔记可查看，编辑请用桌面端。"
          )
        } else {
          List {
            ForEach(notes) { n in
              NavigationLink {
                if readOnly {
                  RemoteNoteView(note: n)
                } else {
                  NoteEditorView(noteId: n.id)
                }
              } label: {
                NoteRowLabel(note: n)
              }
              .swipeActions {
                if !readOnly {
                  Button(role: .destructive) {
                    store.deleteNote(n.id)
                  } label: {
                    Label("删除", systemImage: "trash")
                  }
                }
              }
            }
          }
          .listStyle(.plain)
        }
      }
      .navigationTitle(readOnly ? "\(remote?.name ?? "") 笔记" : "笔记")
      .searchable(text: $query, prompt: "搜索笔记…")
      .toolbar {
        if !store.remoteDevices.isEmpty {
          ToolbarItem(placement: .topBarLeading) {
            Menu {
              Button { deviceScope = nil } label: { Label("本机", systemImage: readOnly ? "iphone" : "checkmark") }
              ForEach(store.remoteDevices) { d in
                Button { deviceScope = d.id } label: { Label(d.name, systemImage: deviceScope == d.id ? "checkmark" : "iphone") }
              }
            } label: {
              Label(readOnly ? (remote?.name ?? "设备") : "本机", systemImage: "arrow.up.arrow.down.circle")
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if !readOnly {
            Button {
              let n = Note(title: "", format: .markdown, content: "")
              store.addNote(n)
              // 直接推入新建的笔记（内容为空切走会自动丢弃）
              path.append(n.id)
            } label: {
              Image(systemName: "square.and.pencil")
            }
          }
        }
      }
      .navigationDestination(for: String.self) { id in
        if let n = activeNotes.first(where: { $0.id == id }), readOnly {
          RemoteNoteView(note: n)
        } else {
          NoteEditorView(noteId: id)
        }
      }
      .onAppear {
        // 截图/自动化验证用：launchArguments 传 -note <id> 直接进入指定笔记
        if autoOpenNote == nil {
          autoOpenNote = true
          let args = ProcessInfo.processInfo.arguments
          if let i = args.firstIndex(of: "-note"), i + 1 < args.count {
            path.append(args[i + 1])
          }
        }
      }
      .onChange(of: deviceScope) { _ in path = [String]() }
    }
  }
}

/// 远程设备的笔记：只读查看（渲染 HTML，图片内嵌 base64），不能编辑
struct RemoteNoteView: View {
  @EnvironmentObject private var store: BookStore
  let note: Note

  private var html: String {
    func mapRef(_ ref: String) -> String {
      let url = store.dataDir.appendingPathComponent(ref)
      guard let data = try? Data(contentsOf: url) else { return "" }
      let ext = extOf(ref)
      return "data:image/\(ext == "jpg" ? "jpeg" : ext);base64,\(data.base64EncodedString())"
    }
    switch note.format {
    case .markdown:
      return Markdown.render(note.content, mapAsset: mapRef)
    case .word:
      return sanitizeLite(Markdown.mapAssetsInHtml(note.content) { mapRef($0) })
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(note.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "无标题" : note.title)
          .font(.headline)
        Text(note.format == .word ? "Word" : "MD")
          .font(.caption2.bold())
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(Color.blue.opacity(0.15)))
          .foregroundStyle(.blue)
        Spacer()
        Text(formatTime(note.updatedAt)).font(.caption2).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      Divider()
      HTMLPreview(html: html)
    }
    .navigationTitle("远程笔记 · 只读")
    .navigationBarTitleDisplayMode(.inline)
  }
}

/// 笔记列表行
private struct NoteRowLabel: View {
  let note: Note

  private var badgeColor: Color { note.format == .word ? .blue : .purple }
  private var displayTitle: String {
    note.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "无标题" : note.title
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(note.format == .word ? "Word" : "MD")
          .font(.caption2.bold())
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(RoundedRectangle(cornerRadius: 4).fill(badgeColor.opacity(0.14)))
          .foregroundStyle(badgeColor)
        Text(displayTitle)
          .font(.body.weight(.semibold))
          .lineLimit(1)
        Spacer()
        Text(formatTime(note.updatedAt))
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
      let excerpt = noteExcerpt(note)
      if !excerpt.isEmpty {
        Text(excerpt)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 2)
  }
}

// MARK: - 笔记编辑器（对应桌面端 NoteEditor + MarkdownEditor/WordEditor）

struct NoteEditorView: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss

  let noteId: String

  enum Mode: String, CaseIterable, Identifiable {
    case edit = "编辑"
    case preview = "预览"
    var id: String { rawValue }
  }

  @State private var title = ""
  @State private var content = ""
  @State private var mode: Mode = .edit
  @State private var shareUrl: URL?
  @State private var exportBusy = false
  @State private var exportError = ""
  @State private var autosaveTask: Task<Void, Never>?
  @State private var loaded = false
  @State private var confirmDelete = false

  /// 编辑器代理：供工具栏对选区做包裹
  private var editorProxy = EditorProxy()

  private var format: NoteFormat {
    store.db.notes.first { $0.id == noteId }?.format ?? .markdown
  }

  private var previewHtml: String {
    let note = Note(id: noteId, title: title, format: format, content: content)
    func mapRef(_ ref: String) -> String {
      let url = store.dataDir.appendingPathComponent(ref)
      guard let data = try? Data(contentsOf: url) else { return "" }
      let ext = extOf(ref)
      return "data:image/\(ext == "jpg" ? "jpeg" : ext);base64,\(data.base64EncodedString())"
    }
    switch format {
    case .markdown:
      return Markdown.render(content, mapAsset: mapRef)
    case .word:
      return sanitizeLite(Markdown.mapAssetsInHtml(content) { mapRef($0) })
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      TextField("标题", text: $title)
        .font(.body.weight(.semibold))
        .padding(.horizontal)
        .padding(.vertical, 8)
      contentArea
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbarItems }
    .sheet(item: Binding(
      get: { shareUrl.map { ShareItem(url: $0) } },
      set: { shareUrl = $0?.url }
    )) { item in
      ShareSheet(items: [item.url])
    }
    .alert("删除这篇笔记？", isPresented: $confirmDelete) {
      Button("删除", role: .destructive) {
        store.deleteNote(noteId)
        dismiss()
      }
      Button("取消", role: .cancel) {}
    }
    .onAppear {
      guard !loaded else { return }
      loaded = true
      if let n = store.db.notes.first(where: { $0.id == noteId }) {
        title = n.title
        content = n.content
      }
    }
    .onDisappear {
      // 没内容就丢弃（新建后没写直接返回）
      if isNoteEmpty(title: title, content: content, format: format) {
        store.deleteNote(noteId)
      } else {
        saveNow()
      }
    }
    .onChange(of: title) { _ in scheduleAutosave() }
    .onChange(of: content) { _ in scheduleAutosave() }
    .overlay(alignment: .bottom) {
      if !exportError.isEmpty {
        Text(exportError)
          .font(.footnote)
          .foregroundStyle(.white)
          .padding(10)
          .background(Capsule().fill(.red))
          .padding(.bottom, 20)
          .task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            exportError = ""
          }
      }
    }
  }

  @ViewBuilder
  private var contentArea: some View {
    if format == .markdown {
      Picker("模式", selection: $mode) {
        ForEach(Mode.allCases) { m in
          Text(m.rawValue).tag(m)
        }
      }
      .pickerStyle(.segmented)
      .frame(maxWidth: 200)
      .padding(.bottom, 8)

      if mode == .edit {
        editorArea
      } else {
        previewArea
      }
    } else {
      // Word 富文本：iOS 端只读渲染，编辑请回桌面端
      previewArea
    }
  }

  private var editorArea: some View {
    VStack(spacing: 0) {
      MarkdownToolbar(proxy: editorProxy, onPhoto: { item in insertPhoto(item) })
      MarkdownTextEditor(text: $content, proxy: editorProxy)
    }
  }

  private var previewArea: some View {
    ScrollView {
      HTMLPreview(html: previewHtml)
    }
  }

  @ToolbarContentBuilder
  private var toolbarItems: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      Menu {
        Button {
          export(asPdf: true)
        } label: {
          Label("导出 PDF", systemImage: "doc.richtext")
        }
        Button {
          export(asPdf: false)
        } label: {
          Label("导出 Word（.doc）", systemImage: "doc.plaintext")
        }
        Divider()
        Button(role: .destructive) {
          confirmDelete = true
        } label: {
          Label("删除笔记", systemImage: "trash")
        }
      } label: {
        if exportBusy {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: "square.and.arrow.up")
        }
      }
    }
    ToolbarItemGroup(placement: .keyboard) {
      Spacer()
      Button("收起键盘") {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
      }
    }
  }

  private func saveNow() {
    guard var n = store.db.notes.first(where: { $0.id == noteId }) else { return }
    n.title = title
    n.content = content
    n.updatedAt = Date().nowMs
    store.updateNote(n)
  }

  private func scheduleAutosave() {
    autosaveTask?.cancel()
    autosaveTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 800_000_000)
      guard !Task.isCancelled else { return }
      if !isNoteEmpty(title: title, content: content, format: format) {
        saveNow()
      }
    }
  }

  // MARK: 图片插入

  private func insertPhoto(_ item: PhotosPickerItem) {
    Task { @MainActor in
      guard let data = try? await item.loadTransferable(type: Data.self) else { return }
      do {
        let block = try ImageStore.importPhotoData(data, suggestedExt: "jpg", into: store.dataDir)
        if case let .image(hash, ext) = block {
          let ref = "![](assets/\(hash).\(ext))\n"
          content += (content.isEmpty || content.hasSuffix("\n")) ? ref : "\n" + ref
        }
      } catch {
        exportError = "图片插入失败：\(error.localizedDescription)"
      }
    }
  }

  // MARK: 导出

  private func export(asPdf: Bool) {
    exportBusy = true
    let note = Note(id: noteId, title: title, format: format, content: content)
    Task { @MainActor in
      do {
        let url = asPdf
          ? try await NoteExporter.exportPdf(note: note, dataDir: store.dataDir)
          : try await NoteExporter.exportDoc(note: note, dataDir: store.dataDir)
        shareUrl = url
      } catch {
        exportError = "导出失败：\(error.localizedDescription)"
      }
      exportBusy = false
    }
  }
}

private struct ShareItem: Identifiable {
  let url: URL
  var id: String { url.absoluteString }
}

// MARK: - Markdown 编辑器（UITextView：支持选区包裹与光标插入）

final class EditorProxy: ObservableObject {
  weak var textView: UITextView?

  /// 用前后缀包裹当前选区（无选区则插入占位文本）
  func wrap(_ prefix: String, _ suffix: String, placeholder: String) {
    guard let tv = textView else { return }
    let range = tv.selectedRange
    let text = (tv.text as NSString)
    let selected = range.length > 0 ? text.substring(with: range) : placeholder
    let replacement = prefix + selected + suffix
    tv.text = text.replacingCharacters(in: range, with: replacement) as String
    let newRange = NSRange(location: range.location + prefix.count, length: selected.count)
    tv.selectedRange = newRange
    tv.becomeFirstResponder()
    tv.onTextChange()
  }

  /// 行首前缀（引用等）：对选中的每一行加前缀
  func linePrefix(_ prefix: String) {
    guard let tv = textView else { return }
    let text = (tv.text as NSString)
    var range = tv.selectedRange
    if range.length == 0 { range.length = 1 }
    let loc = text.lineRange(for: NSRange(location: range.location, length: 0)).location
    let selected = text.substring(with: NSRange(location: loc, length: range.location + range.length - loc))
    let lines = selected.components(separatedBy: "\n").map { prefix + $0 }
    let replacement = lines.joined(separator: "\n")
    let new = text.replacingCharacters(in: NSRange(location: loc, length: range.location + range.length - loc), with: replacement) as String
    tv.text = new
    tv.selectedRange = NSRange(location: loc, length: replacement.count)
    tv.becomeFirstResponder()
    tv.onTextChange()
  }
}

extension UITextView {
  func onTextChange() {
    (delegate as? MarkdownTextEditor.Coordinator)?.syncToBinding()
  }
}

struct MarkdownTextEditor: UIViewRepresentable {
  @Binding var text: String
  let proxy: EditorProxy

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    let tv = UITextView()
    tv.font = .systemFont(ofSize: 16)
    tv.adjustsFontForContentSizeCategory = true
    tv.delegate = context.coordinator
    tv.textContainerInset = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
    tv.backgroundColor = .systemBackground
    context.coordinator.textView = tv
    proxy.textView = tv
    return tv
  }

  func updateUIView(_ tv: UITextView, context: Context) {
    if tv.text != text {
      tv.text = text
    }
    proxy.textView = tv
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: MarkdownTextEditor
    weak var textView: UITextView?

    init(_ parent: MarkdownTextEditor) {
      self.parent = parent
    }

    func textViewDidChange(_ tv: UITextView) {
      parent.text = tv.text
    }

    func syncToBinding() {
      parent.text = textView?.text ?? ""
    }
  }
}

// MARK: - Markdown 工具栏

struct MarkdownToolbar: View {
  let proxy: EditorProxy
  /// 相册选完图片交给外部统一入库并插入引用
  var onPhoto: (PhotosPickerItem) -> Void
  @State private var picked: PhotosPickerItem?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        tool("B", bold: true) { proxy.wrap("**", "**", placeholder: "粗体") }
        tool("I", italic: true) { proxy.wrap("*", "*", placeholder: "斜体") }
        tool("S", strikethrough: true) { proxy.wrap("~~", "~~", placeholder: "删除线") }
        tool("code", monospace: true) { proxy.wrap("`", "`", placeholder: "代码") }
        tool("# 标题", monospace: true) { proxy.linePrefix("## ") }
        tool("❝ 引用") { proxy.linePrefix("> ") }
        tool("• 列表") { proxy.linePrefix("- ") }
        tool("1. 列表", monospace: true) { proxy.linePrefix("1. ") }
        PhotosPicker(selection: $picked, matching: .images) {
          toolLabel("📷 图片", monospace: true)
        }
        .onChange(of: picked) { item in
          if let item {
            onPhoto(item)
            picked = nil
          }
        }
      }
      .padding(.horizontal)
      .padding(.vertical, 6)
    }
    .background(Color(.systemGray6))
  }

  private func tool(_ label: String, bold: Bool = false, italic: Bool = false, strikethrough: Bool = false, monospace: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      toolLabel(label, bold: bold, italic: italic, strikethrough: strikethrough, monospace: monospace)
    }
    .buttonStyle(.plain)
  }

  private func toolLabel(_ label: String, bold: Bool = false, italic: Bool = false, strikethrough: Bool = false, monospace: Bool = false) -> some View {
    Text(label)
      .font(.system(size: 14, weight: bold ? .bold : .regular, design: monospace ? .monospaced : .default))
      .italic(italic)
      .strikethrough(strikethrough)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(Capsule().fill(Color(.systemBackground)))
      .overlay(Capsule().strokeBorder(Color(.separator), lineWidth: 0.5))
  }
}
