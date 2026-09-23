import Foundation
#if canImport(CoreTelephony) && !targetEnvironment(macCatalyst)
import CoreTelephony
#endif

// MARK: - 远程同步（推送 + 拉取）（对应桌面端 src/lib/sync.ts）
// 协议见 docs/sync-protocol.md（v2）：
// 推送：GET /sync/manifest 拿清单 → 只 PUT 缺的图片 → PUT /sync/data 推整库。
// 拉取：GET /sync/data 拿远端整库 → 与本地幂等合并（MergeImport.swift 的 runMergeCore）。

/// 国行设备「无线数据」权限探测：初始化 CTCellularData 监听会促使系统弹出联网授权，
/// 并能读出本 App 是否被系统拒绝联网（被拒时 Safari 正常但所有请求报「未连接互联网」）
enum NetworkPermissionProbe {
#if canImport(CoreTelephony) && !targetEnvironment(macCatalyst)
  private static let cellular = CTCellularData()
  private static var state: CTCellularDataRestrictedState = .notRestricted
  private static var started = false

  static func start() {
    guard !started else { return }
    started = true
    cellular.cellularDataRestrictionDidUpdateNotifier = { state in
      self.state = state
    }
  }

  /// 系统是否明确拒绝了本 App 联网
  static var isRestricted: Bool { state == .restricted }
#else
  static func start() {}
  static var isRestricted: Bool { false }
#endif
}

struct SyncTarget: Codable, Equatable {
  /// 形如 http://192.168.1.100:8080（仅 scheme://host:port）
  var server: String
  var token: String?
}

private let targetKey = "errorbook.sync.server"

enum SyncStore {
  static func load() -> SyncTarget? {
    guard let raw = UserDefaults.standard.string(forKey: targetKey),
          let data = raw.data(using: .utf8),
          let t = try? JSONDecoder().decode(SyncTarget.self, from: data),
          !t.server.isEmpty
    else { return nil }
    return t
  }

  static func save(_ t: SyncTarget) {
    if let data = try? JSONEncoder().encode(t), let raw = String(data: data, encoding: .utf8) {
      UserDefaults.standard.set(raw, forKey: targetKey)
    }
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: targetKey)
  }
}

/// "192.168.1.5:8080" / "http://host:port/…" → 规范 origin（自动补 http://）；无效返回 nil
func normalizeServerAddr(_ input: String) -> String? {
  var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !s.isEmpty else { return nil }
  if !s.lowercased().hasPrefix("http://"), !s.lowercased().hasPrefix("https://") {
    s = "http://\(s)"
  }
  guard let u = URL(string: s), let host = u.host, !host.isEmpty else { return nil }
  var origin = "\(u.scheme ?? "http")://\(host)"
  if let port = u.port { origin += ":\(port)" }
  return origin
}

/// 全库引用到的图片文件名集合（错题 blocks + 笔记正文）
func collectLibraryAssets(_ db: Database) -> Set<String> {
  var keys = Set<String>()
  for m in db.mistakes {
    for b in m.question + m.analysis {
      if case let .image(hash, ext) = b { keys.insert("\(hash).\(ext)") }
    }
  }
  for n in db.notes {
    for ref in collectAssetRefs(n.content) {
      keys.insert(String(ref.dropFirst("assets/".count)))
    }
  }
  return keys
}

struct SyncProgress: Equatable {
  enum Phase { case connect, assets, data }
  var phase: Phase
  var done: Int
  var total: Int
  var current: String?
}

struct SyncResult {
  var uploadedAssets: Int
  var missingLocal: Int
  var totalAssets: Int
  var mistakes: Int
  var notes: Int
  var folders: Int
}

struct SyncAborted: Error { var uploaded: Int }

final class SyncEngine {
  private let session: URLSession
  private var aborted = false

  init() {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 30
    cfg.timeoutIntervalForResource = 600
    session = URLSession(configuration: cfg)
  }

  func abort() { aborted = true }

  private func request(_ url: URL, method: String, headers: [String: String], body: Data? = nil, connectTimeout: TimeInterval? = nil) async throws -> (HTTPURLResponse, Data) {
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.httpBody = body
    for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
    if let t = connectTimeout { req.timeoutInterval = t }
    do {
      let (data, resp) = try await session.data(for: req)
      guard let http = resp as? HTTPURLResponse else {
        throw SyncError.plain("服务器响应异常")
      }
      return (http, data)
    } catch let e as SyncError {
      throw e
    } catch {
      var detail = error.localizedDescription
      if NetworkPermissionProbe.isRestricted {
        detail += "。系统未允许错题本联网（设置 → 无线局域网 → 使用无线局域网与蜂窝网络的 App → 错题本）"
      }
      throw SyncError.plain("无法连接服务器：请检查地址、端口与网络。（\(detail)）")
    }
  }

  private func authHeaders(_ target: SyncTarget) -> [String: String] {
    if let token = target.token, !token.isEmpty { return ["X-Sync-Token": token] }
    return [:]
  }

  /// 推送整库。幂等可重入：中断后重新执行，已传过的图片自动跳过。
  func push(
    _ target: SyncTarget,
    db: Database,
    dataDir: URL,
    onProgress: @escaping (SyncProgress) -> Void
  ) async throws -> SyncResult {
    let base = target.server

    // 1. 服务端图片清单
    NetworkPermissionProbe.start()
    onProgress(SyncProgress(phase: .connect, done: 0, total: 0, current: nil))
    let (mres, mdata) = try await request(
      URL(string: "\(base)/sync/manifest")!, method: "GET",
      headers: authHeaders(target), connectTimeout: 5
    )
    if mres.statusCode == 401 || mres.statusCode == 403 {
      throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(mres.statusCode)）")
    }
    if mres.statusCode == 404 {
      throw SyncError.plain("该地址不是错题同步服务端（/sync/manifest 返回 404），请确认地址与端口")
    }
    guard (200..<300).contains(mres.statusCode) else {
      throw SyncError.plain("获取清单失败：HTTP \(mres.statusCode)")
    }
    struct Manifest: Decodable { var assets: [String]? }
    guard let manifest = try? JSONDecoder().decode(Manifest.self, from: mdata), let assets = manifest.assets else {
      throw SyncError.plain("该地址不是错题同步服务端：/sync/manifest 响应的不是本协议的 { assets: [...] }")
    }
    let serverAssets = Set(assets)

    // 2. 逐张上传服务端缺的图片
    let local = collectLibraryAssets(db)
    let missing = local.filter { !serverAssets.contains($0) }.sorted()
    var done = 0
    var missingLocal = 0
    for key in missing {
      if aborted { throw SyncAborted(uploaded: done) }
      onProgress(SyncProgress(phase: .assets, done: done, total: missing.count, current: key))
      let path = ImageStore.assetURL(dataDir, key: key)
      guard FileManager.default.fileExists(atPath: path.path) else {
        // 本地文件缺失：保留引用跳过
        missingLocal += 1
        done += 1
        continue
      }
      let bytes = try Data(contentsOf: path)
      let (res, _) = try await request(
        URL(string: "\(base)/sync/asset/\(key)")!, method: "PUT",
        headers: ["Content-Type": "application/octet-stream"].merging(authHeaders(target)) { a, _ in a },
        body: bytes
      )
      if res.statusCode == 401 || res.statusCode == 403 {
        throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(res.statusCode)）")
      }
      guard (200..<300).contains(res.statusCode) else {
        throw SyncError.plain("上传图片 \(key) 失败：HTTP \(res.statusCode)")
      }
      done += 1
    }

    // 3. 推送整份库（与磁盘 data.json 相同的序列化格式，覆盖式，最后推送为准）
    if aborted { throw SyncAborted(uploaded: done) }
    onProgress(SyncProgress(phase: .data, done: done, total: missing.count, current: nil))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    let payload = try encoder.encode(db)
    let (dres, _) = try await request(
      URL(string: "\(base)/sync/data")!, method: "PUT",
      headers: ["Content-Type": "application/json"].merging(authHeaders(target)) { a, _ in a },
      body: payload
    )
    if dres.statusCode == 401 || dres.statusCode == 403 {
      throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(dres.statusCode)）")
    }
    guard (200..<300).contains(dres.statusCode) else {
      throw SyncError.plain("推送题库数据失败：HTTP \(dres.statusCode)")
    }

    return SyncResult(
      uploadedAssets: done - missingLocal,
      missingLocal: missingLocal,
      totalAssets: local.count,
      mistakes: db.mistakes.count,
      notes: db.notes.count,
      folders: db.folders.count
    )
  }

  // ---------- 拉取（v2 协议） ----------

  /// 拉取阶段一：取远端整库并算差量（只读，不写任何数据），供确认预览
  func pullPlan(_ target: SyncTarget, current: Database, onProgress: @escaping (SyncProgress) -> Void) async throws -> MergePlan {
    NetworkPermissionProbe.start()
    onProgress(SyncProgress(phase: .connect, done: 0, total: 0, current: nil))
    let (res, data) = try await request(
      URL(string: "\(target.server)/sync/data")!, method: "GET",
      headers: authHeaders(target), connectTimeout: 5
    )
    if res.statusCode == 401 || res.statusCode == 403 {
      throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(res.statusCode)）")
    }
    if res.statusCode == 404 {
      throw SyncError.plain("服务器上还没有数据：请先从任意一端推送，或该服务端版本过旧（未实现拉取端点）")
    }
    guard (200..<300).contains(res.statusCode) else {
      throw SyncError.plain("拉取题库数据失败：HTTP \(res.statusCode)")
    }
    guard let remote = try? JSONDecoder().decode(Database.self, from: data) else {
      throw SyncError.plain("服务端返回的不是合法的题库数据")
    }
    if remote.mistakes.isEmpty && remote.notes.isEmpty {
      throw SyncError.plain("服务器上的库是空的（无错题无笔记），没有可拉取的内容")
    }
    return planMerge(source: remote, current: current)
  }

  struct PullOutcome {
    var outcome: MergeOutcome
    /// 本次实际从服务端下载的图片数
    var downloadedAssets: Int
  }

  /// 拉取阶段二：下载缺失图片 + 幂等并入本地库
  func pull(
    _ target: SyncTarget,
    plan: MergePlan,
    store: BookStore,
    onProgress: @escaping (SyncProgress) -> Void
  ) async throws -> PullOutcome {
    var downloaded = 0
    let outcome = try await runMergeCore(
      plan: plan,
      store: store,
      ensureAsset: { [weak self] key in
        guard let self else { return false }
        let dst = ImageStore.assetURL(store.dataDir, key: key)
        if FileManager.default.fileExists(atPath: dst.path) { return true } // 本地已有（内容哈希一致）
        let (res, data) = try await self.request(
          URL(string: "\(target.server)/sync/asset/\(key)")!, method: "GET",
          headers: self.authHeaders(target), connectTimeout: 5
        )
        if res.statusCode == 404 { return false } // 服务端也缺这张图：保留引用跳过（与推送/合并口径一致）
        if res.statusCode == 401 || res.statusCode == 403 {
          throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(res.statusCode)）")
        }
        guard (200..<300).contains(res.statusCode) else {
          throw SyncError.plain("下载图片 \(key) 失败：HTTP \(res.statusCode)")
        }
        try data.write(to: dst)
        downloaded += 1
        return true
      },
      onProgress: { done, total, current in
        onProgress(SyncProgress(phase: .assets, done: done, total: total, current: current))
      },
      shouldAbort: { [weak self] in self?.aborted ?? false }
    )
    onProgress(SyncProgress(phase: .data, done: 1, total: 1, current: nil))
    return PullOutcome(outcome: outcome, downloadedAssets: downloaded)
  }
}

enum SyncError: LocalizedError {
  case plain(String)
  var errorDescription: String? {
    if case let .plain(msg) = self { return msg }
    return nil
  }
}
