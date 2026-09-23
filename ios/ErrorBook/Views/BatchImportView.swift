import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// MARK: - 批量导入（对应桌面端 BatchImportView）
// 相册多选 + 「文件」App 选文件夹（递归扫描子目录）；每张图可设为 题目图 / 解析图 / 跳过。

struct BatchRow: Identifiable {
  let id = UUID().uuidString
  var name: String
  var relDir: String
  enum Mode { case question, analysis, skip }
  var mode: Mode
  enum Source {
    case data(Data)
    case url(URL)
  }
  var source: Source
}

struct BatchImportView: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss

  @State private var rows: [BatchRow] = []
  @State private var tags: [String] = []
  @State private var rootFolderId: String?
  @State private var mirrorStructure = true
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var scanning = false
  @State private var importing = false
  @State private var progress = 0
  @State private var doneInfo: (questions: Int, analyses: Int)?
  @State private var errorMessage = ""
  @State private var folderPickOpen = false
  /// 文件导入的安全作用域：选中后保持访问直到视图关闭（导入时还要读文件）
  @State private var scopedFolder: URL?

  private var hasSubDirs: Bool { rows.contains { !$0.relDir.isEmpty } }

  private var groups: [(relDir: String, rows: [BatchRow])] {
    var order: [String] = []
    var map: [String: [BatchRow]] = [:]
    for r in rows {
      if map[r.relDir] == nil { order.append(r.relDir) }
      map[r.relDir, default: []].append(r)
    }
    return order.map { ($0, map[$0]!) }
  }

  private var counts: (q: Int, a: Int, s: Int) {
    var q = 0, a = 0, s = 0
    for r in rows {
      switch r.mode {
      case .question: q += 1
      case .analysis: a += 1
      case .skip: s += 1
      }
    }
    return (q, a, s)
  }

  var body: some View {
    NavigationStack {
      Group {
        if let done = doneInfo {
          VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
              .font(.system(size: 44))
              .foregroundStyle(.green)
            Text("导入完成").font(.title3.bold())
            Text("新增 \(done.questions) 道错题，附加 \(done.analyses) 张解析图。")
              .foregroundStyle(.secondary)
            HStack {
              Button("再导一批") { rows = []; doneInfo = nil }
              Button("去浏览") { dismiss() }
                .buttonStyle(.borderedProminent)
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if rows.isEmpty {
          sourcePicker
        } else {
            rowList
        }
      }
      .navigationTitle("批量导入")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(rows.isEmpty ? "关闭" : "取消") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if !rows.isEmpty, !importing {
            Button("导入 \(counts.q) 题") { runImport() }
              .bold()
              .disabled(counts.q == 0)
          }
        }
      }
      .onDisappear {
        if let u = scopedFolder {
          u.stopAccessingSecurityScopedResource()
          scopedFolder = nil
        }
      }
    }
  }

  // MARK: ① 选择来源

  private var sourcePicker: some View {
    ScrollView {
      VStack(spacing: 16) {
        EmptyStateView(
          icon: "photo.on.rectangle.angled",
          title: "批量导入截图",
          message: "从相册多选截图，或选择「文件」里的截图文件夹（连同子文件夹一起扫描）。默认每张图新开一道错题。"
        )
        .frame(minHeight: 240)

        VStack(spacing: 12) {
          PhotosPicker(selection: $photoItems, matching: .images) {
            Label("从相册选择（可多选）", systemImage: "photo.on.rectangle")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)

          Button {
            folderPickOpen = true
          } label: {
            Label("选择文件夹（含子文件夹）", systemImage: "folder")
                  .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .disabled(scanning)

          if scanning { ProgressView("扫描中…") }
          if !errorMessage.isEmpty {
            Text(errorMessage).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
          }
        }
        .padding(.horizontal)
      }
    }
    .onChange(of: photoItems) { items in
      loadPhotos(items)
    }
    .fileImporter(
      isPresented: $folderPickOpen,
      allowedContentTypes: [.folder],
      allowsMultipleSelection: false
    ) { result in
      switch result {
      case let .success(urls):
        guard let url = urls.first else { return }
        scanFolder(url)
      case let .failure(error):
        errorMessage = "读取文件夹失败：\(error.localizedDescription)"
      }
    }
  }

  private func loadPhotos(_ items: [PhotosPickerItem]) {
    guard !items.isEmpty else { return }
    photoItems = []
    scanning = true
    Task { @MainActor in
      var out: [BatchRow] = []
      for item in items {
        if let data = try? await item.loadTransferable(type: Data.self) {
          let name = (item.itemIdentifier ?? UUID().uuidString) + ".jpg"
          out.append(BatchRow(name: name, relDir: "", mode: .question, source: .data(data)))
        }
      }
      out.sort { String.naturalLess($0.name, $1.name) }
      rows = out
      scanning = false
      if out.isEmpty { errorMessage = "没有读取到图片" }
    }
  }

  private func scanFolder(_ url: URL) {
    errorMessage = ""
    scanning = true
    if let old = scopedFolder { old.stopAccessingSecurityScopedResource() }
    _ = url.startAccessingSecurityScopedResource()
    scopedFolder = url
    Task { @MainActor in
      defer { scanning = false }
      var out: [BatchRow] = []
      let fm = FileManager.default
      func walk(_ dir: URL, _ rel: String) {
        guard let children = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        for child in children.sorted(by: { String.naturalLess($0.lastPathComponent, $1.lastPathComponent) }) {
          var isDir: ObjCBool = false
          if fm.fileExists(atPath: child.path, isDirectory: &isDir), isDir.boolValue {
            guard !child.lastPathComponent.hasPrefix(".") else { continue }
            walk(child, rel.isEmpty ? child.lastPathComponent : "\(rel)/\(child.lastPathComponent)")
          } else if imageExts.contains(extOf(child.lastPathComponent)) {
            out.append(BatchRow(name: child.lastPathComponent, relDir: rel, mode: .question, source: .url(child)))
          }
        }
      }
      walk(url, "")
      if out.isEmpty {
        errorMessage = "该文件夹（含子文件夹）里没有图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）"
        rows = []
      } else {
        rows = out.sorted {
          $0.relDir != $1.relDir ? String.naturalLess($0.relDir, $1.relDir) : String.naturalLess($0.name, $1.name)
        }
      }
    }
  }

  // MARK: ② 确认每张图身份 + ③ 目标位置

  private var rowList: some View {
    Form {
      Section {
        Picker("导入到", selection: $rootFolderId) {
          Text(folderPathName(store.db.folders, rootFolderId)).tag(String?.none)
          ForEach(flatFolders(store.db.folders), id: \.folder.id) { item in
            Text(String(repeating: "　", count: item.depth) + item.folder.name).tag(String?.some(item.folder.id))
          }
        }
        if hasSubDirs {
          Toggle("按源文件夹结构自动创建子文件夹", isOn: $mirrorStructure)
        }
        TagInput(tags: $tags, suggestions: store.allTags)
      } header: {
        Text("③ 目标位置与标签")
      } footer: {
        Text("来自 \(groups.count) 个文件夹，将新增 \(counts.q) 道错题（含 \(counts.a) 张解析图，跳过 \(counts.s) 张）")
      }

      ForEach(groups, id: \.relDir) { group in
        Section {
          ForEach(group.rows) { row in
            BatchRowView(
              row: row,
              canAnalysis: anchorAvailable(row),
              importing: importing
            ) { mode in
              if let i = rows.firstIndex(where: { $0.id == row.id }) {
                rows[i].mode = mode
              }
            }
          }
        } header: {
          Text(group.relDir.isEmpty ? "（根目录）" : group.relDir)
        } footer: {
          if !group.relDir.isEmpty, mirrorStructure {
            Text("将创建子文件夹：\(group.relDir.replacingOccurrences(of: "/", with: " / "))")
          }
        }
      }

      if importing {
        Section {
          ProgressView(value: Double(progress), total: Double(max(rows.count, 1)))
          Text("\(progress) / \(rows.count)").font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
  }

  /// 第某行设为「解析图」需要前面（同分组）存在一道题目图
  private func anchorAvailable(_ row: BatchRow) -> Bool {
    var seen = false
    for r in rows {
      if r.id == row.id { return seen }
      if r.mode == .question, r.relDir == row.relDir { seen = true }
    }
    return false
  }

  // MARK: 导入执行

  private func runImport() {
    guard !importing else { return }
    importing = true
    progress = 0
    errorMessage = ""
    Task { @MainActor in
      var questions = 0
      var analyses = 0
      var currentId: String?
      var folderCache: [String: String?] = [:]
      do {
        for row in rows {
          defer { progress += 1 }
          guard row.mode != .skip else { continue }
          let bytes: Data
          switch row.source {
          case let .data(d): bytes = d
          case let .url(u): bytes = try Data(contentsOf: u)
          }
          let img: Block
          switch row.source {
          case .data:
            img = try ImageStore.importPhotoData(bytes, suggestedExt: "jpg", into: store.dataDir)
          case let .url(u):
            guard let b = try ImageStore.importFile(at: u, into: store.dataDir) else { continue }
            img = b
          }
          if row.mode == .analysis, let cid = currentId, var target = store.mistake(id: cid) {
            target.analysis.append(img)
            target.tags = Array(Set(target.tags + tags)).sorted()
            target.updatedAt = Date().nowMs
            store.updateMistake(target)
            analyses += 1
          } else {
            var folderId: String?
            if let cached = folderCache[row.relDir] {
              folderId = cached
            } else if mirrorStructure, !row.relDir.isEmpty {
              var parent = rootFolderId
              for seg in row.relDir.components(separatedBy: "/") {
                parent = store.findOrCreateFolder(name: seg, parentId: parent).id
              }
              folderId = parent
              folderCache[row.relDir] = parent
            } else {
              folderId = rootFolderId
              folderCache[row.relDir] = rootFolderId
            }
            let m = Mistake(folderIds: folderId.map { [$0] } ?? [], question: [img], analysis: [], tags: tags)
            store.addMistake(m)
            currentId = m.id
            questions += 1
          }
        }
        doneInfo = (questions, analyses)
        rows = []
      } catch {
        errorMessage = "导入中断：\(error.localizedDescription)（已导入的部分已保存）"
      }
      importing = false
    }
  }
}

private struct BatchRowView: View {
  let row: BatchRow
  let canAnalysis: Bool
  let importing: Bool
  let onMode: (BatchRow.Mode) -> Void

  @State private var thumb: UIImage?

  var body: some View {
    HStack(spacing: 10) {
      Group {
        if let thumb {
          Image(uiImage: thumb).resizable().scaledToFill()
        } else {
          Rectangle().fill(Color(.systemGray5))
        }
      }
      .frame(width: 56, height: 56)
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .task {
        switch row.source {
        case let .data(d): thumb = UIImage(data: d)
        case let .url(u): thumb = UIImage(contentsOfFile: u.path)
        }
      }

      VStack(alignment: .leading, spacing: 4) {
        Text(row.name).font(.footnote).lineLimit(1)
        Picker("", selection: modeBinding) {
          Text("题目图").tag(BatchRow.Mode.question)
          Text("解析图 ↩").tag(BatchRow.Mode.analysis)
          Text("跳过").tag(BatchRow.Mode.skip)
        }
        .pickerStyle(.segmented)
        .font(.caption)
      }
    }
    .disabled(importing)
  }

  private var modeBinding: Binding<BatchRow.Mode> {
    Binding(
      get: { row.mode },
      set: { onMode($0) }
    )
  }
}
