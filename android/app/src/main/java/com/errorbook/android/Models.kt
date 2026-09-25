package com.errorbook.android

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

// MARK: - Block（题目/解析的内容块：文字或图片）
// 对应 iOS 端 Models.swift / 桌面端 src/types.ts：图片块没有 id 字段。

sealed class Block {
    data class Text(val id: String, val text: String) : Block()

    /** 图片内容哈希，对应数据目录 assets/<hash>.<ext> */
    data class Image(val hash: String, val ext: String) : Block()
}

object BlockSerializer : KSerializer<Block> {
    private val json = Json
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Block") { element<String>("type") }

    override fun deserialize(decoder: Decoder): Block {
        val o = decoder.jsonElement().jsonObject
        return if (o.str("type") == "image") {
            Block.Image(o.str("hash") ?: "", o.str("ext") ?: "png")
        } else {
            Block.Text(o.str("id") ?: newId(), o.str("text") ?: "")
        }
    }

    override fun serialize(encoder: Encoder, value: Block) {
        val o = when (value) {
            is Block.Text -> buildJsonObject {
                put("id", value.id)
                put("type", "text")
                put("text", value.text)
            }
            is Block.Image -> buildJsonObject {
                put("type", "image")
                put("hash", value.hash)
                put("ext", value.ext)
            }
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - 文件夹

data class Folder(
    val id: String = newId(),
    val name: String = "",
    /** null 表示根层级 */
    val parentId: String? = null,
    val createdAt: Double = nowMs()
)

object FolderSerializer : KSerializer<Folder> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Folder") { element<String>("id") }

    override fun deserialize(decoder: Decoder): Folder {
        val o = decoder.jsonElement().jsonObject
        return Folder(
            id = o.str("id") ?: newId(),
            name = o.str("name") ?: "",
            parentId = o.strOrNull("parentId"),
            createdAt = o.num("createdAt") ?: nowMs()
        )
    }

    override fun serialize(encoder: Encoder, value: Folder) {
        val o = buildJsonObject {
            put("id", value.id)
            put("name", value.name)
            if (value.parentId != null) put("parentId", value.parentId!!) else put("parentId", kotlinx.serialization.json.JsonNull)
            put("createdAt", value.createdAt)
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - 错题

data class Mistake(
    val id: String = newId(),
    /** 所属文件夹（可多个；空 = 未分类）。旧数据的单个 folderId 解码时自动迁移 */
    val folderIds: List<String> = emptyList(),
    /** 选择题选项；空 = 非选择题（不参与作答与错误率） */
    val options: List<String> = emptyList(),
    /** 正确选项下标；null = 未标记 */
    val answer: Int? = null,
    /** 作答统计：错误率 = wrong / attempts（attempts 为 0 视为 0%） */
    val attempts: Int = 0,
    val wrong: Int = 0,
    val question: List<Block> = emptyList(),
    val analysis: List<Block> = emptyList(),
    val tags: List<String> = emptyList(),
    val createdAt: Double = nowMs(),
    val updatedAt: Double = nowMs()
)

object MistakeSerializer : KSerializer<Mistake> {
    private val json = Json

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Mistake") { element<String>("id") }

    private fun blocks(o: JsonObject, key: String): List<Block> =
        (o[key] as? JsonArray)?.map { json.decodeFromJsonElement(BlockSerializer, it) } ?: emptyList()

    private fun strings(o: JsonObject, key: String): List<String> =
        (o[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()

    override fun deserialize(decoder: Decoder): Mistake {
        val o = decoder.jsonElement().jsonObject
        // 新格式 folderIds[]；旧格式单个 folderId 自动迁移成一项，都没有 = 未分类
        val folderIds = (o["folderIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: o.str("folderId")?.let { listOf(it) }
            ?: emptyList()
        return Mistake(
            id = o.str("id") ?: newId(),
            folderIds = folderIds,
            options = strings(o, "options"),
            answer = o.intOrNullF("answer"),
            attempts = o.intOrNullF("attempts") ?: 0,
            wrong = o.intOrNullF("wrong") ?: 0,
            question = blocks(o, "question"),
            analysis = blocks(o, "analysis"),
            tags = strings(o, "tags"),
            createdAt = o.num("createdAt") ?: nowMs(),
            updatedAt = o.num("updatedAt") ?: nowMs()
        )
    }

    override fun serialize(encoder: Encoder, value: Mistake) {
        val o = buildJsonObject {
            put("id", value.id)
            putJsonArray("folderIds") { value.folderIds.forEach { add(JsonPrimitive(it)) } }
            putJsonArray("options") { value.options.forEach { add(JsonPrimitive(it)) } }
            value.answer?.let { put("answer", it) }
            put("attempts", value.attempts)
            put("wrong", value.wrong)
            putJsonArray("question") { value.question.forEach { add(json.encodeToJsonElement(BlockSerializer, it)) } }
            putJsonArray("analysis") { value.analysis.forEach { add(json.encodeToJsonElement(BlockSerializer, it)) } }
            putJsonArray("tags") { value.tags.forEach { add(JsonPrimitive(it)) } }
            put("createdAt", value.createdAt)
            put("updatedAt", value.updatedAt)
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - 笔记

enum class NoteFormat(val raw: String) {
    MARKDOWN("markdown"),
    WORD("word");

    companion object {
        fun from(raw: String?): NoteFormat = if (raw == "word") WORD else MARKDOWN
    }
}

data class Note(
    val id: String = newId(),
    val title: String = "",
    /** markdown 存源文本；word 存富文本 HTML；图片引用 assets/<hash>.<ext> */
    val format: NoteFormat = NoteFormat.MARKDOWN,
    val content: String = "",
    val createdAt: Double = nowMs(),
    val updatedAt: Double = nowMs()
)

object NoteSerializer : KSerializer<Note> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Note") { element<String>("id") }

    override fun deserialize(decoder: Decoder): Note {
        val o = decoder.jsonElement().jsonObject
        return Note(
            id = o.str("id") ?: newId(),
            title = o.str("title") ?: "",
            format = NoteFormat.from(o.str("format")),
            content = o.str("content") ?: "",
            createdAt = o.num("createdAt") ?: nowMs(),
            updatedAt = o.num("updatedAt") ?: nowMs()
        )
    }

    override fun serialize(encoder: Encoder, value: Note) {
        val o = buildJsonObject {
            put("id", value.id)
            put("title", value.title)
            put("format", value.format.raw)
            put("content", value.content)
            put("createdAt", value.createdAt)
            put("updatedAt", value.updatedAt)
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - 待导入清单（做题 tab：手机做题 → 同步 → 电脑导入）

data class PendingImportEntry(
    /** 题号（1 起） */
    val no: Int,
    /** 我的答案（A–D，未作答 null） */
    val mine: String? = null,
    /** 正确答案（未对 null） */
    val key: String? = null,
    /** 做题时标记 ⭐ */
    val flagged: Boolean = false
)

data class PendingImport(
    val id: String = newId(),
    val folderName: String = "",
    val createdAt: Double = nowMs(),
    val total: Int = 0,
    val entries: List<PendingImportEntry> = emptyList()
)

object PendingImportEntrySerializer : KSerializer<PendingImportEntry> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("PendingImportEntry") { element<Int>("no") }

    override fun deserialize(decoder: Decoder): PendingImportEntry {
        val o = decoder.jsonElement().jsonObject
        return PendingImportEntry(
            no = o.intOrNullF("no") ?: 0,
            mine = o.str("mine"),
            key = o.str("key"),
            flagged = o.boolOrNullF("flagged") ?: false
        )
    }

    override fun serialize(encoder: Encoder, value: PendingImportEntry) {
        val o = buildJsonObject {
            put("no", value.no)
            value.mine?.let { put("mine", it) }
            value.key?.let { put("key", it) }
            put("flagged", value.flagged)
        }
        encoder.encodeJsonElement(o)
    }
}

object PendingImportSerializer : KSerializer<PendingImport> {
    private val json = Json

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("PendingImport") { element<String>("id") }

    override fun deserialize(decoder: Decoder): PendingImport {
        val o = decoder.jsonElement().jsonObject
        return PendingImport(
            id = o.str("id") ?: newId(),
            folderName = o.str("folderName") ?: "",
            createdAt = o.num("createdAt") ?: nowMs(),
            total = o.intOrNullF("total") ?: 0,
            entries = (o["entries"] as? JsonArray)?.map { json.decodeFromJsonElement(PendingImportEntrySerializer, it) } ?: emptyList()
        )
    }

    override fun serialize(encoder: Encoder, value: PendingImport) {
        val o = buildJsonObject {
            put("id", value.id)
            put("folderName", value.folderName)
            put("createdAt", value.createdAt)
            put("total", value.total)
            putJsonArray("entries") { value.entries.forEach { add(json.encodeToJsonElement(PendingImportEntrySerializer, it)) } }
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - 整库

data class Database(
    val version: Int = 3,
    val mistakes: List<Mistake> = emptyList(),
    val folders: List<Folder> = emptyList(),
    val notes: List<Note> = emptyList(),
    /** 预建的独立标签：不挂在任何错题上也存在（与桌面端一致），旧数据没有该字段按空处理 */
    val tags: List<String> = emptyList(),
    /** 待导入清单（做题 tab 产生，跨设备同步，按 id 去重） */
    val pendingImports: List<PendingImport> = emptyList()
)

object DatabaseSerializer : KSerializer<Database> {
    private val json = Json

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Database") { element<Int>("version") }

    override fun deserialize(decoder: Decoder): Database {
        val o = decoder.jsonElement().jsonObject
        return Database(
            version = o.intOrNullF("version") ?: 3,
            mistakes = (o["mistakes"] as? JsonArray)?.map { json.decodeFromJsonElement(MistakeSerializer, it) } ?: emptyList(),
            folders = (o["folders"] as? JsonArray)?.map { json.decodeFromJsonElement(FolderSerializer, it) } ?: emptyList(),
            notes = (o["notes"] as? JsonArray)?.map { json.decodeFromJsonElement(NoteSerializer, it) } ?: emptyList(),
            tags = (o["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
            pendingImports = (o["pendingImports"] as? JsonArray)?.map { json.decodeFromJsonElement(PendingImportSerializer, it) } ?: emptyList()
        )
    }

    override fun serialize(encoder: Encoder, value: Database) {
        val o = buildJsonObject {
            put("version", value.version)
            putJsonArray("mistakes") { value.mistakes.forEach { add(json.encodeToJsonElement(MistakeSerializer, it)) } }
            putJsonArray("folders") { value.folders.forEach { add(json.encodeToJsonElement(FolderSerializer, it)) } }
            putJsonArray("notes") { value.notes.forEach { add(json.encodeToJsonElement(NoteSerializer, it)) } }
            putJsonArray("tags") { value.tags.forEach { add(JsonPrimitive(it)) } }
            putJsonArray("pendingImports") { value.pendingImports.forEach { add(json.encodeToJsonElement(PendingImportSerializer, it)) } }
        }
        encoder.encodeJsonElement(o)
    }
}

// MARK: - JSON 取值小工具（宽容解码：字段缺失/null/类型不符一律回退默认值，与 iOS 端 try? decode 同口径）

private fun Decoder.jsonElement(): kotlinx.serialization.json.JsonElement =
    (this as? JsonDecoder)?.decodeJsonElement() ?: throw UnsupportedOperationException("仅支持 JSON 格式")

private fun Encoder.encodeJsonElement(e: kotlinx.serialization.json.JsonElement) {
    (this as? JsonEncoder)?.encodeJsonElement(e) ?: throw UnsupportedOperationException("仅支持 JSON 格式")
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.strOrNull(key: String): String? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    return (v as? JsonPrimitive)?.contentOrNull
}
private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.intOrNullF(key: String): Int? {
    val v = this[key] ?: return null
    if (v is JsonNull) return null
    val p = v as? JsonPrimitive ?: return null
    return p.intOrNull ?: p.doubleOrNull?.toInt()
}
private fun JsonObject.boolOrNullF(key: String): Boolean? {
    val p = this[key] as? JsonPrimitive ?: return null
    return p.contentOrNull?.toBooleanStrictOrNull() ?: (p.intOrNull == 1)
}

// MARK: - 小工具

/** 毫秒时间戳（与桌面端 Date.now() 同口径） */
fun nowMs(): Double = System.currentTimeMillis().toDouble()

fun newId(): String = UUID.randomUUID().toString().lowercase()

/** mulberry32 伪随机数（0..<1）：种子固定则序列固定 */
private class Mulberry32(seed: Int) {
    private var s = if (seed == 0) 1 else seed

    fun next(): Double {
        s += 0x6D2B79F5
        var t = s
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        // 按无符号 32 位解释（Swift 端是 UInt32，Kotlin Int 有符号需转 Long 再抹掉符号位）
        return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
}

/** 以 seed 为种子的稳定洗牌：同 seed 同输入 → 同顺序（随机翻页用，重算不会跳序） */
fun <T> seededShuffle(arr: List<T>, seed: Int): List<T> {
    val a = arr.toMutableList()
    val rnd = Mulberry32(seed)
    for (i in a.size - 1 downTo 1) {
        val j = (rnd.next() * (i + 1)).toInt()
        val tmp = a[i]
        a[i] = a[j]
        a[j] = tmp
    }
    return a
}

/** 选择题错误率百分比（未作答按 0% 计） */
fun optionRate(m: Mistake): Int {
    if (m.attempts <= 0) return 0
    return Math.round(m.wrong.toDouble() / m.attempts.toDouble() * 100).toInt()
}

/** 文件名自然排序：题2 排在 题10 前面（近似桌面端 Intl.Collator numeric） */
fun naturalLess(a: String, b: String): Boolean {
    var ai = 0
    var bi = 0
    while (ai < a.length && bi < b.length) {
        val ac = a[ai]
        val bc = b[bi]
        if (ac.isDigit() && bc.isDigit()) {
            var ae = ai
            while (ae < a.length && a[ae].isDigit()) ae++
            var be = bi
            while (be < b.length && b[be].isDigit()) be++
            val an = a.substring(ai, ae).toLongOrNull() ?: 0L
            val bn = b.substring(bi, be).toLongOrNull() ?: 0L
            ai = ae
            bi = be
            if (an != bn) return an < bn
        } else {
            if (ac != bc) return ac.lowercaseChar() < bc.lowercaseChar()
            ai++
            bi++
        }
    }
    if (ai < a.length || bi < b.length) return a.length < b.length
    return false
}

private val timeFormat = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue() = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
}

private val dayFormat = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue() = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
}

fun formatTime(ms: Double): String = timeFormat.get()!!.format(Date((ms).toLong()))

/** 天级时间（本地时区），用于按导入日期分组 */
fun formatDay(ms: Double): String = dayFormat.get()!!.format(Date((ms).toLong()))

/** 没有任何有效内容（无文字且无图片）返回 true */
fun isBlocksEmpty(blocks: List<Block>): Boolean = blocks.none { b ->
    when (b) {
        is Block.Text -> b.text.trim().isNotEmpty()
        is Block.Image -> true
    }
}

fun blocksToPlainText(blocks: List<Block>): String = blocks.joinToString("\n") { b ->
    when (b) {
        is Block.Text -> b.text
        is Block.Image -> "[图]"
    }
}.trim()
