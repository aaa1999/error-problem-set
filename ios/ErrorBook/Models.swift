import Foundation

// MARK: - Block（题目/解析的内容块：文字或图片）

enum Block: Equatable {
  case text(id: String, text: String)
  /// 图片内容哈希，对应数据目录 assets/<hash>.<ext>（与桌面版一致，图片块没有 id 字段）
  case image(hash: String, ext: String)

  var textContent: String? {
    if case let .text(_, t) = self { return t }
    return nil
  }
}

extension Block: Codable {
  private enum CodingKeys: String, CodingKey {
    case id, type, text, hash, ext
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = (try? c.decode(String.self, forKey: .type)) ?? ""
    if type == "image" {
      let hash = (try? c.decode(String.self, forKey: .hash)) ?? ""
      let ext = (try? c.decode(String.self, forKey: .ext)) ?? "png"
      self = .image(hash: hash, ext: ext)
    } else {
      let id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString.lowercased()
      let text = (try? c.decode(String.self, forKey: .text)) ?? ""
      self = .text(id: id, text: text)
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .text(id, text):
      try c.encode(id, forKey: .id)
      try c.encode("text", forKey: .type)
      try c.encode(text, forKey: .text)
    case let .image(hash, ext):
      try c.encode("image", forKey: .type)
      try c.encode(hash, forKey: .hash)
      try c.encode(ext, forKey: .ext)
    }
  }
}

// MARK: - 文件夹

struct Folder: Equatable, Identifiable {
  var id = UUID().uuidString.lowercased()
  var name = ""
  /// nil 表示根层级
  var parentId: String? = nil
  var createdAt = Date().nowMs
}

extension Folder: Codable {
  private enum CodingKeys: String, CodingKey {
    case id, name, parentId, createdAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString.lowercased()
    name = (try? c.decode(String.self, forKey: .name)) ?? ""
    parentId = try? c.decodeIfPresent(String.self, forKey: .parentId)
    createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? Date().nowMs
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    if let p = parentId { try c.encode(p, forKey: .parentId) } else { try c.encodeNil(forKey: .parentId) }
    try c.encode(createdAt, forKey: .createdAt)
  }
}

// MARK: - 错题

struct Mistake: Equatable, Identifiable {
  var id = UUID().uuidString.lowercased()
  /// 所属文件夹（可多个；空 = 未分类）。旧数据的单个 folderId 解码时自动迁移
  var folderIds: [String] = []
  /// 选择题选项；空 = 非选择题（不参与作答与错误率）
  var options: [String] = []
  /// 正确选项下标；nil = 未标记
  var answer: Int? = nil
  /// 作答统计：错误率 = wrong / attempts（attempts 为 0 视为 0%）
  var attempts = 0
  var wrong = 0
  var question: [Block] = []
  var analysis: [Block] = []
  var tags: [String] = []
  var createdAt = Date().nowMs
  var updatedAt = Date().nowMs
}

extension Mistake: Codable {
  private enum CodingKeys: String, CodingKey {
    case id, folderId, folderIds, options, answer, attempts, wrong, question, analysis, tags, createdAt, updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString.lowercased()
    // 新格式 folderIds[]；旧格式单个 folderId 自动迁移成一项，都没有 = 未分类
    if let ids = try? c.decode([String].self, forKey: .folderIds) {
      folderIds = ids
    } else if let fid = try? c.decodeIfPresent(String.self, forKey: .folderId) {
      folderIds = [fid]
    } else {
      folderIds = []
    }
    // 选择题选项 + 作答统计（旧数据没有这些字段，按空/0 处理）
    options = (try? c.decode([String].self, forKey: .options)) ?? []
    answer = try? c.decodeIfPresent(Int.self, forKey: .answer)
    attempts = (try? c.decode(Int.self, forKey: .attempts)) ?? 0
    wrong = (try? c.decode(Int.self, forKey: .wrong)) ?? 0
    question = (try? c.decode([Block].self, forKey: .question)) ?? []
    analysis = (try? c.decode([Block].self, forKey: .analysis)) ?? []
    tags = (try? c.decode([String].self, forKey: .tags)) ?? []
    let now = Date().nowMs
    createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? now
    updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? now
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(folderIds, forKey: .folderIds)
    try c.encode(options, forKey: .options)
    try c.encodeIfPresent(answer, forKey: .answer)
    try c.encode(attempts, forKey: .attempts)
    try c.encode(wrong, forKey: .wrong)
    try c.encode(question, forKey: .question)
    try c.encode(analysis, forKey: .analysis)
    try c.encode(tags, forKey: .tags)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encode(updatedAt, forKey: .updatedAt)
  }
}

// MARK: - 笔记

enum NoteFormat: String, Codable {
  case markdown
  case word
}

struct Note: Equatable, Identifiable {
  var id = UUID().uuidString.lowercased()
  var title = ""
  var format: NoteFormat = .markdown
  /// markdown 存源文本；word 存富文本 HTML；图片引用 assets/<hash>.<ext>
  var content = ""
  var createdAt = Date().nowMs
  var updatedAt = Date().nowMs
}

extension Note: Codable {
  private enum CodingKeys: String, CodingKey {
    case id, title, format, content, createdAt, updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString.lowercased()
    title = (try? c.decode(String.self, forKey: .title)) ?? ""
    format = (try? c.decode(NoteFormat.self, forKey: .format)) ?? .markdown
    content = (try? c.decode(String.self, forKey: .content)) ?? ""
    let now = Date().nowMs
    createdAt = (try? c.decode(Double.self, forKey: .createdAt)) ?? now
    updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? now
  }
}

// MARK: - 整库

struct Database: Codable, Equatable {
  var version = 3
  var mistakes: [Mistake] = []
  var folders: [Folder] = []
  var notes: [Note] = []
  /// 预建的独立标签：不挂在任何错题上也存在（与桌面端一致），旧数据没有该字段按空处理
  var tags: [String] = []
  /// 待导入清单（做题 tab 产生，跨设备同步，按 id 去重）
  var pendingImports: [PendingImport] = []

  init() {}

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    version = (try? c.decode(Int.self, forKey: .version)) ?? 3
    mistakes = (try? c.decode([Mistake].self, forKey: .mistakes)) ?? []
    folders = (try? c.decode([Folder].self, forKey: .folders)) ?? []
    notes = (try? c.decode([Note].self, forKey: .notes)) ?? []
    tags = (try? c.decode([String].self, forKey: .tags)) ?? []
    pendingImports = (try? c.decode([PendingImport].self, forKey: .pendingImports)) ?? []
  }
}

// MARK: - 待导入清单（做题 tab：手机做题 → 同步 → 电脑导入）

struct PendingImportEntry: Codable, Equatable {
  /// 题号（1 起）
  var no: Int
  /// 我的答案（A–D，未作答 nil）
  var mine: String? = nil
  /// 正确答案（未对 nil）
  var key: String? = nil
  /// 做题时标记 ⭐
  var flagged: Bool = false
}

struct PendingImport: Codable, Equatable, Identifiable {
  var id = UUID().uuidString.lowercased()
  var folderName = ""
  var createdAt = Date().nowMs
  var total = 0
  var entries: [PendingImportEntry] = []
}

// MARK: - 小工具

extension Date {
  /// 毫秒时间戳（与桌面端 Date.now() 同口径）
  var nowMs: Double { timeIntervalSince1970 * 1000 }
}

/// mulberry32 伪随机数（0..<1）：种子固定则序列固定
private func mulberry32(_ seed: UInt32) -> () -> Double {
  var s = seed == 0 ? 1 : seed
  return {
    s = s &+ 0x6D2B79F5
    var t = s
    t = (t ^ (t >> 15)) &* (t | 1)
    t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
    return Double(t ^ (t >> 14)) / 4294967296.0
  }
}

/// 以 seed 为种子的稳定洗牌：同 seed 同输入 → 同顺序（随机翻页用，重算不会跳序）
func seededShuffle<T>(_ arr: [T], seed: UInt32) -> [T] {
  var a = arr
  let rnd = mulberry32(seed)
  for i in stride(from: a.count - 1, through: 1, by: -1) {
    a.swapAt(i, Int(rnd() * Double(i + 1)))
  }
  return a
}

/// 选择题错误率百分比（未作答按 0% 计）
func optionRate(_ m: Mistake) -> Int {
  guard m.attempts > 0 else { return 0 }
  return Int((Double(m.wrong) / Double(m.attempts) * 100).rounded())
}

extension String {
  /// 文件名自然排序：题2 排在 题10 前面（近似桌面端 Intl.Collator numeric）
  static func naturalLess(_ a: String, _ b: String) -> Bool {
    var ai = a.startIndex, bi = b.startIndex
    while ai < a.endIndex, bi < b.endIndex {
      let ac = a[ai], bc = b[bi]
      if ac.isNumber, bc.isNumber {
        let ar = a[ai...].prefix { $0.isNumber }
        let br = b[bi...].prefix { $0.isNumber }
        ai = a.index(ai, offsetBy: ar.count)
        bi = b.index(bi, offsetBy: br.count)
        let an = Int64(ar) ?? 0, bn = Int64(br) ?? 0
        if an != bn { return an < bn }
      } else {
        if ac != bc { return ac.lowercased() < bc.lowercased() }
        a.formIndex(after: &ai)
        b.formIndex(after: &bi)
      }
    }
    if ai < a.endIndex || bi < b.endIndex { return a.count < b.count }
    return false
  }
}

func formatTime(_ ms: Double) -> String {
  let d = Date(timeIntervalSince1970: ms / 1000)
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd HH:mm"
  return f.string(from: d)
}

/// 天级时间（本地时区），用于按导入日期分组
func formatDay(_ ms: Double) -> String {
  let d = Date(timeIntervalSince1970: ms / 1000)
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  return f.string(from: d)
}

/// 没有任何有效内容（无文字且无图片）返回 true
func isBlocksEmpty(_ blocks: [Block]) -> Bool {
  !blocks.contains { b in
    if case let .text(_, t) = b { return !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return true
  }
}

func blocksToPlainText(_ blocks: [Block]) -> String {
  blocks.map { b -> String in
    if case let .text(_, t) = b { return t }
    return "[图]"
  }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}
