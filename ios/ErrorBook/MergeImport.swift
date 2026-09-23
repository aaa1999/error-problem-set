import Foundation

// MARK: - 数据合并核心（合并导入与远程拉取共用，对应桌面端 src/lib/merge.ts）
// 幂等合并：文件夹按「名称+父级」、错题/笔记按 id 去重、预建标签并入、图片按内容哈希只取缺的。
// 可重复执行，已并入的自动跳过。

struct MergePlan {
  /// 目录合并导入时的源目录；远程拉取为 nil
  var sourceDir: URL?
  var source: Database
  var newMistakes: [Mistake]
  var newNotes: [Note]
  var newTags: [String]
  var newPendingImports: [PendingImport]
  var imageKeys: [String]
  var skipped: Int
  var skippedNotes: Int
  var imageCount: Int { imageKeys.count }
}

struct MergeOutcome {
  var newMistakes: Int
  var newNotes: Int
  var newTags: Int
  var foldersMerged: Int
  var assetsFetched: Int
  var assetsMissing: Int
}

struct MergeAborted: Error { var fetched: Int }

enum MergeError: LocalizedError {
  case plain(String)
  var errorDescription: String? {
    if case let .plain(msg) = self { return msg }
    return nil
  }
}

/// 纯差量计算：源库相对当前库会新增什么（不写任何数据）
func planMerge(source: Database, current: Database) -> MergePlan {
  let existing = Set(current.mistakes.map { $0.id })
  let newMistakes = source.mistakes.filter { !existing.contains($0.id) }
  let existingNotes = Set(current.notes.map { $0.id })
  let newNotes = source.notes.filter { !existingNotes.contains($0.id) }
  // 预建标签只数真正会新增的（当前已有 + 随新错题带进来的都不算，源内自身也去重）
  var present = Set(current.mistakes.flatMap { $0.tags })
  present.formUnion(current.tags)
  present.formUnion(newMistakes.flatMap { $0.tags })
  var seen = Set<String>()
  let newTags = source.tags.filter { seen.insert($0).inserted && !present.contains($0) }
  var imgs = Set<String>()
  for m in newMistakes {
    for b in m.question + m.analysis {
      if case let .image(hash, ext) = b { imgs.insert("\(hash).\(ext)") }
    }
  }
  for n in newNotes {
    for ref in collectAssetRefs(n.content) { imgs.insert(String(ref.dropFirst("assets/".count))) }
  }
  let pendingIds = Set(current.pendingImports.map { $0.id })
  let newPendingImports = source.pendingImports.filter { !pendingIds.contains($0.id) }
  return MergePlan(
    sourceDir: nil,
    source: source,
    newMistakes: newMistakes,
    newNotes: newNotes,
    newTags: newTags,
    newPendingImports: newPendingImports,
    imageKeys: imgs.sorted(),
    skipped: source.mistakes.count - newMistakes.count,
    skippedNotes: source.notes.count - newNotes.count
  )
}

/// 定位数据目录：所选文件夹本身含 data.json 直接用；否则向下找两层。
/// 找到多个时报错让用户选具体那个。
func findDataDir(root: URL) throws -> URL {
  let fm = FileManager.default
  if fm.fileExists(atPath: root.appendingPathComponent("data.json").path) { return root }
  var candidates: [URL] = []
  func scan(_ dir: URL, _ depth: Int) throws {
    if depth > 2 || candidates.count > 1 { return }
    guard let names = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
    for child in names {
      guard (try? child.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true, !child.lastPathComponent.hasPrefix(".") else { continue }
      if fm.fileExists(atPath: child.appendingPathComponent("data.json").path) {
        candidates.append(child)
      } else {
        try scan(child, depth + 1)
      }
    }
  }
  try scan(root, 1)
  if candidates.count == 1 { return candidates[0] }
  if candidates.count > 1 {
    throw MergeError.plain("所选文件夹下有多个数据目录，请直接选择其中之一：\(candidates.map { $0.lastPathComponent }.joined(separator: "、"))")
  }
  throw MergeError.plain("所选文件夹里没有找到数据目录（需包含 data.json 与 assets 文件夹）。请选择另一台机器拷来的 data / 错题本 文件夹本身")
}

func buildMergePlan(sourceDir: URL, current: Database) throws -> MergePlan {
  var plan = planMerge(source: try BookStore.loadDb(from: sourceDir), current: current)
  plan.sourceDir = sourceDir
  if plan.source.mistakes.isEmpty && plan.source.notes.isEmpty {
    throw MergeError.plain("该数据目录里没有错题或笔记数据")
  }
  return plan
}

/// 执行合并：ensureAsset 负责把图片写进本地 assets（返回 false = 源端也缺，保留引用跳过）。
/// 中止在图片间隙生效（shouldAbort），抛 MergeAborted，已取回的图片保留（哈希命名，下次跳过）。
@MainActor
func runMergeCore(
  plan: MergePlan,
  store: BookStore,
  ensureAsset: (String) async throws -> Bool,
  onProgress: @escaping (_ done: Int, _ total: Int, _ current: String?) -> Void,
  shouldAbort: (() -> Bool)? = nil
) async throws -> MergeOutcome {
  let total = plan.newMistakes.count + plan.newNotes.count + plan.imageCount
  var done = 0
  onProgress(0, total, nil)

  // 1. 文件夹按「名称+父级」合并（父层先处理，同名复用不重建）
  let byId = Dictionary(uniqueKeysWithValues: plan.source.folders.map { ($0.id, $0) })
  func depthOf(_ f: Folder) -> Int {
    var d = 0
    var p = f.parentId
    var guardCount = 0
    while let pid = p, guardCount < 64 {
      guard let par = byId[pid] else { break }
      d += 1
      p = par.parentId
      guardCount += 1
    }
    return d
  }
  let sorted = plan.source.folders.sorted { depthOf($0) < depthOf($1) }
  var fmap: [String: String] = [:]
  for f in sorted {
    let dst = store.findOrCreateFolder(name: f.name, parentId: f.parentId.flatMap { fmap[$0] })
    fmap[f.id] = dst.id
  }

  // 2. 取回缺失的图片（本地已有的由 ensureAsset 跳过；取不到的保留引用跳过不阻断）
  var fetched = 0
  var missing = 0
  for key in plan.imageKeys {
    if shouldAbort?() == true { throw MergeAborted(fetched: fetched) }
    onProgress(done, total, key)
    if try await ensureAsset(key) {
      fetched += 1
    } else {
      missing += 1
    }
    done += 1
  }

  // 3. 错题与笔记入册（保留原 id/时间戳，错题的每个所属文件夹都映射到合并后的目标）+ 预建标签并入
  let mapped = plan.newMistakes.map { m in
    Mistake(id: m.id, folderIds: m.folderIds.compactMap { fmap[$0] }, question: m.question, analysis: m.analysis, tags: m.tags, createdAt: m.createdAt, updatedAt: m.updatedAt)
  }
  store.addMistakes(mapped)
  done += plan.newMistakes.count
  onProgress(done, total, nil)
  if !plan.newNotes.isEmpty { store.addNotes(plan.newNotes) }
  if !plan.source.tags.isEmpty { store.addTags(plan.source.tags) }
  if !plan.newPendingImports.isEmpty { store.addPendingImports(plan.newPendingImports) }
  onProgress(total, total, nil)

  return MergeOutcome(
    newMistakes: plan.newMistakes.count,
    newNotes: plan.newNotes.count,
    newTags: plan.newTags.count,
    foldersMerged: plan.source.folders.count,
    assetsFetched: fetched,
    assetsMissing: missing
  )
}

/// 合并结果的统一文案（合并导入 / 远程拉取共用口径）
func mergeOutcomeText(_ plan: MergePlan, _ o: MergeOutcome) -> String {
  var parts = [
    "新导入 \(o.newMistakes) 道错题、\(o.newNotes) 篇笔记",
    "跳过 \(plan.skipped) 道错题、\(plan.skippedNotes) 篇笔记（已存在）",
    "\(o.foldersMerged) 个文件夹已按名称合并"
  ]
  if o.newTags > 0 { parts.append("预建标签新增 \(o.newTags) 个") }
  if !plan.newPendingImports.isEmpty { parts.append("待导入清单新增 \(plan.newPendingImports.count) 份") }
  if o.assetsMissing > 0 { parts.append("\(o.assetsMissing) 张图片源端缺失已跳过") }
  return "合并完成：\(parts.joined(separator: "，"))。"
}

/// 目录合并导入的执行入口：图片从源目录拷贝（本地已有的跳过，源里也缺的保留引用）
@MainActor
func runMerge(plan: MergePlan, store: BookStore, onProgress: @escaping (Int, Int) -> Void) async throws -> String {
  let fm = FileManager.default
  guard let sourceDir = plan.sourceDir else {
    throw MergeError.plain("合并计划缺少源目录")
  }
  let outcome = try await runMergeCore(
    plan: plan,
    store: store,
    ensureAsset: { key in
      let dst = store.dataDir.appendingPathComponent("assets/\(key)")
      if fm.fileExists(atPath: dst.path) { return true }
      try? fm.copyItem(at: sourceDir.appendingPathComponent("assets/\(key)"), to: dst)
      return fm.fileExists(atPath: dst.path)
    },
    onProgress: { done, total, _ in onProgress(done, total) }
  )
  return mergeOutcomeText(plan, outcome)
}
