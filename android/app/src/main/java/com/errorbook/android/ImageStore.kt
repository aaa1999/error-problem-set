package com.errorbook.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.File
import java.security.MessageDigest

// MARK: - 图片入库（对应桌面端 src/lib/images.ts、iOS 端 ImageStore.swift）
// 按内容 SHA-1 哈希命名存进 assets/，重复图片只存一份；格式与桌面版完全互通。

val imageExts = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "avif")

fun extOf(name: String): String {
    val i = name.lastIndexOf('.')
    if (i < 0) return ""
    return name.substring(i + 1).lowercase()
}

object ImageStore {

    fun sha1Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-1").digest(data).joinToString("") { "%02x".format(it) }

    /** 图片统一入库；ext 不在支持列表时按 png 处理 */
    fun save(data: ByteArray, rawExt: String, dataDir: File): Block {
        val ext = if (rawExt in imageExts) rawExt else "png"
        val hash = sha1Hex(data)
        val path = File(dataDir, "assets/$hash.$ext")
        if (!path.exists()) {
            path.parentFile?.mkdirs()
            path.writeBytes(data)
        }
        return Block.Image(hash, ext)
    }

    fun assetFile(dataDir: File, hash: String, ext: String): File = File(dataDir, "assets/$hash.$ext")

    fun assetFile(dataDir: File, key: String): File = File(dataDir, "assets/$key")

    /** 从本地文件导入图片，非图片返回 null */
    fun importFile(file: File, dataDir: File): Block? {
        val ext = extOf(file.name)
        if (ext !in imageExts) return null
        return save(file.readBytes(), ext, dataDir)
    }

    /** 从 SAF Uri（相册 / 文件选择器）导入图片，非图片返回 null */
    fun importUri(context: Context, uri: Uri, dataDir: File): Block? {
        val name = queryDisplayName(context, uri) ?: uri.toString()
        val ext = extOf(name).ifEmpty { sniffImageExt(context.readBytes(uri)) ?: "" }
        if (ext !in imageExts) return null
        return save(context.readBytes(uri), ext, dataDir)
    }

    /** 相册/剪贴板来的图片数据：按魔数识别格式，识别不出或桌面端不认的格式（如 HEIC）转 JPEG 再入库 */
    fun importPhotoData(data: ByteArray, suggestedExt: String, dataDir: File): Block {
        val ext = sniffImageExt(data) ?: suggestedExt
        if (ext in imageExts) return save(data, ext, dataDir)
        // HEIC 等桌面端不认的格式：解码后统一转 JPEG
        val bmp = decodeSampled(data, 4096)
        if (bmp != null) {
            val jpg = java.io.ByteArrayOutputStream().apply { bmp.compress(Bitmap.CompressFormat.JPEG, 92, this) }.toByteArray()
            bmp.recycle()
            return save(jpg, "jpg", dataDir)
        }
        return save(data, "png", dataDir)
    }

    /** 魔数嗅探图片格式 */
    fun sniffImageExt(data: ByteArray): String? {
        if (data.size < 12) return null
        val b = data
        fun u(i: Int) = b[i].toInt() and 0xFF
        if (u(0) == 0x89 && u(1) == 0x50 && u(2) == 0x4E && u(3) == 0x47) return "png"
        if (u(0) == 0xFF && u(1) == 0xD8 && u(2) == 0xFF) return "jpg"
        if (u(0) == 0x47 && u(1) == 0x49 && u(2) == 0x46) return "gif"
        if (u(8) == 0x57 && u(9) == 0x45 && u(10) == 0x42 && u(11) == 0x50) return "webp"
        if (u(0) == 0x42 && u(1) == 0x4D) return "bmp"
        if (u(4) == 0x66 && u(5) == 0x74 && u(6) == 0x79 && u(7) == 0x70) return "avif" // ftyp 品牌（含 heic，交给调用方转换）
        return null
    }

    fun queryDisplayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}

fun Context.readBytes(uri: Uri): ByteArray =
    contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw java.io.IOException("无法读取 $uri")

/** 限制最长边的解码（防大图 OOM）；失败返回 null */
fun decodeSampled(data: ByteArray, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    var sample = 1
    while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(data, 0, data.size, opts)
}

/** 从文件路径限制最长边解码（浏览/缩略图共用） */
fun decodeSampledFile(path: File, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path.path, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeFile(path.path, opts)
}
