package com.errorbook.android

// 文件夹树助手（对应桌面端 src/lib/folders.ts、iOS 端 Folders.swift）

data class FlatFolder(val folder: Folder, val depth: Int)

/** 按父级分组，同组内按名称自然排序 */
fun groupByParent(folders: List<Folder>): Map<String?, List<Folder>> {
    val map = LinkedHashMap<String?, MutableList<Folder>>()
    for (f in folders) map.getOrPut(f.parentId) { mutableListOf() }.add(f)
    return map.mapValues { (_, v) -> v.sortedWith { a, b -> if (naturalLess(a.name, b.name)) -1 else if (naturalLess(b.name, a.name)) 1 else 0 } }
}

/** 深度优先平铺（父在前、同级有序），供选择器使用 */
fun flatFolders(folders: List<Folder>): List<FlatFolder> {
    val byParent = groupByParent(folders)
    val out = mutableListOf<FlatFolder>()

    fun walk(parent: String?, depth: Int) {
        for (f in byParent[parent] ?: emptyList()) {
            out.add(FlatFolder(f, depth))
            walk(f.id, depth + 1)
        }
    }
    walk(null, 0)
    return out
}

/** 完整路径名：「数学 / 立体几何」；找不到或 null 返回「未分类」 */
fun folderPathName(folders: List<Folder>, id: String?): String {
    if (id == null) return "未分类"
    val byId = folders.associateBy { it.id }
    val names = mutableListOf<String>()
    var cur = byId[id]
    var guardCount = 0
    while (cur != null && guardCount < 64) {
        names.add(0, cur.name)
        cur = cur.parentId?.let { byId[it] }
        guardCount++
    }
    return if (names.isEmpty()) "未分类" else names.joinToString(" / ")
}

/** 自身 + 所有后代文件夹的 id 集合 */
fun descendantSet(folders: List<Folder>, id: String): Set<String> {
    val byParent = groupByParent(folders)
    val set = mutableSetOf<String>()

    fun walk(fid: String) {
        set.add(fid)
        for (child in byParent[fid] ?: emptyList()) walk(child.id)
    }
    walk(id)
    return set
}

/** 该文件夹（含子文件夹）里的错题数；一道题属于多个文件夹时在每个文件夹都计数 */
fun countInFolder(mistakes: List<Mistake>, folders: List<Folder>, id: String): Int {
    val set = descendantSet(folders, id)
    return mistakes.count { m -> m.folderIds.any { it in set } }
}

/** 未分类 = 没有任何文件夹 id，或所有 id 都指向已不存在的文件夹 */
fun countUncategorized(mistakes: List<Mistake>, folders: List<Folder>): Int {
    val ids = folders.map { it.id }.toSet()
    return mistakes.count { m -> m.folderIds.none { it in ids } }
}
