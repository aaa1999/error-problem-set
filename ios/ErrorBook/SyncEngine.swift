import Foundation
import Security
import UIKit
#if canImport(CoreTelephony) && !targetEnvironment(macCatalyst)
import CoreTelephony
#endif

// MARK: - 远程同步（推送 + 拉取）（对应桌面端 src/lib/sync.ts）
// 协议见 docs/sync-protocol.md（v3，多设备）：
// 推送：GET /sync/manifest 拿清单 → 只 PUT 缺的图片 →
//       PUT /sync/data（带 X-Device-Id/X-Device-Name 头）推整库——服务端只覆盖本设备的槽位。
// 拉取：GET /sync/devices 拿设备清单 → 逐台 GET /sync/data?device=<id> 取该设备原始整库，
//       落到 <数据目录>/devices/<id>/（每设备一份，不与本机数据合并，侧栏/顶栏按设备只读浏览）。

/// 钥匙串读写（最小封装）：钥匙串条目在卸载重装 App 后仍保留，是 iOS 上跨重装持久化的标准做法
enum Keychain {
  static func get(account: String, service: String) -> String? {
    let q = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecReturnData: true] as CFDictionary
    var item: CFTypeRef?
    guard SecItemCopyMatching(q, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ value: String, account: String, service: String) {
    let q = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary
    SecItemDelete(q)
    let a = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecValueData: Data(value.utf8)] as CFDictionary
    SecItemAdd(a, nil)
  }
}

/// 本设备标识（v3 多设备用）：服务端按 id 分槽存各设备最新版。
/// 存钥匙串（重装 App 不清除，槽位对得上）；种子取 identifierForVendor，取不到随机。
enum DeviceIdentity {
  private static let service = "errorbook.device"
  private static let account = "device-id"

  static func id() -> String {
    if let saved = Keychain.get(account: account, service: service), DeviceStore.isValidId(saved) { return saved }
    let seed = UIDevice.current.identifierForVendor?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
    let id = "ios-\(seed)"
    Keychain.set(id, account: account, service: service)
    return id
  }

  /// 设备名（系统设置里的本机名称，如「XX 的 iPhone」），推送时展示在服务端状态页
  static func name() -> String {
    let n = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
    return n.isEmpty ? "iPhone" : n
  }

  /// 推送时的设备头：名称按 URL 编码（HTTP 头放不了中文），服务端解码后展示
  static func headers() -> [String: String] {
    let encoded = name().addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name()
    return ["X-Device-Id": id(), "X-Device-Name": encoded]
  }
}

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
  enum Phase { case connect, assets, devices, data }
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

    // 3. 推送整份库到本设备的槽位（与磁盘 data.json 相同的序列化格式；服务端只覆盖本设备版本）
    if aborted { throw SyncAborted(uploaded: done) }
    onProgress(SyncProgress(phase: .data, done: done, total: missing.count, current: nil))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    let payload = try encoder.encode(db)
    let (dres, _) = try await request(
      URL(string: "\(base)/sync/data")!, method: "PUT",
      headers: ["Content-Type": "application/json"]
        .merging(DeviceIdentity.headers()) { a, _ in a }
        .merging(authHeaders(target)) { a, _ in a },
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

  // ---------- 拉取（v3：按设备分开下载，不合并） ----------

  struct ServerDevice: Decodable {
    var id: String
    var name: String?
    var lastPush: String?
    var mistakes: Int?
    var notes: Int?
    var folders: Int?
  }

  struct PulledDevice {
    var id: String
    var name: String
    var mistakes: Int
    var notes: Int
  }

  struct DevicePullResult {
    var pulled: [PulledDevice]
    var onlySelf: Bool
    var downloadedAssets: Int
    var missingAssets: Int
  }

  /// 服务端设备整库原始字节 + 名称（落盘用）
  private struct DevicePayload {
    var id: String
    var name: String
    var db: Database
  }

  /// 拉取服务端上全部设备（本机除外）的整库，各自落到 <dataDir>/devices/<id>/；
  /// 缺的图片按内容哈希下到主 assets/（各设备共用）。幂等可重入，不改本机 data.json。
  func pullDevices(
    _ target: SyncTarget,
    dataDir: URL,
    onProgress: @escaping (SyncProgress) -> Void
  ) async throws -> DevicePullResult {
    NetworkPermissionProbe.start()

    // 1. 连接探针 + 图片清单
    onProgress(SyncProgress(phase: .connect, done: 0, total: 0, current: nil))
    let (mres, mdata) = try await request(
      URL(string: "\(target.server)/sync/manifest")!, method: "GET",
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

    // 2. 设备清单
    let (dres, ddata) = try await request(
      URL(string: "\(target.server)/sync/devices")!, method: "GET",
      headers: authHeaders(target), connectTimeout: 5
    )
    if dres.statusCode == 401 || dres.statusCode == 403 {
      throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(dres.statusCode)）")
    }
    if dres.statusCode == 404 {
      throw SyncError.plain("服务端版本过旧（不支持按设备拉取），请升级服务端到协议 v3")
    }
    guard (200..<300).contains(dres.statusCode) else {
      throw SyncError.plain("获取设备清单失败：HTTP \(dres.statusCode)")
    }
    struct Listing: Decodable { var devices: [ServerDevice]? }
    guard let listing = try? JSONDecoder().decode(Listing.self, from: ddata), let devices = listing.devices else {
      throw SyncError.plain("服务端返回的设备清单格式不正确")
    }
    let ownId = DeviceIdentity.id()
    let others = devices.filter { $0.id != ownId }

    // 3. 逐台拉取设备整库，落盘到 devices/<id>/
    var payloads: [DevicePayload] = []
    for (i, d) in others.enumerated() {
      if aborted { throw SyncAborted(uploaded: 0) }
      guard DeviceStore.isValidId(d.id) else { continue }
      let dispName = (d.name?.isEmpty == false) ? d.name! : d.id
      onProgress(SyncProgress(phase: .devices, done: i, total: others.count, current: dispName))
      let (res, data) = try await request(
        URL(string: "\(target.server)/sync/data?device=\(d.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? d.id)")!,
        method: "GET", headers: authHeaders(target), connectTimeout: 5
      )
      if res.statusCode == 401 || res.statusCode == 403 {
        throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(res.statusCode)）")
      }
      if res.statusCode == 404 { continue } // 清单与槽位竞态：该设备数据没了，跳过
      guard (200..<300).contains(res.statusCode) else {
        throw SyncError.plain("拉取设备 \(dispName) 失败：HTTP \(res.statusCode)")
      }
      guard let db = try? JSONDecoder().decode(Database.self, from: data) else {
        throw SyncError.plain("设备 \(dispName) 返回的不是合法的题库数据")
      }
      let dir = dataDir.appendingPathComponent("devices/\(d.id)")
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted]
      try encoder.encode(db).write(to: dir.appendingPathComponent("data.json"))
      let meta: [String: String] = ["id": d.id, "name": dispName, "pulledAt": String(Int(Date().timeIntervalSince1970 * 1000))]
      try JSONSerialization.data(withJSONObject: meta).write(to: dir.appendingPathComponent("device.json"))
      payloads.append(DevicePayload(id: d.id, name: dispName, db: db))
    }
    onProgress(SyncProgress(phase: .devices, done: others.count, total: others.count, current: nil))

    // 4. 下载各设备库引用到而本地缺的图片（内容哈希，共用主 assets/）
    var need = Set<String>()
    for p in payloads { need.formUnion(collectLibraryAssets(p.db)) }
    var downloaded = 0
    var missing = 0
    let keys = need.sorted()
    for key in keys {
      if aborted { throw SyncAborted(uploaded: downloaded) }
      let dst = ImageStore.assetURL(dataDir, key: key)
      if FileManager.default.fileExists(atPath: dst.path) { continue } // 本地已有
      if !serverAssets.contains(key) { missing += 1; continue } // 服务端清单里没有，不打 404
      onProgress(SyncProgress(phase: .assets, done: downloaded + missing, total: keys.count, current: key))
      let (res, data) = try await request(
        URL(string: "\(target.server)/sync/asset/\(key)")!, method: "GET",
        headers: authHeaders(target), connectTimeout: 5
      )
      if res.statusCode == 404 { missing += 1; continue } // 服务端也缺：保留引用跳过
      if res.statusCode == 401 || res.statusCode == 403 {
        throw SyncError.plain("服务器拒绝：令牌无效或未授权（HTTP \(res.statusCode)）")
      }
      guard (200..<300).contains(res.statusCode) else {
        throw SyncError.plain("下载图片 \(key) 失败：HTTP \(res.statusCode)")
      }
      try data.write(to: dst)
      downloaded += 1
    }

    // 5. 以服务端清单为准：清掉本地已不在服务端的旧设备快照
    //    （远程设备栏只显示其他设备当前存在的推送；本机槽位本来就不拉取）
    var keepIds = Set(devices.map { $0.id })
    keepIds.insert(ownId)
    let rootDir = dataDir.appendingPathComponent("devices")
    if let names = try? FileManager.default.contentsOfDirectory(atPath: rootDir.path) {
      for id in names where DeviceStore.isValidId(id) && !keepIds.contains(id) {
        try? FileManager.default.removeItem(at: rootDir.appendingPathComponent(id))
      }
    }

    onProgress(SyncProgress(phase: .data, done: 1, total: 1, current: nil))

    return DevicePullResult(
      pulled: payloads.map { PulledDevice(id: $0.id, name: $0.name, mistakes: $0.db.mistakes.count, notes: $0.db.notes.count) },
      onlySelf: others.isEmpty,
      downloadedAssets: downloaded,
      missingAssets: missing
    )
  }
}

enum SyncError: LocalizedError {
  case plain(String)
  var errorDescription: String? {
    if case let .plain(msg) = self { return msg }
    return nil
  }
}
