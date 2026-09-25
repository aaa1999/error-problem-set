package com.errorbook.android

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

// MARK: - 远程同步（推送 + 拉取）（对应桌面端 src/lib/sync.ts、iOS 端 SyncEngine.swift）
// 协议见 docs/sync-protocol.md（v3，多设备）：
// 推送：GET /sync/manifest 拿清单 → 只 PUT 缺的图片 →
//       PUT /sync/data（带 X-Device-Id/X-Device-Name 头）推整库——服务端只覆盖本设备的槽位。
// 拉取：GET /sync/devices 拿设备清单 → 逐台 GET /sync/data?device=<id> 取该设备原始整库，
//       落到 <数据目录>/devices/<id>/（每设备一份，不与本机数据合并，顶栏按设备只读浏览）。
// 局域网自建服务的明文 http 已在 Manifest 里放行（usesCleartextTraffic）。

/** 本设备标识（v3 多设备用）：服务端按 id 分槽存各设备最新版。
 *  用 ANDROID_ID（同一台设备重装 App 不变，Android 8+ 按 设备+签名键 稳定），异常时退回随机持久化。 */
object DeviceIdentity {
    private const val PREFS = "errorbook.device"

    fun id(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString("id", null)?.let { if (DeviceStore.isValidId(it)) return it }
        // ANDROID_ID：重装不变；历史上有过著名的 bug 值，遇到就退回随机
        val androidId = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (_: Exception) {
            null
        }
        val id = if (!androidId.isNullOrEmpty() && androidId != "9774d56d682d549c" && DeviceStore.isValidId(androidId)) {
            "android-$androidId"
        } else {
            val bytes = ByteArray(8)
            SecureRandom().nextBytes(bytes)
            "android-" + bytes.joinToString("") { "%02x".format(it) }
        }
        prefs.edit().putString("id", id).apply()
        return id
    }

    /** 设备名（机型，如「Pixel 7」），推送时展示在服务端状态页 */
    fun name(): String = Build.MODEL?.trim()?.takeIf { it.isNotEmpty() } ?: "Android"

    /** 推送时的设备头：名称按 URL 编码（HTTP 头放不了中文），服务端解码后展示 */
    fun headers(context: Context): Map<String, String> = mapOf(
        "X-Device-Id" to id(context),
        "X-Device-Name" to Uri.encode(name()),
    )
}

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

/** phase: 0 = 连接 1 = 图片 2 = 数据 3 = 逐台拉取设备库 */
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

class SyncEngine(private val context: Context) {
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

        // 3. 推送整份库到本设备的槽位（与磁盘 data.json 相同的序列化格式；服务端只覆盖本设备版本）
        if (aborted) throw SyncAborted(done)
        onProgress(SyncProgress(2, done, missing.size, null))
        val payload = BookStore.json.encodeToString(DatabaseSerializer, db).toByteArray()
        val (dres, _) = request(
            "$base/sync/data", "PUT",
            mapOf("Content-Type" to "application/json") + DeviceIdentity.headers(context) + authHeaders(target),
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

    // ---------- 拉取（v3：按设备分开下载，不合并） ----------

    data class ServerDevice(
        val id: String,
        val name: String,
        val lastPush: String,
    )

    data class PulledDevice(val id: String, val name: String, val mistakes: Int, val notes: Int)

    data class DevicePullResult(
        val pulled: List<PulledDevice>,
        /** 服务端上除本机外没有其他设备数据 */
        val onlySelf: Boolean,
        val downloadedAssets: Int,
        val missingAssets: Int,
    )

    /** 拉取服务端上全部设备（本机除外）的整库，各自落到 <dataDir>/devices/<id>/；
     *  缺的图片按内容哈希下到主 assets/（各设备共用）。幂等可重入，不改本机 data.json。 */
    suspend fun pullDevices(
        target: SyncTarget,
        dataDir: File,
        onProgress: (SyncProgress) -> Unit,
    ): DevicePullResult = withContext(Dispatchers.IO) {
        // 1. 连接探针 + 图片清单
        onProgress(SyncProgress(0, 0, 0, null))
        val (mres, mdata) = request(
            "${target.server}/sync/manifest", "GET", authHeaders(target), connectTimeoutSec = 5,
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
        val serverAssets = try {
            val arr = JSONObject(mdata.decodeToString()).optJSONArray("assets")
                ?: throw SyncError("该地址不是错题同步服务端：/sync/manifest 响应的不是本协议的 { assets: [...] }")
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        } catch (e: SyncError) {
            throw e
        } catch (_: Exception) {
            throw SyncError("该地址不是错题同步服务端：/sync/manifest 响应的不是本协议的 { assets: [...] }")
        }

        // 2. 设备清单
        val (dres, ddata) = request(
            "${target.server}/sync/devices", "GET", authHeaders(target), connectTimeoutSec = 5,
        )
        if (dres == 401 || dres == 403) {
            throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $dres）")
        }
        if (dres == 404) {
            throw SyncError("服务端版本过旧（不支持按设备拉取），请升级服务端到协议 v3")
        }
        if (dres !in 200..299) {
            throw SyncError("获取设备清单失败：HTTP $dres")
        }
        val devices = try {
            val arr = JSONObject(ddata.decodeToString()).optJSONArray("devices")
                ?: throw SyncError("服务端返回的设备清单格式不正确")
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id")
                if (id.isEmpty()) null else ServerDevice(id, o.optString("name").ifEmpty { id }, o.optString("lastPush"))
            }
        } catch (e: SyncError) {
            throw e
        } catch (_: Exception) {
            throw SyncError("服务端返回的设备清单格式不正确")
        }
        val ownId = DeviceIdentity.id(context)
        val others = devices.filter { it.id != ownId }

        // 3. 逐台拉取设备整库，落盘到 devices/<id>/
        data class Payload(val id: String, val name: String, val db: Database)
        val payloads = mutableListOf<Payload>()
        for ((i, d) in others.withIndex()) {
            if (aborted) throw SyncAborted(0)
            if (!DeviceStore.isValidId(d.id)) continue
            onProgress(SyncProgress(3, i, others.size, d.name))
            val (res, data) = request(
                "${target.server}/sync/data?device=${Uri.encode(d.id)}", "GET", authHeaders(target), connectTimeoutSec = 5,
            )
            if (res == 401 || res == 403) {
                throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $res）")
            }
            if (res == 404) continue // 清单与槽位竞态：该设备数据没了，跳过
            if (res !in 200..299) {
                throw SyncError("拉取设备 ${d.name} 失败：HTTP $res")
            }
            val db = try {
                BookStore.json.decodeFromString(DatabaseSerializer, data.decodeToString())
            } catch (_: Exception) {
                throw SyncError("设备 ${d.name} 返回的不是合法的题库数据")
            }
            val dir = File(dataDir, "devices/${d.id}")
            dir.mkdirs()
            File(dir, "data.json").writeText(data.decodeToString())
            File(dir, "device.json").writeText(
                JSONObject().put("id", d.id).put("name", d.name).put("pulledAt", System.currentTimeMillis()).toString()
            )
            payloads.add(Payload(d.id, d.name, db))
        }
        onProgress(SyncProgress(3, others.size, others.size, null))

        // 4. 下载各设备库引用到而本地缺的图片（内容哈希，共用主 assets/）
        val need = sortedSetOf<String>()
        for (p in payloads) need.addAll(collectLibraryAssets(p.db))
        var downloaded = 0
        var missing = 0
        for (key in need) {
            if (aborted) throw SyncAborted(downloaded)
            val dst = ImageStore.assetFile(dataDir, key)
            if (dst.exists()) continue // 本地已有（内容哈希一致）
            if (key !in serverAssets) {
                missing++ // 服务端清单里没有，不打 404
                continue
            }
            onProgress(SyncProgress(1, downloaded + missing, need.size, key))
            val (res, data) = request(
                "${target.server}/sync/asset/$key", "GET", authHeaders(target), connectTimeoutSec = 5,
            )
            if (res == 404) {
                missing++ // 服务端也缺：保留引用跳过（与推送口径一致）
                continue
            }
            if (res == 401 || res == 403) {
                throw SyncError("服务器拒绝：令牌无效或未授权（HTTP $res）")
            }
            if (res !in 200..299) {
                throw SyncError("下载图片 $key 失败：HTTP $res")
            }
            dst.parentFile?.mkdirs()
            dst.writeBytes(data)
            downloaded++
        }
        // 5. 以服务端清单为准：清掉本地已不在服务端的旧设备快照
        //    （远程设备栏只显示其他设备当前存在的推送；本机槽位本来就不拉取）
        run {
            val keepIds = devices.map { it.id }.toSet() + ownId
            File(dataDir, "devices").listFiles()?.forEach { d ->
                if (d.isDirectory && DeviceStore.isValidId(d.name) && d.name !in keepIds) d.deleteRecursively()
            }
        }

        onProgress(SyncProgress(2, 1, 1, null))

        DevicePullResult(
            pulled = payloads.map { PulledDevice(it.id, it.name, it.db.mistakes.size, it.db.notes.size) },
            onlySelf = others.isEmpty(),
            downloadedAssets = downloaded,
            missingAssets = missing,
        )
    }
}
