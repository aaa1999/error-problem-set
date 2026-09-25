package com.errorbook.android

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileNotFoundException

// MARK: - 数据合并核心（合并导入使用，对应桌面端 src/lib/merge.ts、iOS 端 MergeImport.swift）
// 幂等合并：文件夹按「名称+父级」、错题/笔记按 id 去重、预建标签并入、图片按内容哈希只取缺的。
// 可重复执行，已并入的自动跳过。
// 远程同步已改为按设备分开落盘、不合并（SyncEngine.kt + BookStore.kt 的 DeviceStore）。

data class MergePlan(
    /** 合并导入时的源目录显示名 */
    val sourceName: String?,
    val source: Database,
    val newMistakes: List<Mistake>,
    val newNotes: List<Note>,
    val newTags: List<String>,
    val newPendingImports: List<PendingImport>,
    val imageKeys: List<String>,
    val skipped: Int,
    val skippedNotes: Int,
) {
    val imageCount: Int get() = imageKeys.size
}

data class MergeOutcome(
    val newMistakes: Int,
    val newNotes: Int,
    val newTags: Int,
    val foldersMerged: Int,
    val assetsFetched: Int,
    val assetsMissing: Int,
)

class MergeAborted(val fetched: Int) : Exception()
class MergeError(message: String) : Exception(message)

/** 纯差量计算：源库相对当前库会新增什么（不写任何数据） */
fun planMerge(source: Database, current: Database): MergePlan {
    val existing = current.mistakes.map { it.id }.toSet()
    val newMistakes = source.mistakes.filter { it.id !in existing }
    val existingNotes = current.notes.map { it.id }.toSet()
    val newNotes = source.notes.filter { it.id !in existingNotes }
    // 预建标签只数真正会新增的（当前已有 + 随新错题带进来的都不算，源内自身也去重）
    val present = buildSet {
        addAll(current.mistakes.flatMap { it.tags })
        addAll(current.tags)
        addAll(newMistakes.flatMap { it.tags })
    }
    val seen = mutableSetOf<String>()
    val newTags = source.tags.filter { seen.add(it) && it !in present }
    val imgs = sortedSetOf<String>()
    for (m in newMistakes) {
        for (b in m.question + m.analysis) {
            if (b is Block.Image) imgs.add("${b.hash}.${b.ext}")
        }
    }
    for (n in newNotes) {
        for (ref in collectAssetRefs(n.content)) imgs.add(ref.removePrefix("assets/"))
    }
    val pendingIds = current.pendingImports.map { it.id }.toSet()
    val newPendingImports = source.pendingImports.filter { it.id !in pendingIds }
    return MergePlan(
        sourceName = null,
        source = source,
        newMistakes = newMistakes,
        newNotes = newNotes,
        newTags = newTags,
        newPendingImports = newPendingImports,
        imageKeys = imgs.toList(),
        skipped = source.mistakes.size - newMistakes.size,
        skippedNotes = source.notes.size - newNotes.size,
    )
}

/**
 * 定位数据目录（SAF 树）：所选文件夹本身含 data.json 直接用；否则向下找两层。
 * 找到多个时报错让用户选具体那个。
 */
fun findDataDir(context: Context, root: Uri): Uri {
    val rootDoc = DocumentFile.fromTreeUri(context, root)
        ?: throw MergeError("无法访问所选文件夹")
    if (rootDoc.findFile("data.json") != null) return root
    val candidates = mutableListOf<DocumentFile>()

    fun scan(dir: DocumentFile, depth: Int) {
        if (depth > 2 || candidates.size > 1) return
        for (child in dir.listFiles()) {
            if (!child.isDirectory || child.name?.startsWith(".") == true) continue
            if (child.findFile("data.json") != null) {
                candidates.add(child)
            } else {
                scan(child, depth + 1)
            }
        }
    }
    scan(rootDoc, 1)
    if (candidates.size == 1) return candidates[0].uri
    if (candidates.size > 1) {
        throw MergeError("所选文件夹下有多个数据目录，请直接选择其中之一：${candidates.mapNotNull { it.name }.joinToString("、")}")
    }
    throw MergeError("所选文件夹里没有找到数据目录（需包含 data.json 与 assets 文件夹）。请选择另一台机器拷来的 data / 错题本 文件夹本身")
}

/** SAF 树数据源：负责读 data.json 与拷贝 assets 图片 */
class TreeSource(private val context: Context, val root: Uri) {
    private var assetsMap: MutableMap<String, DocumentFile>? = null

    fun loadDb(): Database? {
        val rootDoc = DocumentFile.fromTreeUri(context, root) ?: return null
        val dataFile = rootDoc.findFile("data.json") ?: return null
        return try {
            val text = context.contentResolver.openInputStream(dataFile.uri)?.use { it.readBytes().decodeToString() } ?: return null
            BookStore.json.decodeFromString(DatabaseSerializer, text)
        } catch (_: Exception) {
            null
        }
    }

    private fun assets(): Map<String, DocumentFile> {
        assetsMap?.let { return it }
        val map = mutableMapOf<String, DocumentFile>()
        val rootDoc = DocumentFile.fromTreeUri(context, root)
        rootDoc?.findFile("assets")?.listFiles()?.forEach { f -> f.name?.let { map[it] = f } }
        assetsMap = map
        return map
    }

    /** 把源目录里的一张图片拷到本地 assets；源里没有该文件返回 false（保留引用跳过） */
    fun copyAsset(key: String, dst: File): Boolean {
        if (dst.exists()) return true
        val src = assets()[key] ?: return false
        return try {
            context.contentResolver.openInputStream(src.uri)?.use { input ->
                dst.parentFile?.mkdirs()
                dst.outputStream().use { output -> input.copyTo(output) }
            } != null && dst.exists()
        } catch (_: Exception) {
            false
        }
    }
}

fun buildMergePlan(context: Context, treeRoot: Uri, current: Database): Pair<TreeSource, MergePlan> {
    val dataUri = findDataDir(context, treeRoot)
    val source = TreeSource(context, dataUri)
    val db = source.loadDb() ?: throw MergeError("源目录的 data.json 无法读取")
    if (db.mistakes.isEmpty() && db.notes.isEmpty()) {
        throw MergeError("该数据目录里没有错题或笔记数据")
    }
    val name = DocumentFile.fromTreeUri(context, dataUri)?.name ?: "数据目录"
    val plan = planMerge(db, current).copy(sourceName = name)
    return source to plan
}

/**
 * 执行合并：ensureAsset 负责把图片写进本地 assets（返回 false = 源端也缺，保留引用跳过）。
 * 中止在图片间隙生效（shouldAbort），抛 MergeAborted，已取回的图片保留（哈希命名，下次跳过）。
 */
suspend fun runMergeCore(
    plan: MergePlan,
    store: BookStore,
    ensureAsset: suspend (String) -> Boolean,
    onProgress: (Int, Int, String?) -> Unit,
    shouldAbort: () -> Boolean = { false },
): MergeOutcome = withContext(Dispatchers.IO) {
    val total = plan.newMistakes.size + plan.newNotes.size + plan.imageCount
    var done = 0
    onProgress(0, total, null)

    // 1. 文件夹按「名称+父级」合并（父层先处理，同名复用不重建）
    val byId = plan.source.folders.associateBy { it.id }

    fun depthOf(f: Folder): Int {
        var d = 0
        var p = f.parentId
        var guardCount = 0
        while (p != null && guardCount < 64) {
            val par = byId[p] ?: break
            d++
            p = par.parentId
            guardCount++
        }
        return d
    }

    val sorted = plan.source.folders.sortedBy { depthOf(it) }
    val fmap = mutableMapOf<String, String>()
    for (f in sorted) {
        val dst = store.findOrCreateFolder(f.name, f.parentId?.let { fmap[it] })
        fmap[f.id] = dst.id
    }

    // 2. 取回缺失的图片（本地已有的由 ensureAsset 跳过；取不到的保留引用跳过不阻断）
    var fetched = 0
    var missing = 0
    for (key in plan.imageKeys) {
        if (shouldAbort()) throw MergeAborted(fetched)
        onProgress(done, total, key)
        if (ensureAsset(key)) fetched++ else missing++
        done++
    }

    // 3. 错题与笔记入册（保留原 id/时间戳与选项/统计，错题的每个所属文件夹都映射到合并后的目标）+ 预建标签并入
    val mapped = plan.newMistakes.map { m ->
        m.copy(folderIds = m.folderIds.mapNotNull { fmap[it] })
    }
    store.addMistakes(mapped)
    done += plan.newMistakes.size
    onProgress(done, total, null)
    if (plan.newNotes.isNotEmpty()) store.addNotes(plan.newNotes)
    if (plan.source.tags.isNotEmpty()) store.addTags(plan.source.tags)
    if (plan.newPendingImports.isNotEmpty()) store.addPendingImports(plan.newPendingImports)
    onProgress(total, total, null)

    MergeOutcome(
        newMistakes = plan.newMistakes.size,
        newNotes = plan.newNotes.size,
        newTags = plan.newTags.size,
        foldersMerged = plan.source.folders.size,
        assetsFetched = fetched,
        assetsMissing = missing,
    )
}

/** 合并结果的统一文案（合并导入用） */
fun mergeOutcomeText(plan: MergePlan, o: MergeOutcome): String {
    val parts = mutableListOf(
        "新导入 ${o.newMistakes} 道错题、${o.newNotes} 篇笔记",
        "跳过 ${plan.skipped} 道错题、${plan.skippedNotes} 篇笔记（已存在）",
        "${o.foldersMerged} 个文件夹已按名称合并",
    )
    if (o.newTags > 0) parts.add("预建标签新增 ${o.newTags} 个")
    if (plan.newPendingImports.isNotEmpty()) parts.add("待导入清单新增 ${plan.newPendingImports.size} 份")
    if (o.assetsMissing > 0) parts.add("${o.assetsMissing} 张图片源端缺失已跳过")
    return "合并完成：${parts.joinToString("，")}。"
}

/** 目录合并导入的执行入口：图片从源目录拷贝（本地已有的跳过，源里也缺的保留引用） */
suspend fun runMerge(plan: MergePlan, store: BookStore, source: TreeSource, onProgress: (Int, Int) -> Unit): String {
    val outcome = runMergeCore(
        plan = plan,
        store = store,
        ensureAsset = { key ->
            val dst = File(store.dataDir, "assets/$key")
            if (dst.exists()) true else source.copyAsset(key, dst)
        },
        onProgress = { done, total, _ -> onProgress(done, total) },
    )
    return mergeOutcomeText(plan, outcome)
}

/** 读不到时抛统一错误（供 UI 层提示） */
@Throws(FileNotFoundException::class)
fun requireDataJson(context: Context, uri: Uri) {
    DocumentFile.fromTreeUri(context, uri) ?: throw FileNotFoundException("无法访问所选文件夹")
}
