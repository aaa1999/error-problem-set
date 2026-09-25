import SwiftUI

// MARK: - 错题本浏览（对应桌面端 BrowseView：一页一题，离线翻页复习）

struct BrowseTab: View {
  @EnvironmentObject private var store: BookStore

  /// "" 全部 | "uncat" 未分类 | 文件夹 id
  @State private var selectedFolder = ""
  @State private var activeTags: [String] = []
  @State private var tagModeAnd = true
  @State private var index = 0
  @State private var revealed = false
  /// 排列方式（time | random），@AppStorage 跨启动保持；随机用 seed 固定的稳定洗牌
  @AppStorage("browseOrder") private var orderRaw = "time"
  @State private var shuffleSeed = UInt32.random(in: 1...UInt32.max)

  @State private var entryTarget: Mistake?
  @State private var entryNew = false
  @State private var batchOpen = false
  @State private var syncOpen = false
  @State private var moveOpen = false
  @State private var moveSel: [String] = []
  @State private var tagSheetFor: Mistake?
  @State private var lightbox: URL?
  @State private var newTagOpen = false
  @State private var newTagDraft = ""
  /// 题号总览：当前筛选（文件夹 + 标签）下的全部题展开成题号，点题号跳题
  @State private var numOpen = false
  // 录入三入口：普通 = entryNew；文件夹/标签录入先选目标再进录入页
  @State private var folderEntryOpen = false
  @State private var folderEntrySel: [String] = []
  @State private var folderEntryDraft = ""
  @State private var tagEntryOpen = false
  @State private var tagEntrySel: [String] = []
  @State private var entryPreset: EntryPreset?

  private var list: [Mistake] {
    var arr = store.db.mistakes
    let folders = store.db.folders
    if selectedFolder == "uncat" {
      let ids = Set(folders.map { $0.id })
      arr = arr.filter { m in !m.folderIds.contains { ids.contains($0) } }
    } else if selectedFolder == "cat" {
      // 已分类 = 至少属于一个文件夹
      let ids = Set(folders.map { $0.id })
      arr = arr.filter { m in m.folderIds.contains { ids.contains($0) } }
    } else if !selectedFolder.isEmpty {
      let set = descendantSet(folders, selectedFolder)
      arr = arr.filter { m in m.folderIds.contains { set.contains($0) } }
    }
    if !activeTags.isEmpty {
      arr = arr.filter { m in
        tagModeAnd ? activeTags.allSatisfy { m.tags.contains($0) } : activeTags.contains { m.tags.contains($0) }
      }
    }
    // 时间：按录入时间升序；错误率：只排带选项且标记了答案的题（高 → 低 → 作答多 → 先录入）；
    // 随机：seed 固定的稳定洗牌（换 seed 才换序，翻页中途不跳）
    if orderRaw == "random" {
      return seededShuffle(arr, seed: shuffleSeed)
    }
    if orderRaw == "error" {
      return arr
        .filter { !$0.options.isEmpty && $0.answer != nil }
        .sorted { optionRate($0) == optionRate($1) ? ($0.attempts == $1.attempts ? $0.createdAt < $1.createdAt : $0.attempts > $1.attempts) : optionRate($0) > optionRate($1) }
    }
    return arr.sorted { $0.createdAt < $1.createdAt }
  }

  /// 进入随机模式：每次进入都换一批新顺序
  private func enterRandom() {
    if orderRaw != "random" {
      shuffleSeed = .random(in: 1...UInt32.max)
    }
    orderRaw = "random"
  }

  private var crumb: String {
    if selectedFolder.isEmpty { return "全部错题" }
    if selectedFolder == "uncat" { return "未分类" }
    if selectedFolder == "cat" { return "已分类" }
    return folderPathName(store.db.folders, selectedFolder)
  }

  var body: some View {
    NavigationStack {
      // filterBar 常驻（空列表也显示）：排列方式与筛选菜单永远可达，
      // 避免错误率排序下点到没有选择题的文件夹时被困在空态里
      VStack(spacing: 0) {
        filterBar
        if list.isEmpty {
          emptyState
        } else {
          cardPager
          bottomBar
        }
      }
      .navigationTitle(crumb)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarContent }
      .sheet(item: $entryTarget) { m in
        EntrySheet(editing: m)
      }
      .sheet(isPresented: $entryNew) {
        EntrySheet(editing: nil)
      }
      .sheet(isPresented: $batchOpen) {
        BatchImportView()
      }
      .sheet(isPresented: $syncOpen) {
        SyncView()
      }
      .sheet(isPresented: $moveOpen) {
        moveSheet
      }
      .sheet(item: $tagSheetFor) { m in
        TagEditSheet(mistakeId: m.id)
      }
      .fullScreenCover(item: Binding(
        get: { lightbox.map { LightboxItem(url: $0) } },
        set: { lightbox = $0?.url }
      )) { item in
        LightboxView(url: item.url)
      }
      .alert("新建标签", isPresented: $newTagOpen) {
        TextField("标签名称", text: $newTagDraft)
        Button("新建") {
          store.createTag(newTagDraft)
          newTagDraft = ""
        }
        Button("取消", role: .cancel) { newTagDraft = "" }
      } message: {
        Text("预建标签不挂在错题上也保留，方便提前规划标签体系")
      }
      .sheet(isPresented: $numOpen) {
        NumberOverviewSheet(list: list, current: index) { i in
          index = i
        }
      }
      .sheet(isPresented: $folderEntryOpen) { folderEntrySheet }
      .sheet(isPresented: $tagEntryOpen) { tagEntrySheet }
      .sheet(item: $entryPreset) { p in
        EntrySheet(editing: nil, presetFolders: p.folders, presetTags: p.tags)
      }
    }
    .onChange(of: selectedFolder) { _ in index = 0; revealed = false }
    .onReceive(NotificationCenter.default.publisher(for: .errorbookMoveRequest)) { note in
      // 卡片菜单里的「移动到文件夹」→ 打开本视图的移动面板
      if let id = note.object as? String, current?.id == id {
        moveOpen = true
      } else if current != nil {
        moveOpen = true
      }
    }
    .onChange(of: activeTags) { _ in index = 0; revealed = false }
    .onChange(of: tagModeAnd) { _ in index = 0; revealed = false }
    .onChange(of: orderRaw) { _ in index = 0; revealed = false }
    .onChange(of: shuffleSeed) { _ in index = 0; revealed = false }
    .onChange(of: index) { _ in revealed = false }
    .onChange(of: list.count) { count in
      if index >= count { index = max(0, count - 1) }
    }
  }

  // MARK: 空状态

  private var emptyState: some View {
    EmptyStateView(
      icon: store.db.mistakes.isEmpty ? "books.vertical" : "line.3.horizontal.decrease.circle",
      title: store.db.mistakes.isEmpty ? "还没有错题" : "当前条件下没有错题",
      message: store.db.mistakes.isEmpty
        ? "先录入第一道题，或把攒了一堆的截图批量导入进来。"
        : orderRaw == "error"
          ? "没有带选项的错题——错误率排序只统计录入时填了选项并标记了正确答案的题；也可换文件夹或标签筛选条件试试。"
          : "换个文件夹或标签筛选条件试试。",
      actionTitle: store.db.mistakes.isEmpty ? "＋ 录入错题" : "清除筛选",
      action: store.db.mistakes.isEmpty ? { entryNew = true } : {
        selectedFolder = ""
        activeTags = []
      }
    )
  }

  // MARK: 筛选栏

  private var filterBar: some View {
    HStack(spacing: 10) {
      Menu {
        Button("全部错题") { selectedFolder = "" }
        Button("已分类（\(countCategorized(store.db.mistakes, store.db.folders))）") { selectedFolder = "cat" }
        Button("未分类（\(countUncategorized(store.db.mistakes, store.db.folders))）") { selectedFolder = "uncat" }
        Divider()
        ForEach(flatFolders(store.db.folders), id: \.folder.id) { item in
          Button {
            selectedFolder = item.folder.id
          } label: {
            HStack {
              Text(String(repeating: "　", count: item.depth) + item.folder.name)
              Spacer()
              Text("\(countInFolder(store.db.mistakes, store.db.folders, item.folder.id))").foregroundStyle(.secondary)
            }
          }
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "folder")
          Text(crumb).lineLimit(1)
          Image(systemName: "chevron.up.chevron.down").font(.caption2)
        }
        .font(.subheadline)
      }

      if !activeTags.isEmpty || !selectedFolder.isEmpty {
        // 当前条件一目了然：文件夹 / 标签各是可单独移除的 chip，末尾一键重置
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            if !selectedFolder.isEmpty {
              TagChip(text: selectedFolder == "uncat" ? "未分类" : folderPathName(store.db.folders, selectedFolder)) {
                selectedFolder = ""
              }
            }
            ForEach(activeTags, id: \.self) { t in
              TagChip(text: t) {
                activeTags.removeAll { $0 == t }
              }
            }
            Button {
              selectedFolder = ""
              activeTags = []
            } label: {
              Label("重置", systemImage: "arrow.counterclockwise")
                .font(.caption)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color.red.opacity(0.12)))
                .foregroundStyle(.red)
            }
            .buttonStyle(.plain)
          }
        }
        if activeTags.count >= 2 {
          Button(tagModeAnd ? "同时含" : "含任一") {
            tagModeAnd.toggle()
          }
          .font(.caption)
          .buttonStyle(.bordered)
        }
      } else {
        Spacer()
        Menu {
          Toggle("需同时包含（且）", isOn: $tagModeAnd)
          Button {
            newTagOpen = true
          } label: {
            Label("新建标签…", systemImage: "plus")
          }
          if store.tagCounts.isEmpty {
            Text("还没有标签")
          } else {
            Divider()
            ForEach(store.tagCounts, id: \.0) { tag, count in
              Button("\(tag)（\(count)）") {
                activeTags.append(tag)
              }
            }
          }
        } label: {
          HStack(spacing: 4) {
            Image(systemName: "tag")
            Text("标签")
            Image(systemName: "chevron.up.chevron.down").font(.caption2)
          }
          .font(.subheadline)
        }
        Spacer()
      }

      // 排列方式：按录入时间 / 按错误率 / 随机（稳定洗牌，点「随机」再点一次换一批）
      Menu {
        Button {
          orderRaw = "time"
        } label: {
          Label("按录入时间（旧 → 新）", systemImage: orderRaw == "time" ? "checkmark" : "clock")
        }
        Button {
          orderRaw = "error"
        } label: {
          Label("按错误率（高 → 低，只看带选项的题）", systemImage: orderRaw == "error" ? "checkmark" : "chart.bar")
        }
        Button {
          enterRandom()
        } label: {
          Label("随机排列（复习防背序）", systemImage: orderRaw == "random" ? "checkmark" : "shuffle")
        }
        if orderRaw == "random" {
          Divider()
          Button {
            shuffleSeed = .random(in: 1...UInt32.max)
          } label: {
            Label("重新洗牌（换一批）", systemImage: "arrow.triangle.2.circlepath")
          }
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: orderRaw == "random" ? "shuffle" : orderRaw == "error" ? "chart.bar" : "clock")
          Text(orderRaw == "random" ? "随机" : orderRaw == "error" ? "错误率" : "时间")
          Image(systemName: "chevron.up.chevron.down").font(.caption2)
        }
        .font(.subheadline)
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 8)
    .background(Color(.systemBackground))
  }

  // MARK: 翻页卡

  private var cardPager: some View {
    TabView(selection: $index) {
      ForEach(Array(list.enumerated()), id: \.element.id) { idx, m in
        MistakeCardView(
          mistake: m,
          revealed: revealed,
          onReveal: { revealed = true },
          onImageTap: { url in lightbox = url },
          onEdit: { entryTarget = m },
          onTagEdit: { tagSheetFor = m }
        )
        .tag(idx)
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
      }
    }
    .tabViewStyle(.page(indexDisplayMode: .never))
  }

  // MARK: 底栏

  private var bottomBar: some View {
    HStack {
      Button {
        if index > 0 { index -= 1 }
      } label: {
        Image(systemName: "chevron.left").font(.title3.weight(.semibold))
      }
      .disabled(index == 0)

      Spacer()

      Button {
        numOpen = true
      } label: {
        HStack(spacing: 5) {
          Image(systemName: "square.grid.3x3")
          Text("\(list.count > 0 ? index + 1 : 0) / \(list.count)")
            .monospacedDigit()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
      }
      .accessibilityLabel("题号总览，当前第 \(index + 1) 题，共 \(list.count) 题")

      Spacer()

      Button {
        if index < list.count - 1 { index += 1 }
      } label: {
        Image(systemName: "chevron.right").font(.title3.weight(.semibold))
      }
      .disabled(index >= list.count - 1)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 10)
    .background(.ultraThinMaterial)
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      // 录入三入口：普通 / 文件夹 / 标签
      Menu {
        Button { entryNew = true } label: { Label("普通录入", systemImage: "square.and.pencil") }
        Button {
          folderEntrySel = []
          folderEntryOpen = true
        } label: { Label("文件夹录入", systemImage: "folder.badge.plus") }
        Button {
          tagEntrySel = []
          tagEntryOpen = true
        } label: { Label("标签录入", systemImage: "tag.badge.plus") }
        Divider()
        Button { batchOpen = true } label: { Label("批量导入截图", systemImage: "photo.on.rectangle.angled") }
      } label: {
        Label("添加", systemImage: "plus")
      }
      Button { syncOpen = true } label: { Label("同步", systemImage: "icloud.and.arrow.up") }
    }
  }

  // MARK: 文件夹录入 / 标签录入：先选目标再进录入页

  private var folderEntrySheet: some View {
    NavigationStack {
      List {
        FolderMultiPicker(folders: store.db.folders, value: $folderEntrySel)
        // 输入名称直接新建并勾选：支持 a/b/c 层级，从根逐级创建，勾选最深层级
        Section("新建文件夹") {
          HStack {
            TextField("名称，可用 / 分层（如 数学/三角函数）", text: $folderEntryDraft)
            Button("新建并选中") {
              let name = folderEntryDraft.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !name.isEmpty else { return }
              if let f = store.findOrCreateFolderPath(name, baseParentId: nil) {
                if !folderEntrySel.contains(f.id) { folderEntrySel.append(f.id) }
              }
              folderEntryDraft = ""
            }
            .disabled(folderEntryDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }
      .navigationTitle("文件夹录入")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("取消") { folderEntryOpen = false } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("开始录入") {
            folderEntryOpen = false
            entryPreset = EntryPreset(folders: folderEntrySel, tags: [])
          }
          .disabled(folderEntrySel.isEmpty)
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private var tagEntrySheet: some View {
    NavigationStack {
      List {
        if store.allTags.isEmpty {
          Text("还没有标签：先在标签菜单里新建，或普通录入后在题上打标签")
            .foregroundStyle(.secondary)
        } else {
          ForEach(store.allTags, id: \.self) { t in
            Button {
              if let i = tagEntrySel.firstIndex(of: t) {
                tagEntrySel.remove(at: i)
              } else {
                tagEntrySel.append(t)
              }
            } label: {
              HStack {
                Text(t)
                Spacer()
                if tagEntrySel.contains(t) {
                  Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                }
              }
            }
          }
        }
      }
      .navigationTitle("标签录入")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("取消") { tagEntryOpen = false } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("开始录入") {
            tagEntryOpen = false
            entryPreset = EntryPreset(folders: [], tags: tagEntrySel)
          }
          .disabled(tagEntrySel.isEmpty)
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  // MARK: 调整所属文件夹

  private var moveSheet: some View {
    NavigationStack {
      List {
        Section {
          Button {
            moveSel = []
          } label: {
            HStack {
              Text("未分类")
              Spacer()
              if moveSel.isEmpty { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
          }
        }
        Section("文件夹（可多选）") {
          ForEach(flatFolders(store.db.folders), id: \.folder.id) { item in
            Button {
              if let i = moveSel.firstIndex(of: item.folder.id) {
                moveSel.remove(at: i)
              } else {
                moveSel.append(item.folder.id)
              }
            } label: {
              HStack {
                Text(String(repeating: "　", count: item.depth) + item.folder.name)
                Spacer()
                if moveSel.contains(item.folder.id) {
                  Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                }
              }
            }
          }
        }
      }
      .navigationTitle("调整所属文件夹")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("取消") { moveOpen = false } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("保存") {
            if let cur = current {
              store.setMistakeFolders(cur.id, moveSel)
            }
            moveOpen = false
          }
        }
      }
      .onAppear { moveSel = current?.folderIds ?? [] }
    }
    .presentationDetents([.medium, .large])
  }

  private var current: Mistake? {
    list.indices.contains(index) ? list[index] : nil
  }
}

private struct LightboxItem: Identifiable {
  let url: URL
  var id: String { url.absoluteString }
}

/// 录入入口预设（文件夹录入 / 标签录入）
private struct EntryPreset: Identifiable {
  let folders: [String]
  let tags: [String]
  var id: String { folders.joined(separator: ",") + "|" + tags.joined(separator: ",") }
}

// MARK: - 题号总览（对应桌面端 num-overview 弹层）
// 当前筛选（文件夹 + 标签）与排列方式下的全部题按导入日期分组展开成题号网格：点题号跳题
// 红 = 错过 · 绿 = 作答全对 · 灰 = 未作答 / 非选择题 · 蓝框 = 当前题

struct NumberOverviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  let list: [Mistake]
  let current: Int
  let onPick: (Int) -> Void

  private struct DayItem: Identifiable {
    let i: Int
    let m: Mistake
    var id: String { m.id }
  }
  private struct DayGroup: Identifiable {
    let day: String
    let items: [DayItem]
    var id: String { day }
  }

  /// 按导入日期分组：组序跟随当前排列（时间排序下即由旧到新），同一天的题归到同组
  private var groups: [DayGroup] {
    var order: [String] = []
    var byDay: [String: [DayItem]] = [:]
    for (i, m) in list.enumerated() {
      let day = formatDay(m.createdAt)
      if byDay[day] == nil { order.append(day) }
      byDay[day, default: []].append(DayItem(i: i, m: m))
    }
    return order.map { DayGroup(day: $0, items: byDay[$0] ?? []) }
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            ForEach(groups) { g in
              VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                  Text(g.day).font(.footnote.bold()).monospacedDigit()
                  Text("\(g.items.count) 题").font(.caption2)
                }
                .foregroundStyle(.secondary)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
                  ForEach(g.items) { item in
                    Button {
                      onPick(item.i)
                      dismiss()
                    } label: {
                      Text("\(item.i + 1)")
                        .font(.subheadline.bold().monospacedDigit())
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(RoundedRectangle(cornerRadius: 8).fill(cellBg(item.m)))
                        .foregroundStyle(cellFg(item.m))
                        .overlay(
                          // 当前题蓝框描边，长列表里好定位
                          RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(item.i == current ? Color.accentColor : .clear, lineWidth: 2)
                        )
                    }
                    .buttonStyle(.plain)
                    .id(item.m.id)
                    .accessibilityLabel("第 \(item.i + 1) 题\(item.i == current ? "，当前题" : "")，\(formatDay(item.m.createdAt)) 导入\(cellNote(item.m))")
                  }
                }
              }
            }
          }
          .padding(14)
        }
        .onAppear {
          // 打开时滚到当前题
          if list.indices.contains(current) {
            proxy.scrollTo(list[current].id, anchor: .center)
          }
        }
      }
      .navigationTitle("题号总览（\(list.count) 题）")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("关闭") { dismiss() } }
      }
      .safeAreaInset(edge: .bottom) {
        Text("按导入日期分组 · 红 = 错过 · 绿 = 作答全对 · 灰 = 未作答 / 非选择题；点题号跳转")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity)
          .background(.ultraThinMaterial)
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func cellBg(_ m: Mistake) -> Color {
    if m.wrong > 0 { return Color.red.opacity(0.15) }
    if m.attempts > 0 { return Color.green.opacity(0.15) }
    return Color(.systemGray6)
  }

  private func cellFg(_ m: Mistake) -> Color {
    if m.wrong > 0 { return .red }
    if m.attempts > 0 { return .green }
    return .secondary
  }

  private func cellNote(_ m: Mistake) -> String {
    if m.wrong > 0 { return "，错过 \(m.wrong) 次" }
    if m.attempts > 0 { return "，作答全对" }
    return "，未作答"
  }
}

// MARK: - 单题卡片

struct MistakeCardView: View {
  @EnvironmentObject private var store: BookStore
  let mistake: Mistake
  let revealed: Bool
  let onReveal: () -> Void
  let onImageTap: (URL) -> Void
  let onEdit: () -> Void
  let onTagEdit: () -> Void

  @State private var confirmDelete = false
  // 一键复制整道题的短暂反馈
  @State private var copiedFlash = false
  // 选择题作答：本次浏览内每题只作答一次，答完自动看解析并累计统计（落盘）
  @State private var picked: Int?

  private var analysisEmpty: Bool { isBlocksEmpty(mistake.analysis) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        tagRow
        Text("题目").font(.caption.bold()).foregroundStyle(.secondary)
        BlockListView(blocks: mistake.question, onImageTap: onImageTap)

        if !mistake.options.isEmpty, mistake.answer != nil {
          optionBlock
        }

        Divider().padding(.vertical, 4)

        if revealed || analysisEmpty {
          Text("解析").font(.caption.bold()).foregroundStyle(.secondary)
          if analysisEmpty {
            HStack {
              Text("这道题还没有解析").font(.subheadline).foregroundStyle(.secondary)
              Button("去补解析", action: onEdit).font(.subheadline)
            }
          } else {
            BlockListView(blocks: mistake.analysis, onImageTap: onImageTap)
          }
        } else {
          Button(action: onReveal) {
            Label("点击查看解析", systemImage: "eye")
              .frame(maxWidth: .infinity)
              .padding(.vertical, 18)
              .background(RoundedRectangle(cornerRadius: 12).fill(Color(.systemGray6)))
          }
          .buttonStyle(.plain)
        }

        HStack {
          Text(formatTime(mistake.updatedAt))
            .font(.caption2)
            .foregroundStyle(.tertiary)
          if copiedFlash {
            Label("已复制（含图片）", systemImage: "checkmark.circle.fill")
              .font(.caption2)
              .foregroundStyle(.green)
          }
          Spacer()
          Menu {
            Button {
              copyMistakeToPasteboard(mistake, folders: store.db.folders, dataDir: store.dataDir, questionOnly: true)
              copiedFlash = true
              Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_600_000_000)
                copiedFlash = false
              }
            } label: {
              Label("只复制题目（含图片）", systemImage: "doc.on.doc")
            }
            Button {
              copyMistakeToPasteboard(mistake, folders: store.db.folders, dataDir: store.dataDir)
              copiedFlash = true
              Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_600_000_000)
                copiedFlash = false
              }
            } label: {
              Label("复制全部内容（题目、选项、解析…）", systemImage: "doc.on.doc.fill")
            }
            Button(action: onEdit) { Label("编辑", systemImage: "pencil") }
            Button(action: onTagEdit) { Label("标签", systemImage: "tag") }
            Button { moveRequested() } label: { Label("调整所属文件夹", systemImage: "folder") }
            Divider()
            Button(role: .destructive) { confirmDelete = true } label: { Label("删除", systemImage: "trash") }
          } label: {
            Image(systemName: "ellipsis.circle")
          }
        }
      }
      .padding(14)
    }
    .background(RoundedRectangle(cornerRadius: 16).fill(Color(.systemBackground)))
    .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
    .alert("确定删除这道题吗？", isPresented: $confirmDelete) {
      Button("删除", role: .destructive) { store.deleteMistake(mistake.id) }
      Button("取消", role: .cancel) {}
    } message: {
      Text("旧数据在数据目录的 snapshots 里还有备份")
    }
    .onTapGesture {} // 占位，避免误穿透
    .onChange(of: mistake.id) { _ in picked = nil } // 换题重置作答
  }

  // MARK: 选择题作答

  private func answerOption(_ i: Int) {
    guard picked == nil, let ans = mistake.answer else { return }
    picked = i
    onReveal() // 答完自动翻开解析
    let ok = i == ans
    store.updateMistake(
      Mistake(id: mistake.id, folderIds: mistake.folderIds, options: mistake.options, answer: mistake.answer,
              attempts: mistake.attempts + 1, wrong: mistake.wrong + (ok ? 0 : 1),
              question: mistake.question, analysis: mistake.analysis, tags: mistake.tags,
              createdAt: mistake.createdAt, updatedAt: Date().nowMs)
    )
  }

  private var optionBlock: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("作答").font(.caption.bold()).foregroundStyle(.secondary)
        Text("错误率 \(optionRate(mistake))%（\(mistake.wrong)/\(mistake.attempts)）")
          .font(.caption.bold())
          .foregroundStyle(
            mistake.attempts == 0 ? Color.secondary : optionRate(mistake) >= 50 ? Color.red : Color.green
          )
        Spacer()
      }
      ForEach(mistake.options.indices, id: \.self) { i in
        let answered = picked != nil
        let isCorrect = i == mistake.answer
        let isWrongPick = answered && i == picked && !isCorrect
        Button {
          answerOption(i)
        } label: {
          HStack(spacing: 10) {
            Text(String(UnicodeScalar(UInt8(65 + i))))
              .font(.subheadline.bold())
              .frame(width: 24, height: 24)
              .background(Circle().fill(Color(.systemGray5)))
            Text(mistake.options[i])
              .font(.subheadline)
              .multilineTextAlignment(.leading)
              .frame(maxWidth: .infinity, alignment: .leading)
            if answered && isCorrect {
              Label(picked == i ? "选对了" : "正确答案", systemImage: "checkmark")
                .font(.caption)
                .foregroundStyle(.green)
            }
            if isWrongPick {
              Label("你的选择", systemImage: "xmark")
                .font(.caption)
                .foregroundStyle(.red)
            }
          }
          .padding(.vertical, 9)
          .padding(.horizontal, 12)
          .background(
            RoundedRectangle(cornerRadius: 10).fill(
              answered && isCorrect ? Color.green.opacity(0.12)
              : isWrongPick ? Color.red.opacity(0.12)
              : Color(.systemGray6)
            )
          )
          .overlay(
            RoundedRectangle(cornerRadius: 10)
              .strokeBorder(
                answered && isCorrect ? Color.green.opacity(0.6)
                : isWrongPick ? Color.red.opacity(0.6)
                : Color.clear,
                lineWidth: 1
              )
          )
        }
        .buttonStyle(.plain)
        .disabled(answered)
      }
    }
  }

  private var tagRow: some View {
    FlowLayout(spacing: 6) {
      // 所属文件夹 chip：淡灰与标签区分；未分类的题也显示「未分类」
      if mistake.folderIds.isEmpty {
        folderChip(name: "未分类")
      } else {
        ForEach(mistake.folderIds, id: \.self) { fid in
          if let f = store.db.folders.first(where: { $0.id == fid }) {
            folderChip(name: f.name)
          }
        }
      }
      ForEach(mistake.tags, id: \.self) { t in
        TagChip(text: t)
      }
      Button(action: onTagEdit) {
        Label("标签", systemImage: "plus")
          .font(.caption)
          .padding(.horizontal, 9)
          .padding(.vertical, 4)
          .background(Capsule().fill(Color(.systemGray5)))
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)
    }
  }

  private func folderChip(name: String) -> some View {
    HStack(spacing: 3) {
      Image(systemName: "folder").font(.system(size: 9))
      Text(name)
    }
    .font(.caption)
    .padding(.horizontal, 9)
    .padding(.vertical, 4)
    .background(Capsule().fill(Color(.systemGray5)))
    .foregroundStyle(.secondary)
  }

  private func moveRequested() {
    NotificationCenter.default.post(name: .errorbookMoveRequest, object: mistake.id)
  }
}

extension Notification.Name {
  static let errorbookMoveRequest = Notification.Name("errorbookMoveRequest")
}

// MARK: - 只读块渲染

struct BlockListView: View {
  let blocks: [Block]
  let onImageTap: (URL) -> Void
  @EnvironmentObject private var store: BookStore

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
        switch b {
        case let .text(_, text):
          if !text.isEmpty {
            Text(text)
              .font(.body)
              .textSelection(.enabled)
          }
        case let .image(hash, ext):
          AssetImage(url: ImageStore.assetURL(store.dataDir, hash: hash, ext: ext), onTap: {
            onImageTap(ImageStore.assetURL(store.dataDir, hash: hash, ext: ext))
          })
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - 当前题标签编辑（对应桌面端 tag-pop）

struct TagEditSheet: View {
  @EnvironmentObject private var store: BookStore
  @Environment(\.dismiss) private var dismiss
  let mistakeId: String

  var body: some View {
    NavigationStack {
      List {
        if let m = store.mistake(id: mistakeId) {
          Section("已选标签") {
            if m.tags.isEmpty {
              Text("还没有标签").foregroundStyle(.secondary)
            } else {
              ForEach(m.tags, id: \.self) { t in
                Button {
                  store.updateMistake(
                    Mistake(id: m.id, folderIds: m.folderIds, question: m.question, analysis: m.analysis,
                            tags: m.tags.filter { $0 != t }, createdAt: m.createdAt, updatedAt: Date().nowMs))
                } label: {
                  HStack { TagChip(text: t); Spacer(); Image(systemName: "minus.circle").foregroundStyle(.red) }
                }
              }
            }
          }
          Section("全部标签（点击添加）") {
            if store.allTags.isEmpty {
              Text("还没有标签，在下面输入新建一个").foregroundStyle(.secondary)
            }
            ForEach(store.allTags, id: \.self) { t in
              Button {
                var tags = m.tags
                if let i = tags.firstIndex(of: t) {
                  tags.remove(at: i)
                } else {
                  tags.append(t)
                }
                store.updateMistake(
                  Mistake(id: m.id, folderIds: m.folderIds, question: m.question, analysis: m.analysis,
                          tags: tags, createdAt: m.createdAt, updatedAt: Date().nowMs))
              } label: {
                HStack {
                  Text(t)
                  Spacer()
                  if m.tags.contains(t) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
              }
            }
          }
          NewTagSection(mistakeId: mistakeId)
        }
      }
      .navigationTitle("标签")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } }
      }
    }
    .presentationDetents([.medium, .large])
  }
}

private struct NewTagSection: View {
  @EnvironmentObject private var store: BookStore
  let mistakeId: String
  @State private var draft = ""

  var body: some View {
    Section("新建标签") {
      HStack {
        TextField("新标签名称", text: $draft)
        Button("添加") {
          let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !t.isEmpty, let m = store.mistake(id: mistakeId), !m.tags.contains(t) else { return }
          store.updateMistake(
            Mistake(id: m.id, folderIds: m.folderIds, question: m.question, analysis: m.analysis,
                    tags: m.tags + [t], createdAt: m.createdAt, updatedAt: Date().nowMs))
          draft = ""
        }
      }
    }
  }
}
