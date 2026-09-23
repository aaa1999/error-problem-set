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
      .navigationTitle(editing != nil ? "编辑错题" : "录入错题")
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

  // MARK: 选择题选项编辑器（选填，填了并标记正确答案，浏览时即可作答计错误率）

  @ViewBuilder
  private var optionsEditor: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("选项").font(.footnote.bold()).foregroundStyle(.secondary)
        if !options.isEmpty {
          Text("点 A / B / C / D 选中正确答案；全留空 = 非选择题").font(.caption).foregroundStyle(.tertiary)
        }
        Spacer()
        if options.count < 8 {
          Button {
            options.append("")
          } label: {
            Label("添加选项", systemImage: "plus")
          }
          .font(.footnote)
          .buttonStyle(.bordered)
        }
        if !options.isEmpty {
          Button {
            options = ["", "", "", ""]
            answer = nil
          } label: {
            Label("清空", systemImage: "trash")
          }
          .font(.footnote)
          .buttonStyle(.bordered)
        }
      }
      ForEach(options.indices, id: \.self) { i in
        HStack(spacing: 8) {
          // A/B/C/D 字母徽章：点击即选中为正确答案（实心高亮）
          Button {
            answer = i
          } label: {
            Text(String(UnicodeScalar(UInt8(65 + i))))
              .font(.subheadline.bold())
              .frame(width: 26, height: 26)
              .background(Circle().fill(answer == i ? Color.accentColor : Color(.systemGray5)))
              .foregroundStyle(answer == i ? Color.white : Color.secondary)
              .overlay(
                Circle().strokeBorder(answer == i ? Color.accentColor : Color.clear, lineWidth: 1.5)
              )
          }
          .buttonStyle(.plain)
          TextField("选项 \(String(UnicodeScalar(UInt8(65 + i)))) 内容", text: $options[i])
            .textFieldStyle(.roundedBorder)
          Button {
            options.remove(at: i)
            if answer == i {
              answer = nil
            } else if let a = answer, a > i {
              answer = a - 1
            }
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private func build() -> Mistake {
    let opts = options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
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

  /// 填了选项必须标记正确答案（或清空选项）
  private var optionsReady: Bool {
    let opts = options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return opts.isEmpty || answer != nil
  }

  private func saveAndNext() {
    guard valid else { return }
    guard optionsReady else {
      flash = "已填选项：请点 A / B / C / D 选中正确答案，或清空选项"
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        flash = ""
      }
      return
    }
    store.addMistake(build())
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
