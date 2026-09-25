package com.errorbook.android

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// MARK: - 远程同步（推送 + 拉取）（对应桌面端 src/lib/sync.ts、iOS 端 SyncEngine.swift）
// 协议见 docs/sync-protocol.md（v2）：
// 推送：GET /sync/manifest 拿清单 → 只 PUT 缺的图片 → PUT /sync/data 推整库。
// 拉取：GET /sync/data 拿远端整库 → 与本地幂等合并（MergeImport.kt 的 runMergeCore）。
// 局域网自建服务的明文 http 已在 Manifest 里放行（usesCleartextTraffic）。

data class SyncTarget(
    /** 形如 http://192.168.1.100:8080（仅 scheme://host:port） */
    val server: String,
    val token: String?,
)

object SyncStore {
    private const val KEY = "errorbook.sync.server"

    fun load(context: Context): SyncTarget? {
        val raw = context.getSharedPreferences(KEY, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
        return try {
            val o = JSONObject(raw)
            val server = o.optString("server")
            if (server.isEmpty()) null else SyncTarget(server, o.optString("token").ifEmpty { null })
        } catch (_: Exception) {
            null
        }
    }

    fun save(context: Context, t: SyncTarget) {
        val o = JSONObject()
        o.put("server", t.server)
        t.token?.let { o.put("token", it) }
        context.getSharedPreferences(KEY, Context.MODE_PRIVATE).edit().putString(KEY, o.toString()).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(KEY, Context.MODE_PRIVATE).edit().remove(KEY).apply()
    }
}

/** "192.168.1.5:8080" / "http://host:port/…" → 规范 origin（自动补 http://）；无效返回 null */
fun normalizeServerAddr(input: String): String? {
    var s = input.trim()
    if (s.isEmpty()) return null
    if (!s.lowercase().startsWith("http://") && !s.lowercase().startsWith("https://")) {
        s = "http://$s"
    }
    return try {
        val u = URL(s)
        val host = u.host
        if (host.isNullOrEmpty()) return null
        var origin = "${u.protocol}://$host"
        if (u.port > 0) origin += ":${u.port}"
        origin
    } catch (_: Exception) {
        null
    }
}

/** 全库引用到的图片文件名集合（错题 blocks + 笔记正文） */
fun collectLibraryAssets(db: Database): Set<String> {
    val keys = mutableSetOf<String>()
    for (m in db.mistakes) {
        for (b in m.question + m.analysis) {
            if (b is Block.Image) keys.add("${b.hash}.${b.ext}")
        }
    }
    for (n in db.notes) {
        for (ref in collectAssetRefs(n.content)) {
            keys.add(ref.removePrefix("assets/"))
        }
    }
    return keys
}

/** phase: 0 = 连接 1 = 图片 2 = 数据 */
data class SyncProgress(val phase: Int, val done: Int, val total: Int, val current: String?)

data class SyncResult(
    val uploadedAssets: Int,
    val missingLocal: Int,
    val totalAssets: Int,
    val mistakes: Int,
    val notes: Int,
    val folders: Int,
)

class SyncAborted(val uploaded: Int) : Exception()
class SyncError(message: String) : Exception(message)

class SyncEngine {
    @Volatile
    private var aborted = false

    fun abort() {
        aborted = true
    }

    private fun authHeaders(target: SyncTarget): Map<String, String> =
        if (!target.token.isNullOrEmpty()) mapOf("X-Sync-Token" to target.token) else emptyMap()

    private fun request(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: ByteArray? = null,
        connectTimeoutSec: Int? = null,
    ): Pair<Int, ByteArray> = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = (connectTimeoutSec ?: 30) * 1000
        conn.readTimeout = 30_000
        for ((k, v) in headers) conn.setRequestProperty(k, v)
        if (body != null) {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(body.size)
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val bytes = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes() } ?: ByteArray(0)
            code to bytes
        } finally {
            conn.disconnect()
        }
    } catch (e: IOException) {
        throw SyncError("无法连接服务器：请检查地址、端口与网络。（${e.message ?: "网络错误"}）")
    }

    /** 推送整库。幂等可重入：中断后重新执行，已传过的图片自动跳过。 */
    suspend fun push(
        target: SyncTarget,
        db: Database,
        dataDir: File,
        onProgress: (SyncProgress) -> Unit,
    ): SyncResult = withContext(Dispatchers.IO) {
        val base = target.server

        // 1. 服务端图片清单
        onProgress(SyncProgress(0, 0, 0, null))
        val (mres, mdata) = request(
            "$base/sync/manifest", "GET", authHeaders(target), connectTimeoutSec = 5,
        )
        if (mres == 401 || mres == 403) {
            throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $mres）")
        }
        if (mres == 404) {
            throw SyncError("该地址不是错题同步服务端（/sync/manifest 返回 404），请确认地址与端口")
        }
        if (mres !in 200..299) {
            throw SyncError("获取清单失败：HTTP $mres")
        }
        val assets = try {
            JSONObject(mdata.decodeToString()).optJSONArray("assets")?.let { ja -> (0 until ja.length()).map { ja.getString(it) } }
        } catch (_: Exception) {
            null
        } ?: throw SyncError("该地址不是错题同步服务端：/sync/manifest 响应的不是本协议的 { assets: [...] }")
        val serverAssets = assets.toSet()

        // 2. 逐张上传服务端缺的图片
        val local = collectLibraryAssets(db)
        val missing = local.filter { it !in serverAssets }.sorted()
        var done = 0
        var missingLocal = 0
        for (key in missing) {
            if (aborted) throw SyncAborted(done)
            onProgress(SyncProgress(1, done, missing.size, key))
            val path = ImageStore.assetFile(dataDir, key)
            if (!path.exists()) {
                // 本地文件缺失：保留引用跳过
                missingLocal++
                done++
                continue
            }
            val bytes = path.readBytes()
            val (res, _) = request(
                "$base/sync/asset/$key", "PUT",
                mapOf("Content-Type" to "application/octet-stream") + authHeaders(target),
                bytes,
            )
            if (res == 401 || res == 403) {
                throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $res）")
            }
            if (res !in 200..299) {
                throw SyncError("上传图片 $key 失败：HTTP $res")
            }
            done++
        }

        // 3. 推送整份库（与磁盘 data.json 相同的序列化格式，覆盖式，最后推送为准）
        if (aborted) throw SyncAborted(done)
        onProgress(SyncProgress(2, done, missing.size, null))
        val payload = BookStore.json.encodeToString(DatabaseSerializer, db).toByteArray()
        val (dres, _) = request(
            "$base/sync/data", "PUT",
            mapOf("Content-Type" to "application/json") + authHeaders(target),
            payload,
        )
        if (dres == 401 || dres == 403) {
            throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $dres）")
        }
        if (dres !in 200..299) {
            throw SyncError("推送题库数据失败：HTTP $dres")
        }

        SyncResult(
            uploadedAssets = done - missingLocal,
            missingLocal = missingLocal,
            totalAssets = local.size,
            mistakes = db.mistakes.size,
            notes = db.notes.size,
            folders = db.folders.size,
        )
    }

    // ---------- 拉取（v2 协议） ----------

    /** 拉取阶段一：取远端整库并算差量（只读，不写任何数据），供确认预览 */
    suspend fun pullPlan(
        target: SyncTarget,
        current: Database,
        onProgress: (SyncProgress) -> Unit,
    ): MergePlan = withContext(Dispatchers.IO) {
        onProgress(SyncProgress(0, 0, 0, null))
        val (res, data) = request(
            "${target.server}/sync/data", "GET", authHeaders(target), connectTimeoutSec = 5,
        )
        if (res == 401 || res == 403) {
            throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $res）")
        }
        if (res == 404) {
            throw SyncError("服务器上还没有数据：请先从任意一端推送，或该服务端版本过旧（未实现拉取端点）")
        }
        if (res !in 200..299) {
            throw SyncError("拉取题库数据失败：HTTP $res")
        }
        val remote = try {
            BookStore.json.decodeFromString(DatabaseSerializer, data.decodeToString())
        } catch (_: Exception) {
            throw SyncError("服务端返回的不是合法的题库数据")
        }
        if (remote.mistakes.isEmpty() && remote.notes.isEmpty()) {
            throw SyncError("服务器上的库是空的（无错题无笔记），没有可拉取的内容")
        }
        planMerge(remote, current).copy(sourceName = "远程")
    }

    data class PullOutcome(
        val outcome: MergeOutcome,
        /** 本次实际从服务端下载的图片数 */
        val downloadedAssets: Int,
    )

    /** 拉取阶段二：下载缺失图片 + 幂等并入本地库 */
    suspend fun pull(
        target: SyncTarget,
        plan: MergePlan,
        store: BookStore,
        onProgress: (SyncProgress) -> Unit,
    ): PullOutcome = withContext(Dispatchers.IO) {
        var downloaded = 0
        val outcome = runMergeCore(
            plan = plan,
            store = store,
            ensureAsset = { key ->
                val dst = ImageStore.assetFile(store.dataDir, key)
                if (dst.exists()) return@runMergeCore true // 本地已有（内容哈希一致）
                val (res, data) = request(
                    "${target.server}/sync/asset/$key", "GET", authHeaders(target), connectTimeoutSec = 5,
                )
                if (res == 404) return@runMergeCore false // 服务端也缺这张图：保留引用跳过（与推送/合并口径一致）
                if (res == 401 || res == 403) {
                    throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $res）")
                }
                if (res !in 200..299) {
                    throw SyncError("下载图片 $key 失败：HTTP $res")
                }
                dst.parentFile?.mkdirs()
                dst.writeBytes(data)
                downloaded++
                true
            },
            onProgress = { done, total, current -> onProgress(SyncProgress(1, done, total, current)) },
            shouldAbort = { aborted },
        )
        onProgress(SyncProgress(2, 1, 1, null))
        PullOutcome(outcome, downloaded)
    }
}
