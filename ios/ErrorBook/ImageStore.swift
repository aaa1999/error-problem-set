import Foundation
import CryptoKit
import UIKit

// MARK: - 图片入库（对应桌面端 src/lib/images.ts）
// 按内容 SHA-1 哈希命名存进 assets/，重复图片只存一份；格式与桌面端完全互通。

let imageExts: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]

func extOf(_ name: String) -> String {
  guard let i = name.lastIndex(of: ".") else { return "" }
  return String(name[name.index(after: i)...]).lowercased()
}

enum ImageStore {
  static func sha1Hex(_ data: Data) -> String {
    Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  /// 图片统一入库；ext 不在支持列表时按 png 处理
  static func save(data: Data, ext rawExt: String, into dataDir: URL) throws -> Block {
    let ext = imageExts.contains(rawExt) ? rawExt : "png"
    let hash = sha1Hex(data)
    let path = dataDir.appendingPathComponent("assets/\(hash).\(ext)")
    let fm = FileManager.default
    if !fm.fileExists(atPath: path.path) {
      try data.write(to: path, options: .atomic)
    }
    return .image(hash: hash, ext: ext)
  }

  static func assetURL(_ dataDir: URL, hash: String, ext: String) -> URL {
    dataDir.appendingPathComponent("assets/\(hash).\(ext)")
  }

  static func assetURL(_ dataDir: URL, key: String) -> URL {
    dataDir.appendingPathComponent("assets/\(key)")
  }

  /// 从本地文件 URL 导入图片，非图片返回 nil
  static func importFile(at url: URL, into dataDir: URL) throws -> Block? {
    let ext = extOf(url.lastPathComponent)
    guard imageExts.contains(ext) else { return nil }
    let data = try Data(contentsOf: url)
    return try save(data: data, ext: ext, into: dataDir)
  }

  /// 相册/剪贴板来的图片数据：按魔数识别格式，识别不出（如 HEIC）转 JPEG 再入库
  static func importPhotoData(_ data: Data, suggestedExt: String, into dataDir: URL) throws -> Block {
    let ext = sniffImageExt(data) ?? suggestedExt
    if imageExts.contains(ext) {
      return try save(data: data, ext: ext, into: dataDir)
    }
    // HEIC 等桌面端不认的格式：解码后统一转 JPEG
    if let ui = UIImage(data: data), let jpg = ui.jpegData(compressionQuality: 0.92) {
      return try save(data: jpg, ext: "jpg", into: dataDir)
    }
    return try save(data: data, ext: "png", into: dataDir)
  }

  /// 魔数嗅探图片格式
  static func sniffImageExt(_ data: Data) -> String? {
    guard data.count >= 12 else { return nil }
    let b = [UInt8](data.prefix(12))
    if b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 { return "png" }
    if b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return "jpg" }
    if b[0] == 0x47, b[1] == 0x49, b[2] == 0x46 { return "gif" }
    if b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 { return "webp" }
    if b[0] == 0x42, b[1] == 0x4D { return "bmp" }
    if b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70 { return "avif" } // ftyp 品牌（含 heic，交给调用方转换）
    return nil
  }
}
