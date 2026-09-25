import Foundation

// 文件夹树助手（对应桌面端 src/lib/folders.ts）

/// 按父级分组，同组内按名称自然排序
func groupByParent(_ folders: [Folder]) -> [String?: [Folder]] {
  var map: [String?: [Folder]] = [:]
  for f in folders {
    map[f.parentId, default: []].append(f)
  }
  for key in map.keys {
    map[key]?.sort { String.naturalLess($0.name, $1.name) }
  }
  return map
}

/// 深度优先平铺（父在前、同级有序），供选择器使用
func flatFolders(_ folders: [Folder]) -> [(folder: Folder, depth: Int)] {
  let byParent = groupByParent(folders)
  var out: [(Folder, Int)] = []
  func walk(_ parent: String?, _ depth: Int) {
    for f in byParent[parent] ?? [] {
      out.append((f, depth))
      walk(f.id, depth + 1)
    }
  }
  walk(nil, 0)
  return out
}

/// 完整路径名：「数学 / 立体几何」；找不到或 nil 返回「未分类」
func folderPathName(_ folders: [Folder], _ id: String?) -> String {
  guard let id else { return "未分类" }
  var byId: [String: Folder] = [:]
  for f in folders { byId[f.id] = f }
  var names: [String] = []
  var cur = byId[id]
  var guardCount = 0
  while let c = cur, guardCount < 64 {
    names.insert(c.name, at: 0)
    cur = c.parentId.flatMap { byId[$0] }
    guardCount += 1
  }
  return names.isEmpty ? "未分类" : names.joined(separator: " / ")
}

/// 自身 + 所有后代文件夹的 id 集合
func descendantSet(_ folders: [Folder], _ id: String) -> Set<String> {
  let byParent = groupByParent(folders)
  var set = Set<String>()
  func walk(_ fid: String) {
    set.insert(fid)
    for child in byParent[fid] ?? [] { walk(child.id) }
  }
  walk(id)
  return set
}

/// 该文件夹（含子文件夹）里的错题数；一道题属于多个文件夹时在每个文件夹都计数
func countInFolder(_ mistakes: [Mistake], _ folders: [Folder], _ id: String) -> Int {
  let set = descendantSet(folders, id)
  return mistakes.filter { m in m.folderIds.contains { set.contains($0) } }.count
}

/// 未分类 = 没有任何文件夹 id，或所有 id 都指向已不存在的文件夹
func countUncategorized(_ mistakes: [Mistake], _ folders: [Folder]) -> Int {
  let ids = Set(folders.map { $0.id })
  return mistakes.filter { m in !m.folderIds.contains { ids.contains($0) } }.count
}

/// 已分类 = 至少属于一个（仍存在的）文件夹，与未分类互补
func countCategorized(_ mistakes: [Mistake], _ folders: [Folder]) -> Int {
  let ids = Set(folders.map { $0.id })
  return mistakes.filter { m in m.folderIds.contains { ids.contains($0) } }.count
}
