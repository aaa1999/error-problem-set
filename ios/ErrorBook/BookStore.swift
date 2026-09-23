import Foundation
import Combine

// MARK: - 数据库加载/落盘（对应桌面端 src/lib/db.ts + src/store.tsx）
// 数据目录固定为 App 的 Documents/错题本（通过「文件」App / Finder 可见，可与桌面版整目录互通）。

let maxSnapshots = 20
/// 快照至少间隔 1 分钟做一次，避免刷屏
private var lastSnapshotAt: Double = 0

@MainActor
final class BookStore: ObservableObject {
  @Published private(set) var db = Database()
  @Published private(set) var loadError: String?

  let dataDir: URL
  var assetsDir: URL { dataDir.appendingPathComponent("assets") }

  var allTags: [String] { tagCounts.map { $0.0 } }
  var tagCounts: [(String, Int)] {
    var m: [String: Int] = [:]
    for x in db.mistakes { for t in x.tags { m[t, default: 0] += 1 } }
    for t in db.tags where m[t] == nil { m[t] = 0 } // 预建标签计数 0，列表里置灰可点
    return m.sorted { String.naturalLess($0.key, $1.key) }.map { ($0.key, $0.value) }
  }

  init() {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    dataDir = docs.appendingPathComponent("错题本")
    do {
      try Self.ensureDirs(dataDir)
      db = try Self.loadDb(from: dataDir)
    } catch {
      loadError = "数据目录初始化失败：\(error.localizedDescription)"
    }
  }

  // MARK: 文件层

  nonisolated static func ensureDirs(_ dir: URL) throws {
    let fm = FileManager.default
    for sub in ["assets", "snapshots"] {
      try fm.createDirectory(at: dir.appendingPathComponent(sub), withIntermediateDirectories: true)
    }
  }

  nonisolated static func loadDb(from dir: URL) throws -> Database {
    let path = dir.appendingPathComponent("data.json")
    guard FileManager.default.fileExists(atPath: path.path) else { return Database() }
    do {
      let data = try Data(contentsOf: path)
      return try JSONDecoder().decode(Database.self, from: data)
    } catch {
      NSLog("data.json 解析失败，按空数据处理：\(error)")
      return Database()
    }
  }

  /// 原子写入：先写临时文件再替换；替换前把旧版拷进 snapshots/（限流 + 保留最近 20 份）
  func persist() {
    do {
      try Self.saveDb(db, to: dataDir)
    } catch {
      NSLog("保存失败：\(error)")
    }
  }

  nonisolated static func saveDb(_ db: Database, to dir: URL) throws {
    let fm = FileManager.default
    let dataPath = dir.appendingPathComponent("data.json")
    let now = Date().nowMs
    if fm.fileExists(atPath: dataPath.path), now - lastSnapshotAt > 60_000 {
      lastSnapshotAt = now
      let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
      let snap = dir.appendingPathComponent("snapshots/data-\(stamp).json")
      try? fm.copyItem(at: dataPath, to: snap)
      pruneSnapshots(dir.appendingPathComponent("snapshots"))
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    let tmp = dir.appendingPathComponent("data.json.tmp")
    try encoder.encode(db).write(to: tmp, options: .atomic)
    if fm.fileExists(atPath: dataPath.path) {
      _ = try fm.replaceItemAt(dataPath, withItemAt: tmp)
    } else {
      try fm.moveItem(at: tmp, to: dataPath)
    }
  }

  nonisolated private static func pruneSnapshots(_ snapDir: URL) {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: snapDir.path) else { return }
    let sorted = names.filter { $0.hasPrefix("data-") }.sorted()
    guard sorted.count > maxSnapshots else { return }
    for name in sorted.prefix(sorted.count - maxSnapshots) {
      try? fm.removeItem(at: snapDir.appendingPathComponent(name))
    }
  }

  // MARK: 错题 CRUD

  private func mutate(_ f: (inout Database) -> Void) {
    var next = db
    f(&next)
    db = next
    persist()
  }

  func addMistake(_ m: Mistake) {
    mutate { $0.mistakes.append(m) }
  }

  func updateMistake(_ m: Mistake) {
    mutate { d in d.mistakes = d.mistakes.map { $0.id == m.id ? m : $0 } }
  }

  func mistake(id: String) -> Mistake? {
    db.mistakes.first { $0.id == id }
  }

  func deleteMistake(_ id: String) {
    mutate { d in d.mistakes = d.mistakes.filter { $0.id != id } }
  }

  func setMistakeFolders(_ mistakeId: String, _ folderIds: [String]) {
    mutate { d in
      d.mistakes = d.mistakes.map { m in
        m.id == mistakeId ? Mistake(id: m.id, folderIds: folderIds, question: m.question, analysis: m.analysis, tags: m.tags, createdAt: m.createdAt, updatedAt: Date().nowMs) : m
      }
    }
  }

  // MARK: 文件夹 CRUD

  @discardableResult
  func createFolder(name: String, parentId: String?) -> Folder {
    let f = Folder(name: name.trimmingCharacters(in: .whitespacesAndNewlines), parentId: parentId)
    mutate { $0.folders.append(f) }
    return f
  }

  /// 按名称+父级查找，没有就创建（批量导入按源结构落位用）
  @discardableResult
  func findOrCreateFolder(name: String, parentId: String?) -> Folder {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if let found = db.folders.first(where: { $0.name == trimmed && $0.parentId ?? nil == parentId ?? nil }) {
      return found
    }
    let f = Folder(name: trimmed, parentId: parentId)
    mutate { $0.folders.append(f) }
    return f
  }

  func renameFolder(_ id: String, _ name: String) {
    mutate { d in
      d.folders = d.folders.map { f in
        f.id == id ? Folder(id: f.id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), parentId: f.parentId, createdAt: f.createdAt) : f
      }
    }
  }

  /// 删除文件夹：从错题的所属列表里移除该文件夹（清空的落到未分类），子文件夹上移一级
  func deleteFolder(_ id: String) {
    mutate { d in
      let parentId = d.folders.first { $0.id == id }?.parentId ?? nil
      d.folders = d.folders.filter { $0.id != id }.map { f in
        f.parentId == id ? Folder(id: f.id, name: f.name, parentId: parentId, createdAt: f.createdAt) : f
      }
      d.mistakes = d.mistakes.map { m in
        m.folderIds.contains(id)
          ? Mistake(id: m.id, folderIds: m.folderIds.filter { $0 != id }, question: m.question, analysis: m.analysis, tags: m.tags, createdAt: m.createdAt, updatedAt: m.updatedAt)
          : m
      }
    }
  }

  // MARK: 笔记 CRUD

  func addNote(_ n: Note) {
    mutate { $0.notes.append(n) }
  }

  func updateNote(_ n: Note) {
    mutate { d in d.notes = d.notes.map { $0.id == n.id ? n : $0 } }
  }

  func deleteNote(_ id: String) {
    mutate { d in d.notes = d.notes.filter { $0.id != id } }
  }

  /// 批量追加错题（合并导入用），跳过已存在的 id，返回实际新增数
  @discardableResult
  func addMistakes(_ ms: [Mistake]) -> Int {
    let ids = Set(db.mistakes.map { $0.id })
    let add = ms.filter { !ids.contains($0.id) }
    if !add.isEmpty { mutate { $0.mistakes.append(contentsOf: add) } }
    return add.count
  }

  @discardableResult
  func addNotes(_ ns: [Note]) -> Int {
    let ids = Set(db.notes.map { $0.id })
    let add = ns.filter { !ids.contains($0.id) }
    if !add.isEmpty { mutate { $0.notes.append(contentsOf: add) } }
    return add.count
  }

  // MARK: 标签

  /// 新建预建标签；空名或已存在（错题已带/已预建）时静默跳过
  func createTag(_ name: String) {
    let t = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return }
    let used = Set(db.mistakes.flatMap { $0.tags })
    guard !used.contains(t), !db.tags.contains(t) else { return }
    mutate { $0.tags.append(t) }
  }

  // MARK: 待导入清单（做题 tab）

  func addPendingImport(_ p: PendingImport) {
    mutate { d in
      guard !d.pendingImports.contains(where: { $0.id == p.id }) else { return }
      d.pendingImports.append(p)
    }
  }

  /// 批量并入（合并导入/拉取用），按 id 去重，返回实际新增数
  @discardableResult
  func addPendingImports(_ ps: [PendingImport]) -> Int {
    let ids = Set(db.pendingImports.map { $0.id })
    let add = ps.filter { !ids.contains($0.id) }
    if !add.isEmpty { mutate { $0.pendingImports.append(contentsOf: add) } }
    return add.count
  }

  func removePendingImport(_ id: String) {
    mutate { d in
      d.pendingImports.removeAll { $0.id == id }
    }
  }

  /// 批量并入预建标签（合并导入用），跳过已有（含错题已带的），返回实际新增数
  @discardableResult
  func addTags(_ names: [String]) -> Int {
    let used = Set(db.mistakes.flatMap { $0.tags }).union(db.tags)
    var seen = Set<String>()
    let add = names
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty && !used.contains($0) && seen.insert($0).inserted }
    if !add.isEmpty { mutate { $0.tags.append(contentsOf: add) } }
    return add.count
  }
}
