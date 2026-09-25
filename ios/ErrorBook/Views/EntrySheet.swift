import SwiftUI
import PhotosUI

// MARK: - 块编辑器（对应桌面端 BlockEditor：文字段 + 图片块）

struct BlockEditor: View {
  @EnvironmentObject private var store: BookStore
  let label: String
  @Binding var blocks: [Block]
  var placeholder: String = ""

  @State private var photoItems: [PhotosPickerItem] = []
  @State private var importing = 0
  @State private var importError = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Text(label).font(.subheadline.bold())
        Spacer()
        PhotosPicker(selection: $photoItems, matching: .images) {
          Label("插入图片", systemImage: "photo")
        }
        Button {
          blocks.append(.text(id: UUID().uuidString.lowercased(), text: ""))
        } label: {
          Label("文字段", systemImage: "plus.square")
        }
        if importing > 0 { ProgressView().controlSize(.small) }
      }
      .font(.subheadline)

      if !importError.isEmpty {
        Text(importError).font(.caption).foregroundStyle(.red)
      }

      if blocks.isEmpty {
        Button {
          blocks.append(.text(id: UUID().uuidString.lowercased(), text: ""))
        } label: {
          Text(placeholder.isEmpty ? "添加文字或图片" : placeholder)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4])))
        }
      }

      ForEach(Array(blocks.enumerated()), id: \.offset) { idx, block in
        switch block {
        case let .text(id, text):
          TextBlockRow(
            text: Binding(
              get: { textAt(idx) ?? "" },
              set: { newText(idx, id: id, text: $0) }
            )
          ) {
            blocks.remove(at: idx)
          }
        case let .image(hash, ext):
          ImageBlockRow(
            url: ImageStore.assetURL(store.dataDir, hash: hash, ext: ext),
            isFirst: idx == 0,
            isLast: idx == blocks.count - 1
          ) {
            blocks.remove(at: idx)
          } onMoveUp: {
            guard idx > 0 else { return }
            blocks.swapAt(idx, idx - 1)
          } onMoveDown: {
            guard idx < blocks.count - 1 else { return }
            blocks.swapAt(idx, idx + 1)
          }
        }
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color(.systemGray6)))
    .onChange(of: photoItems) { items in
      importPhotos(items)
    }
  }

  private func textAt(_ idx: Int) -> String? {
    if case let .text(_, t) = blocks[idx] { return t }
    return nil
  }

  private func newText(_ idx: Int, id: String, text: String) {
    blocks[idx] = .text(id: id, text: text)
  }

  private func importPhotos(_ items: [PhotosPickerItem]) {
    guard !items.isEmpty else { return }
    photoItems = []
    importing += items.count
    Task { @MainActor in
      for item in items {
        defer { importing -= 1 }
        guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
        do {
          let block = try ImageStore.importPhotoData(data, suggestedExt: "jpg", into: store.dataDir)
          blocks.append(block)
        } catch {
          importError = "导入失败：\(error.localizedDescription)"
          try? await Task.sleep(nanoseconds: 3_500_000_000)
          importError = ""
        }
      }
    }
  }
}

private struct TextBlockRow: View {
  @Binding var text: String
  var onDelete: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 6) {
      TextField("输入文字", text: $text, axis: .vertical)
        .lineSpacing(4)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.systemBackground)))
      Button(role: .destructive, action: onDelete) {
        Image(systemName: "minus.circle")
      }
      .padding(.top, 8)
    }
  }
}

private struct ImageBlockRow: View {
  let url: URL
  let isFirst: Bool
  let isLast: Bool
  var onDelete: () -> Void
  var onMoveUp: () -> Void
  var onMoveDown: () -> Void

  var body: some View {
    VStack(spacing: 4) {
      AssetImage(url: url)
      HStack(spacing: 14) {
        Button(action: onMoveUp) { Image(systemName: "arrow.up") }
          .disabled(isFirst)
        Button(action: onMoveDown) { Image(systemName: "arrow.down") }
          .disabled(isLast)
        Spacer()
        Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }
      }
      .font(.subheadline)
      .padding(.vertical, 2)
    }
  }
}

// MARK: - 录入/编辑错题（对应桌面端 EntryView）

struct EntrySheet: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss

  let editing: Mistake?
  /// 录入入口预设：文件夹录入 / 标签录入带入；进去后仍可调整
  var presetFolders: [String] = []
  var presetTags: [String] = []

  // 录入记忆：勾「记住标签与文件夹」保存后，下次从任何入口录入自动带上（显式预设优先）
  @AppStorage("entryMemoryOn") private var memoryOn = false
  @AppStorage("entryMemoryFolders") private var memoryFoldersRaw = ""
  @AppStorage("entryMemoryTags") private var memoryTagsRaw = ""
  @State private var remember = false

  @State private var qBlocks: [Block] = []
  @State private var aBlocks: [Block] = []
  @State private var tags: [String] = []
  @State private var folderIds: [String] = []
  // 选择题选项（选填）：填了并在浏览时作答才会统计错误率
  @State private var options: [String] = []
  @State private var answer: Int? = nil
  @State private var flash = ""
  @State private var initialized = false
  @State private var autosaveTask: Task<Void, Never>?

  private var valid: Bool { !isBlocksEmpty(qBlocks) }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            FolderMultiPicker(folders: store.db.folders, value: $folderIds)
            Spacer()
          }
          TagInput(tags: $tags, suggestions: store.allTags)
          if editing == nil {
            Toggle(isOn: $remember) {
              Text("记住标签与文件夹").font(.caption)
            }
            .toggleStyle(.switch)
            .controlSize(.mini)
          }
          BlockEditor(label: "题目", blocks: $qBlocks, placeholder: "输入题目文字，或插入截图")
          optionsEditor // 题目之后、解析之前
          BlockEditor(label: "解析", blocks: $aBlocks, placeholder: "输入解析文字，或插入解析截图")
          if !flash.isEmpty {
            Label(flash, systemImage: "checkmark.circle.fill")
              .font(.subheadline)
              .foregroundStyle(.green)
          }
        }
        .padding()
      }
      .navigationTitle(editing != nil ? "编辑错题" : !presetFolders.isEmpty ? "文件夹录入" : !presetTags.isEmpty ? "标签录入" : "录入错题")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(editing != nil ? "返回" : "取消") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if editing != nil {
            Button("保存") { saveAndDone() }.disabled(!valid)
          } else {
            Menu {
              Button("保存并录入下一题") { saveAndNext() }
              Button("保存并去浏览") { saveAndDone() }
            } label: {
              Text("保存").bold()
            }
            .disabled(!valid)
          }
        }
        ToolbarItemGroup(placement: .keyboard) {
          Spacer()
          Button("收起键盘") { hideKeyboard() }
        }
      }
      .onAppear {
        guard !initialized else { return }
        initialized = true
        if let e = editing {
          qBlocks = e.question
          aBlocks = e.analysis
          tags = e.tags
          folderIds = e.folderIds
          options = e.options.isEmpty ? ["", "", "", ""] : e.options
          answer = e.answer
        } else {
          qBlocks = [.text(id: UUID().uuidString.lowercased(), text: "")]
          aBlocks = [.text(id: UUID().uuidString.lowercased(), text: "")]
          options = ["", "", "", ""] // 默认摆出 A–D 四个空框，留空保存即非选择题
          // 初始标签/所属：显式预设（文件夹/标签录入）> 记住的值
          let memFolders = memoryFoldersRaw.split(separator: "\n").map(String.init)
          let memTags = memoryTagsRaw.split(separator: "\n").map(String.init)
          folderIds = !presetFolders.isEmpty ? presetFolders : (memoryOn ? memFolders : [])
          tags = !presetTags.isEmpty ? presetTags : (memoryOn ? memTags : [])
          remember = memoryOn
        }
      }
      .onDisappear {
        // 编辑态兜底保存（新题只认显式保存）
        if let e = editing, !isBlocksEmpty(qBlocks), optionsReady {
          store.updateMistake(build())
        }
      }
      .onChange(of: qBlocks) { _ in scheduleAutosave() }
      .onChange(of: aBlocks) { _ in scheduleAutosave() }
      .onChange(of: tags) { _ in scheduleAutosave() }
      .onChange(of: folderIds) { _ in scheduleAutosave() }
      .onChange(of: options) { _ in scheduleAutosave() }
      .onChange(of: answer) { _ in scheduleAutosave() }
    }
  }

  private func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
  }

  // MARK: 选择题选项编辑（字母标记正确答案，选项文字直接写在题目里；不标记 = 非选择题）

  @ViewBuilder
  private var optionsEditor: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("选项").font(.footnote.bold()).foregroundStyle(.secondary)
        Text("点字母标记正确答案；不标记 = 非选择题").font(.caption2).foregroundStyle(.tertiary)
        Spacer()
        if options.count < 8 {
          Button {
            options.append("")
          } label: {
            Label("添加", systemImage: "plus")
          }
          .font(.footnote)
          .buttonStyle(.bordered)
        }
        if options.count > 2 {
          Button {
            options.removeLast()
            if let a = answer, a >= options.count { answer = nil }
          } label: {
            Label("删一个", systemImage: "minus")
          }
          .font(.footnote)
          .buttonStyle(.bordered)
        }
      }
      // 字母圆钮一行排开：点击标记正确答案（实心高亮），再点一次取消
      HStack(spacing: 12) {
        ForEach(options.indices, id: \.self) { i in
          Button {
            answer = (answer == i ? nil : i)
          } label: {
            Text(String(UnicodeScalar(UInt8(65 + i))))
              .font(.subheadline.bold())
              .frame(width: 36, height: 36)
              .background(Circle().fill(answer == i ? Color.accentColor : Color(.systemGray5)))
              .foregroundStyle(answer == i ? Color.white : Color.secondary)
              .overlay(
                Circle().strokeBorder(answer == i ? Color.accentColor : .clear, lineWidth: 1.5)
              )
          }
          .buttonStyle(.plain)
          .accessibilityLabel("选项 \(String(UnicodeScalar(UInt8(65 + i))))\(answer == i ? "，已标记为正确答案" : "")")
        }
      }
      // 旧数据里已录的选项内容：只读展示，保存时原样保留
      if options.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
        Text(
          "已录选项内容："
            + options.enumerated()
              .map {
                "\(String(UnicodeScalar(UInt8(65 + $0.offset)))). \($0.element.trimmingCharacters(in: .whitespacesAndNewlines))"
              }
              .joined(separator: "　")
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
    }
  }

  private func build() -> Mistake {
    // 标记了答案 = 选择题（选项字母数即选项数，内容可为空——选项文字通常直接写在题目里）；未标记 = 非选择题
    let opts = answer != nil ? options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } : []
    return Mistake(
      id: editing?.id ?? UUID().uuidString.lowercased(),
      folderIds: folderIds,
      options: opts,
      answer: opts.isEmpty ? nil : answer,
      attempts: editing?.attempts ?? 0, // 作答统计随编辑保留，只增不减
      wrong: editing?.wrong ?? 0,
      question: qBlocks,
      analysis: aBlocks,
      tags: tags,
      createdAt: editing?.createdAt ?? Date().nowMs,
      updatedAt: Date().nowMs
    )
  }

  /// 有旧选项内容时必须标记正确答案；纯字母标记可留空（不标记 = 非选择题）
  private var optionsReady: Bool {
    answer != nil || !options.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  /// 新录时按「记住」开关落记忆：勾 = 存当前文件夹+标签；不勾 = 清掉旧记忆
  private func persistMemory() {
    guard editing == nil else { return }
    if remember {
      memoryFoldersRaw = folderIds.joined(separator: "\n")
      memoryTagsRaw = tags.joined(separator: "\n")
      memoryOn = true
    } else {
      memoryFoldersRaw = ""
      memoryTagsRaw = ""
      memoryOn = false
    }
  }

  private func saveAndNext() {
    guard valid else { return }
    guard optionsReady else {
      flash = "已录选项内容：请点字母标记正确答案"
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        flash = ""
      }
      return
    }
    store.addMistake(build())
    persistMemory()
    qBlocks = [.text(id: UUID().uuidString.lowercased(), text: "")]
    aBlocks = [.text(id: UUID().uuidString.lowercased(), text: "")]
    options = ["", "", "", ""] // 选项恢复为空白 A–D，下一题从新开始
    answer = nil
    flash = "已保存 ✓，继续录入下一题"
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_800_000_000)
      flash = ""
    }
  }

  private func saveAndDone() {
    guard valid, optionsReady else { return }
    if editing != nil {
      store.updateMistake(build())
    } else {
      store.addMistake(build())
      persistMemory()
    }
    dismiss()
  }

  /// 编辑已有错题：停止输入 900ms 后自动保存，防止忘点保存丢内容
  private func scheduleAutosave() {
    guard editing != nil else { return }
    autosaveTask?.cancel()
    autosaveTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 900_000_000)
      guard !Task.isCancelled, !isBlocksEmpty(qBlocks), optionsReady else { return }
      store.updateMistake(build())
    }
  }
}
