import SwiftUI
import UniformTypeIdentifiers

// MARK: - 设置：数据目录、合并导入、同步、关于

struct SettingsView: View {
  @EnvironmentObject private var store: BookStore

  @State private var folderPickOpen = false
  @State private var plan: MergePlan?
  /// 选中的源目录安全作用域：从选定保持到合并结束
  @State private var scopedDir: URL?
  @State private var merging = false
  @State private var mergeProgress: (done: Int, total: Int) = (0, 0)
  @State private var mergeResult = ""
  @State private var errorMessage = ""
  @State private var syncOpen = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          LabeledContent("错题", value: "\(store.db.mistakes.count) 道")
          LabeledContent("笔记", value: "\(store.db.notes.count) 篇")
          LabeledContent("文件夹", value: "\(store.db.folders.count) 个")
          LabeledContent("数据目录") {
            Text(store.dataDir.path)
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
              .lineLimit(2)
              .multilineTextAlignment(.trailing)
              .textSelection(.enabled)
          }
        } header: {
          Text("数据")
        } footer: {
          Text("数据保存在本机 App 的「错题本」文件夹（data.json + assets 图片），通过「文件」App 或电脑 Finder（设备 → 文件共享 → 错题本）可见，可直接与桌面版互拷整目录。删除操作有备份，旧版本在 snapshots/ 里保留最近 20 份。")
        }

        Section {
          Button {
            folderPickOpen = true
          } label: {
            Label("从数据目录合并导入…", systemImage: "square.stack.3d.down.right")
          }
          .disabled(merging)
          if let plan {
            mergePlanRow(plan)
          }
          if merging {
            ProgressView(value: Double(mergeProgress.done), total: Double(max(mergeProgress.total, 1)))
            Text("\(mergeProgress.done) / \(mergeProgress.total)").font(.footnote).foregroundStyle(.secondary)
          }
          if !mergeResult.isEmpty {
            Text(mergeResult).font(.footnote).foregroundStyle(.green)
          }
          if !errorMessage.isEmpty {
            Text(errorMessage).font(.footnote).foregroundStyle(.red)
          }
        } header: {
          Text("合并导入")
        } footer: {
          Text("把桌面端（或其他设备）的数据文件夹拷到本机后选择它：题目、文件夹、标签整体合并进来。选到上一级也能识别（向下扫两层）；已导入过的自动跳过，可重复执行。")
        }

        Section("同步") {
          Button {
            syncOpen = true
          } label: {
                Label("推送到自建服务器", systemImage: "icloud.and.arrow.up")
          }
          if let t = SyncStore.load() {
            LabeledContent("已记住", value: t.server)
          }
        }

        Section {
          NavigationLink {
            FolderManageView()
          } label: {
            Label("文件夹管理", systemImage: "folder.badge.gearshape")
          }
        } header: {
          Text("整理")
        } footer: {
          Text("新建/重命名/删除文件夹；删除文件夹时其中错题移到未分类，子文件夹上移一级。")
        }

        Section("关于") {
          LabeledContent("版本", value: "0.7.0 (iOS)")
          LabeledContent("桌面端", value: "数据格式完全互通")
          Text("Word 富文本笔记在 iOS 端为只读（可导出），编辑请用桌面端。")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("设置")
      .sheet(isPresented: $syncOpen) { SyncView() }
      .onDisappear {
        if let u = scopedDir {
          u.stopAccessingSecurityScopedResource()
          scopedDir = nil
        }
      }
      .fileImporter(
        isPresented: $folderPickOpen,
        allowedContentTypes: [.folder],
        allowsMultipleSelection: false
      ) { result in
        switch result {
        case let .success(urls):
          guard let url = urls.first else { return }
          pickMergeSource(url)
        case let .failure(error):
          errorMessage = "读取失败：\(error.localizedDescription)"
        }
      }
    }
  }

  // MARK: 合并导入

  @ViewBuilder
  private func mergePlanRow(_ plan: MergePlan) -> some View {
    if merging {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Text("源：\(plan.sourceDir?.lastPathComponent ?? "远程")")
          .font(.footnote.bold())
        Text("\(plan.source.mistakes.count) 道错题、\(plan.source.notes.count) 篇笔记、\(plan.source.folders.count) 个文件夹：将导入 \(plan.newMistakes.count) 道错题、\(plan.newNotes.count) 篇笔记（含 \(plan.imageCount) 张图片）\(plan.newTags.isEmpty ? "" : "、\(plan.newTags.count) 个标签")，跳过已存在 \(plan.skipped) 道、\(plan.skippedNotes) 篇。")
          .font(.footnote)
          .foregroundStyle(.secondary)
        HStack {
          Button("取消") {
            self.plan = nil
          }
          Button("开始合并") {
            runMergePlan()
          }
          .buttonStyle(.borderedProminent)
        }
        .font(.footnote)
      }
      .padding(.vertical, 2)
    }
  }

  private func pickMergeSource(_ url: URL) {
    errorMessage = ""
    mergeResult = ""
    if let old = scopedDir { old.stopAccessingSecurityScopedResource() }
    _ = url.startAccessingSecurityScopedResource()
    scopedDir = url
    do {
      let dir = try findDataDir(root: url)
      plan = try buildMergePlan(sourceDir: dir, current: store.db)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func runMergePlan() {
    guard let plan else { return }
    merging = true
    mergeProgress = (0, plan.newMistakes.count + plan.newNotes.count + plan.imageCount)
    errorMessage = ""
    Task { @MainActor in
      defer { merging = false }
      do {
        mergeResult = try await runMerge(plan: plan, store: store) { done, total in
          mergeProgress = (done, total)
        }
        self.plan = nil
      } catch {
        errorMessage = "合并中断：\(error.localizedDescription)（可重新执行，已导入的会自动跳过）"
      }
    }
  }
}

// MARK: - 文件夹管理（对应桌面端 Sidebar 的文件夹树管理）

struct FolderManageView: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss

  @State private var newName = ""
  @State private var newParent: String?
  @State private var renaming: Folder?
  @State private var renameDraft = ""
  @State private var deleting: Folder?

  var body: some View {
    NavigationStack {
      List {
        Section("新建文件夹") {
          Picker("上级文件夹", selection: $newParent) {
            Text("（根层级）").tag(String?.none)
            ForEach(flatFolders(store.db.folders), id: \.folder.id) { item in
              Text(String(repeating: "　", count: item.depth) + item.folder.name).tag(String?.some(item.folder.id))
            }
          }
          HStack {
            TextField("新文件夹名称", text: $newName)
            Button("创建") {
              let n = newName.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !n.isEmpty else { return }
              store.createFolder(name: n, parentId: newParent)
              newName = ""
            }
          }
        }

        Section("已有文件夹") {
          let flats = flatFolders(store.db.folders)
          if flats.isEmpty {
            Text("还没有文件夹").foregroundStyle(.secondary)
          }
          ForEach(flats, id: \.folder.id) { item in
            HStack {
              Text(String(repeating: "　", count: item.depth) + item.folder.name)
              Spacer()
              Text("\(countInFolder(store.db.mistakes, store.db.folders, item.folder.id)) 题")
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
            .swipeActions {
              Button(role: .destructive) {
                deleting = item.folder
              } label: {
                Label("删除", systemImage: "trash")
              }
              Button {
                renameDraft = item.folder.name
                renaming = item.folder
              } label: {
                Label("重命名", systemImage: "pencil")
              }
            }
          }
        }
      }
      .navigationTitle("文件夹管理")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } }
      }
      .alert("重命名文件夹", isPresented: Binding(
        get: { renaming != nil },
        set: { if !$0 { renaming = nil } }
      )) {
        TextField("名称", text: $renameDraft)
        Button("确定") {
          if let f = renaming {
            store.renameFolder(f.id, renameDraft)
          }
          renaming = nil
        }
        Button("取消", role: .cancel) { renaming = nil }
      }
      .alert("删除文件夹「\(deleting?.name ?? "")」？", isPresented: Binding(
        get: { deleting != nil },
        set: { if !$0 { deleting = nil } }
      )) {
        Button("删除", role: .destructive) {
          if let f = deleting { store.deleteFolder(f.id) }
          deleting = nil
        }
        Button("取消", role: .cancel) { deleting = nil }
      } message: {
        Text("其中错题移到未分类，子文件夹上移一级")
      }
    }
  }
}
