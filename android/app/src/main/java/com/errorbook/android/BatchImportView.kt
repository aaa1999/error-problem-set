package com.errorbook.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Image
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// MARK: - 批量导入（对应桌面端 BatchImportView、iOS 端 BatchImportView.swift）
// 相册多选 + 「文件」里选文件夹（SAF 递归扫描子目录）；每张图可设为 题目图 / 解析图 / 跳过。

enum class BatchMode { QUESTION, ANALYSIS, SKIP }

data class BatchRow(
    val name: String,
    val relDir: String,
    val mode: BatchMode = BatchMode.QUESTION,
    val source: Source,
) {
    val id: String = newId()
}

sealed class Source {
    class Bytes(val data: ByteArray) : Source()
    class Doc(val uri: Uri) : Source()
}

@Composable
fun BatchImportOverlay(onClose: () -> Unit) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val rows = remember { mutableStateListOf<BatchRow>() }
    androidx.activity.compose.BackHandler(onBack = onClose)
    val tags = remember { mutableStateListOf<String>() }
    var rootFolderId by remember { mutableStateOf<String?>(null) }
    var mirrorStructure by remember { mutableStateOf(true) }
    var scanning by remember { mutableStateOf(false) }
    var importing by remember { mutableStateOf(false) }
    var progress by remember { mutableIntStateOf(0) }
    var doneInfo by remember { mutableStateOf<Pair<Int, Int>?>(null) } // questions, analyses
    var errorMessage by remember { mutableStateOf("") }

    val hasSubDirs = rows.any { it.relDir.isNotEmpty() }

    val groups = remember(rows.toList()) {
        val order = mutableListOf<String>()
        val map = LinkedHashMap<String, MutableList<BatchRow>>()
        for (r in rows) {
            if (!map.containsKey(r.relDir)) order.add(r.relDir)
            map.getOrPut(r.relDir) { mutableListOf() }.add(r)
        }
        order.map { it to map[it]!! }
    }

    val counts = remember(rows.toList()) {
        Triple(
            rows.count { it.mode == BatchMode.QUESTION },
            rows.count { it.mode == BatchMode.ANALYSIS },
            rows.count { it.mode == BatchMode.SKIP },
        )
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(50)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scanning = true
        scope.launch(Dispatchers.IO) {
            val out = mutableListOf<BatchRow>()
            for (uri in uris) {
                try {
                    val name = (ImageStore.queryDisplayName(context, uri) ?: "${newId()}.jpg")
                    val data = context.readBytes(uri)
                    out.add(BatchRow(name = name, relDir = "", source = Source.Bytes(data)))
                } catch (_: Exception) {
                }
            }
            out.sortWith { a, b -> if (naturalLess(a.name, b.name)) -1 else if (naturalLess(b.name, a.name)) 1 else 0 }
            withContext(Dispatchers.Main) {
                rows.clear()
                rows.addAll(out)
                scanning = false
                if (out.isEmpty()) errorMessage = "没有读取到图片"
            }
        }
    }

    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        errorMessage = ""
        scanning = true
        scope.launch(Dispatchers.IO) {
            try {
                context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
            val out = mutableListOf<BatchRow>()
            val root = DocumentFile.fromTreeUri(context, uri)
            fun walk(dir: DocumentFile, rel: String) {
                val children = dir.listFiles().sortedWith { a, b ->
                    val an = a.name ?: ""
                    val bn = b.name ?: ""
                    if (naturalLess(an, bn)) -1 else if (naturalLess(bn, an)) 1 else 0
                }
                for (child in children) {
                    val cname = child.name ?: continue
                    if (child.isDirectory) {
                        if (cname.startsWith(".")) continue
                        walk(child, if (rel.isEmpty()) cname else "$rel/$cname")
                    } else if (extOf(cname) in imageExts) {
                        out.add(BatchRow(name = cname, relDir = rel, source = Source.Doc(child.uri)))
                    }
                }
            }
            if (root != null) walk(root, "")
            withContext(Dispatchers.Main) {
                if (out.isEmpty()) {
                    errorMessage = "该文件夹（含子文件夹）里没有图片（支持 png/jpg/jpeg/webp/gif/bmp/avif）"
                    rows.clear()
                } else {
                    out.sortWith { a, b ->
                        if (a.relDir != b.relDir) {
                            if (naturalLess(a.relDir, b.relDir)) -1 else if (naturalLess(b.relDir, a.relDir)) 1 else 0
                        } else if (naturalLess(a.name, b.name)) -1 else if (naturalLess(b.name, a.name)) 1 else 0
                    }
                    rows.clear()
                    rows.addAll(out)
                }
                scanning = false
            }
        }
    }

    fun runImport() {
        if (importing) return
        importing = true
        progress = 0
        errorMessage = ""
        scope.launch {
            var questions = 0
            var analyses = 0
            var currentId: String? = null
            val folderCache = mutableMapOf<String, String?>()
            try {
                for (row in rows) {
                    try {
                        if (row.mode == BatchMode.SKIP) continue
                        val img: Block = withContext(Dispatchers.IO) {
                            when (val src = row.source) {
                                is Source.Bytes -> ImageStore.importPhotoData(src.data, "jpg", store.dataDir)
                                is Source.Doc -> ImageStore.importUri(context, src.uri, store.dataDir)
                                    ?: throw java.io.IOException("读取图片失败：${row.name}")
                            }
                        }
                        if (row.mode == BatchMode.ANALYSIS && currentId != null) {
                            val target = store.mistake(currentId!!)
                            if (target != null) {
                                store.updateMistake(
                                    target.copy(
                                        analysis = target.analysis + img,
                                        tags = (target.tags + tags).distinct().sorted(),
                                        updatedAt = nowMs(),
                                    )
                                )
                                analyses++
                            }
                        } else {
                            var folderId: String?
                            if (folderCache.containsKey(row.relDir)) {
                                folderId = folderCache[row.relDir]
                            } else if (mirrorStructure && row.relDir.isNotEmpty()) {
                                var parent = rootFolderId
                                for (seg in row.relDir.split("/")) {
                                    parent = store.findOrCreateFolder(seg, parent).id
                                }
                                folderId = parent
                                folderCache[row.relDir] = parent
                            } else {
                                folderId = rootFolderId
                                folderCache[row.relDir] = rootFolderId
                            }
                            val m = Mistake(
                                folderIds = folderId?.let { listOf(it) } ?: emptyList(),
                                question = listOf(img),
                                analysis = emptyList(),
                                tags = tags.toList(),
                            )
                            store.addMistake(m)
                            currentId = m.id
                            questions++
                        }
                    } finally {
                        progress += 1
                    }
                }
                doneInfo = questions to analyses
                rows.clear()
            } catch (e: Exception) {
                errorMessage = "导入中断：${e.message}（已导入的部分已保存）"
            }
            importing = false
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 顶栏
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            ) {
                TextButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (rows.isEmpty()) "关闭" else "取消")
                }
                Text("批量导入", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (rows.isNotEmpty() && !importing) {
                    Button(onClick = { runImport() }, enabled = counts.first > 0) { Text("导入 ${counts.first} 题") }
                }
            }

            val done = doneInfo
            when {
                done != null -> {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color(0xFF2E7D32), modifier = Modifier.size(72.dp))
                        Spacer(Modifier.height(12.dp))
                        Text("导入完成", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "新增 ${done.first} 道错题，附加 ${done.second} 张解析图。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(16.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = {
                                rows.clear()
                                doneInfo = null
                            }) { Text("再导一批") }
                            Button(onClick = onClose) { Text("去浏览") }
                        }
                    }
                }
                rows.isEmpty() -> {
                    // ① 选择来源
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Spacer(Modifier.height(24.dp))
                        Icon(Icons.Filled.PhotoLibrary, contentDescription = null, tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f), modifier = Modifier.size(72.dp))
                        Spacer(Modifier.height(12.dp))
                        Text("批量导入截图", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "从相册多选截图，或选择「文件」里的截图文件夹（连同子文件夹一起扫描）。默认每张图新开一道错题。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        Spacer(Modifier.height(20.dp))
                        Button(
                            onClick = {
                                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Filled.PhotoLibrary, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("从相册选择（可多选）")
                        }
                        Spacer(Modifier.height(8.dp))
                        OutlinedButton(
                            onClick = { folderPicker.launch(null) },
                            enabled = !scanning,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("选择文件夹（含子文件夹）")
                        }
                        if (scanning) {
                            Spacer(Modifier.height(12.dp))
                            CircularProgressIndicator(strokeWidth = 3.dp)
                            Text("扫描中…", style = MaterialTheme.typography.labelSmall)
                        }
                        if (errorMessage.isNotEmpty()) {
                            Spacer(Modifier.height(12.dp))
                            Text(
                                errorMessage,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                            )
                        }
                    }
                }
                else -> {
                    // ② 确认每张图身份 + ③ 目标位置
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "③ 目标位置与标签",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("导入到 ", style = MaterialTheme.typography.bodyMedium)
                            FolderPickerMenu(folders = store.db.value.folders, value = rootFolderId, onPick = { rootFolderId = it })
                        }
                        if (hasSubDirs) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("按源文件夹结构自动创建子文件夹", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                Switch(checked = mirrorStructure, onCheckedChange = { mirrorStructure = it })
                            }
                        }
                        TagInput(tags = tags, suggestions = store.allTags)
                        Text(
                            "来自 ${groups.size} 个文件夹，将新增 ${counts.first} 道错题（含 ${counts.second} 张解析图，跳过 ${counts.third} 张）",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        groups.forEach { (relDir, groupRows) ->
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Spacer(Modifier.width(4.dp))
                                    Text(
                                        if (relDir.isEmpty()) "（根目录）" else relDir,
                                        style = MaterialTheme.typography.labelMedium,
                                        fontWeight = FontWeight.Bold,
                                    )
                                }
                                if (relDir.isNotEmpty() && mirrorStructure) {
                                    Text(
                                        "将创建子文件夹：${relDir.replace("/", " / ")}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                groupRows.forEach { row ->
                                    BatchRowView(
                                        row = row,
                                        canAnalysis = anchorAvailable(rows, row),
                                        importing = importing,
                                    ) { mode ->
                                        val i = rows.indexOfFirst { it.id == row.id }
                                        if (i >= 0) {
                                            rows[i] = row.copy(mode = mode)
                                        }
                                    }
                                }
                            }
                        }

                        if (importing) {
                            LinearProgressIndicator(
                                progress = { progress / maxOf(rows.size, 1).toFloat() },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text("$progress / ${rows.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (errorMessage.isNotEmpty()) {
                            Text(errorMessage, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                        Spacer(Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}

/// 第某行设为「解析图」需要前面（同分组）存在一道题目图
private fun anchorAvailable(rows: List<BatchRow>, row: BatchRow): Boolean {
    var seen = false
    for (r in rows) {
        if (r.id == row.id) return seen
        if (r.mode == BatchMode.QUESTION && r.relDir == row.relDir) seen = true
    }
    return false
}

@Composable
private fun BatchRowView(
    row: BatchRow,
    canAnalysis: Boolean,
    importing: Boolean,
    onMode: (BatchMode) -> Unit,
) {
    val context = LocalContext.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        RowThumb(source = row.source, name = row.name)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = row.mode == BatchMode.QUESTION,
                    onClick = { if (!importing) onMode(BatchMode.QUESTION) },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 3),
                ) {
                    Text("题目图", style = MaterialTheme.typography.labelSmall)
                }
                SegmentedButton(
                    selected = row.mode == BatchMode.ANALYSIS,
                    onClick = { if (!importing && canAnalysis) onMode(BatchMode.ANALYSIS) },
                    enabled = canAnalysis && !importing,
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 3),
                ) {
                    Text("解析图 ↩", style = MaterialTheme.typography.labelSmall)
                }
                SegmentedButton(
                    selected = row.mode == BatchMode.SKIP,
                    onClick = { if (!importing) onMode(BatchMode.SKIP) },
                    shape = SegmentedButtonDefaults.itemShape(index = 2, count = 3),
                ) {
                    Text("跳过", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun RowThumb(source: Source, name: String) {
    var bmp by remember(name) { mutableStateOf<Bitmap?>(null) }
    val context = LocalContext.current
    LaunchedEffect(source, name) {
        bmp = withContext(Dispatchers.IO) {
            try {
                when (source) {
                    is Source.Bytes -> decodeSampled(source.data, 128)
                    is Source.Doc -> {
                        val bytes = context.readBytes(source.uri)
                        decodeSampled(bytes, 128)
                    }
                }
            } catch (_: Exception) {
                null
            }
        }
    }
    if (bmp != null) {
        Image(
            bitmap = bmp!!.asImageBitmap(),
            contentDescription = null,
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(6.dp)),
        )
    } else {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        )
    }
}
