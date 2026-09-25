package com.errorbook.android

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// MARK: - 数据库加载/落盘（对应桌面端 src/lib/db.ts + src/store.tsx、iOS 端 BookStore.swift）
// 数据目录固定为 App 外部私有目录（getExternalFilesDir/错题本）：
// 免存储权限、USB 连电脑可见（MTP），可与桌面版整目录互拷；卸载 App 即删除。

private const val MAX_SNAPSHOTS = 20

class BookStore(context: Context) {

    val db = MutableStateFlow(Database())
    val loadError = MutableStateFlow<String?>(null)
    val dbState: StateFlow<Database> get() = db

    val dataDir: File = File(context.getExternalFilesDir(null) ?: context.filesDir, "错题本")
    val assetsDir: File get() = File(dataDir, "assets")

    /** 写盘串行队列：所有落盘按顺序执行，快速连续 mutate 也不会交错写坏文件 */
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))
    private val lock = Any()

    val allTags: List<String> get() = tagCounts.map { it.first }

    /** 错题自带标签的计数 + 预建标签（计数 0，列表里置灰可点），按自然排序 */
    val tagCounts: List<Pair<String, Int>>
        get() {
            val m = LinkedHashMap<String, Int>()
            for (x in db.value.mistakes) for (t in x.tags) m[t] = (m[t] ?: 0) + 1
            for (t in db.value.tags) if (!m.containsKey(t)) m[t] = 0
            return m.entries.sortedWith { a, b -> if (naturalLess(a.key, b.key)) -1 else if (naturalLess(b.key, a.key)) 1 else a.key.compareTo(b.key) }
                .map { it.key to it.value }
        }

    init {
        try {
            ensureDirs(dataDir)
            db.value = loadDb(dataDir)
        } catch (e: Exception) {
            loadError.value = "数据目录初始化失败：${e.message}"
        }
    }

    // MARK: 文件层

    fun persist() {
        val snapshot = synchronized(lock) { db.value }
        ioScope.launch {
            try {
                saveDb(snapshot, dataDir)
            } catch (e: Exception) {
                Log.e("BookStore", "保存失败", e)
            }
        }
    }

    /** 改库统一入口：同步换内存态，异步落盘（顺序队列保证最终一致） */
    fun mutate(f: (Database) -> Database) {
        synchronized(lock) { db.value = f(db.value) }
        persist()
    }

    companion object {
        val json = Json {
            prettyPrint = true
            ignoreUnknownKeys = true
            isLenient = true
        }

        fun ensureDirs(dir: File) {
            for (sub in listOf("assets", "snapshots")) File(dir, sub).mkdirs()
        }

        fun loadDb(dir: File): Database {
            val path = File(dir, "data.json")
            if (!path.exists()) return Database()
            return try {
                json.decodeFromString(DatabaseSerializer, path.readText())
            } catch (e: Exception) {
                Log.e("BookStore", "data.json 解析失败，按空数据处理", e)
                Database()
            }
        }

        /** 快照至少间隔 1 分钟做一次，避免刷屏 */
        private var lastSnapshotAt = 0.0

        /** 原子写入：先写临时文件再替换；替换前把旧版拷进 snapshots/（限流 + 保留最近 20 份） */
        fun saveDb(db: Database, dir: File) {
            ensureDirs(dir)
            val dataPath = File(dir, "data.json")
            val now = nowMs()
            if (dataPath.exists() && now - lastSnapshotAt > 60_000) {
                lastSnapshotAt = now
                val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                fmt.timeZone = TimeZone.getTimeZone("UTC")
                val stamp = fmt.format(Date()).replace(":", "-").replace(".", "-")
                try {
                    dataPath.copyTo(File(dir, "snapshots/data-$stamp.json"), overwrite = true)
                } catch (_: Exception) {
                }
                pruneSnapshots(File(dir, "snapshots"))
            }
            val tmp = File(dir, "data.json.tmp")
            tmp.writeText(json.encodeToString(DatabaseSerializer, db))
            if (dataPath.exists()) {
                Files.move(tmp.toPath(), dataPath.toPath(), StandardCopyOption.REPLACE_EXISTING)
            } else {
                Files.move(tmp.toPath(), dataPath.toPath())
            }
        }

        private fun pruneSnapshots(snapDir: File) {
            val sorted = snapDir.listFiles()?.filter { it.name.startsWith("data-") }?.sortedBy { it.name } ?: return
            if (sorted.size <= MAX_SNAPSHOTS) return
            sorted.subList(0, sorted.size - MAX_SNAPSHOTS).forEach { it.delete() }
        }
    }

    // MARK: 错题 CRUD

    fun addMistake(m: Mistake) = mutate { it.copy(mistakes = it.mistakes + m) }

    fun updateMistake(m: Mistake) = mutate { d ->
        d.copy(mistakes = d.mistakes.map { if (it.id == m.id) m else it })
    }

    fun mistake(id: String): Mistake? = db.value.mistakes.firstOrNull { it.id == id }

    fun deleteMistake(id: String) = mutate { d -> d.copy(mistakes = d.mistakes.filter { it.id != id }) }

    fun setMistakeFolders(mistakeId: String, folderIds: List<String>) = mutate { d ->
        d.copy(mistakes = d.mistakes.map { m ->
            if (m.id == mistakeId) m.copy(folderIds = folderIds, updatedAt = nowMs()) else m
        })
    }

    // MARK: 文件夹 CRUD

    fun createFolder(name: String, parentId: String?): Folder {
        val f = Folder(name = name.trim(), parentId = parentId)
        mutate { it.copy(folders = it.folders + f) }
        return f
    }

    /** 按名称+父级查找，没有就创建（批量导入按源结构落位用） */
    fun findOrCreateFolder(name: String, parentId: String?): Folder {
        val trimmed = name.trim()
        db.value.folders.firstOrNull { it.name == trimmed && it.parentId == parentId }?.let { return it }
        val f = Folder(name = trimmed, parentId = parentId)
        mutate { it.copy(folders = it.folders + f) }
        return f
    }

    fun renameFolder(id: String, name: String) = mutate { d ->
        d.copy(folders = d.folders.map { if (it.id == id) it.copy(name = name.trim()) else it })
    }

    /** 删除文件夹：从错题的所属列表里移除该文件夹（清空的落到未分类），子文件夹上移一级 */
    fun deleteFolder(id: String) = mutate { d ->
        val parentId = d.folders.firstOrNull { it.id == id }?.parentId
        d.copy(
            folders = d.folders.filter { it.id != id }.map { if (it.parentId == id) it.copy(parentId = parentId) else it },
            mistakes = d.mistakes.map { m ->
                if (m.folderIds.contains(id)) m.copy(folderIds = m.folderIds.filter { it != id }) else m
            }
        )
    }

    // MARK: 笔记 CRUD

    fun addNote(n: Note) = mutate { it.copy(notes = it.notes + n) }

    fun updateNote(n: Note) = mutate { d -> d.copy(notes = d.notes.map { if (it.id == n.id) n else it }) }

    fun deleteNote(id: String) = mutate { d -> d.copy(notes = d.notes.filter { it.id != id }) }

    // MARK: 批量并入（合并导入/远程拉取用），按 id 去重，返回实际新增数

    fun addMistakes(ms: List<Mistake>): Int {
        var added = 0
        mutate { d ->
            val ids = d.mistakes.map { it.id }.toSet()
            val add = ms.filter { it.id !in ids }
            added = add.size
            if (add.isEmpty()) d else d.copy(mistakes = d.mistakes + add)
        }
        return added
    }

    fun addNotes(ns: List<Note>): Int {
        var added = 0
        mutate { d ->
            val ids = d.notes.map { it.id }.toSet()
            val add = ns.filter { it.id !in ids }
            added = add.size
            if (add.isEmpty()) d else d.copy(notes = d.notes + add)
        }
        return added
    }

    // MARK: 标签

    /** 新建预建标签；空名或已存在（错题已带/已预建）时静默跳过 */
    fun createTag(name: String) {
        val t = name.trim()
        if (t.isEmpty()) return
        val used = db.value.mistakes.flatMap { it.tags }.toSet()
        if (t in used || t in db.value.tags) return
        mutate { it.copy(tags = it.tags + t) }
    }

    // MARK: 待导入清单（做题 tab）

    fun addPendingImport(p: PendingImport) = mutate { d ->
        if (d.pendingImports.any { it.id == p.id }) d else d.copy(pendingImports = d.pendingImports + p)
    }

    fun addPendingImports(ps: List<PendingImport>): Int {
        var added = 0
        mutate { d ->
            val ids = d.pendingImports.map { it.id }.toSet()
            val add = ps.filter { it.id !in ids }
            added = add.size
            if (add.isEmpty()) d else d.copy(pendingImports = d.pendingImports + add)
        }
        return added
    }

    fun removePendingImport(id: String) = mutate { d ->
        d.copy(pendingImports = d.pendingImports.filter { it.id != id })
    }

    /** 批量并入预建标签（合并导入用），跳过已有（含错题已带的），返回实际新增数 */
    fun addTags(names: List<String>): Int {
        var added = 0
        mutate { d ->
            val used = d.mistakes.flatMap { it.tags }.toSet() + d.tags
            val seen = mutableSetOf<String>()
            val add = names.map { it.trim() }.filter { it.isNotEmpty() && it !in used && seen.add(it) }
            added = add.size
            if (add.isEmpty()) d else d.copy(tags = d.tags + add)
        }
        return added
    }
}
