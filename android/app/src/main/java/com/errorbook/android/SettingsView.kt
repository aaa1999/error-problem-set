package com.errorbook.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// MARK: - 设置：数据目录、合并导入、同步、文件夹管理、关于

@Composable
fun SettingsView(onOpenSync: () -> Unit) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val db by store.db.collectAsState()

    var plan by remember { mutableStateOf<MergePlan?>(null) }
    var planSource by remember { mutableStateOf<TreeSource?>(null) }
    var merging by remember { mutableStateOf(false) }
    var mergeProgress by remember { mutableStateOf(0 to 0) }
    var mergeResult by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf("") }
    var folderManageOpen by remember { mutableStateOf(false) }

    val mergePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        errorMessage = ""
        mergeResult = ""
        scope.launch(Dispatchers.IO) {
            try {
                context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
            try {
                val (source, p) = buildMergePlan(context, uri, store.db.value)
                withContext(Dispatchers.Main) {
                    planSource = source
                    plan = p
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { errorMessage = e.message ?: "读取失败" }
            }
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text("设置", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

            // 数据
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("数据", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SettingRow("错题", "${db.mistakes.size} 道")
                SettingRow("笔记", "${db.notes.size} 篇")
                SettingRow("文件夹", "${db.folders.size} 个")
                Column {
                    Text("数据目录", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        store.dataDir.path,
                        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    "数据保存在本机 App 的「错题本」文件夹（data.json + assets 图片），USB 连电脑（MTP 文件传输）可见，可直接与桌面版互拷整目录；或用下方「合并导入」选「文件」里的数据目录。删除操作有备份，旧版本在 snapshots/ 里保留最近 20 份。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            HorizontalDivider()

            // 合并导入
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("合并导入", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = { mergePicker.launch(null) }, enabled = !merging) {
                    Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("从数据目录合并导入…")
                }
                val p = plan
                if (p != null && !merging) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                            .padding(10.dp),
                    ) {
                        Text("源：${p.sourceName ?: "远程"}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                        Text(
                            "${p.source.mistakes.size} 道错题、${p.source.notes.size} 篇笔记、${p.source.folders.size} 个文件夹：将导入 ${p.newMistakes.size} 道错题、${p.newNotes.size} 篇笔记（含 ${p.imageCount} 张图片）" +
                                (if (p.newTags.isEmpty()) "" else "、${p.newTags.size} 个标签") +
                                "，跳过已存在 ${p.skipped} 道、${p.skippedNotes} 篇。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { plan = null }) { Text("取消") }
                            Button(onClick = {
                                val src = planSource ?: return@Button
                                val current = p
                                merging = true
                                mergeProgress = 0 to (current.newMistakes.size + current.newNotes.size + current.imageCount)
                                errorMessage = ""
                                scope.launch {
                                    try {
                                        val text = runMerge(current, store, src) { done, total ->
                                            mergeProgress = done to total
                                        }
                                        mergeResult = text
                                        plan = null
                                    } catch (e: Exception) {
                                        errorMessage = "合并中断：${e.message}（可重新执行，已导入的会自动跳过）"
                                    }
                                    merging = false
                                }
                            }) { Text("开始合并") }
                        }
                    }
                }
                if (merging) {
                    LinearProgressIndicator(
                        progress = { mergeProgress.first / maxOf(mergeProgress.second, 1).toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text("${mergeProgress.first} / ${mergeProgress.second}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (mergeResult.isNotEmpty()) {
                    Text(mergeResult, style = MaterialTheme.typography.labelSmall, color = Color(0xFF2E7D32))
                }
                if (errorMessage.isNotEmpty()) {
                    Text(errorMessage, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
                Text(
                    "把桌面端（或其他设备）的数据文件夹拷到本机后选择它：题目、文件夹、标签整体合并进来。选到上一级也能识别（向下扫两层）；已导入过的自动跳过，可重复执行。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            HorizontalDivider()

            // 同步
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("同步", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onOpenSync() }
                        .padding(vertical = 10.dp),
                ) {
                    Icon(Icons.Filled.CloudUpload, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("同步（推送 / 按设备拉取）", modifier = Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                SyncStore.load(context)?.let { t ->
                    SettingRow("已记住", t.server)
                }
            }

            HorizontalDivider()

            // 整理
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("整理", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { folderManageOpen = true }
                        .padding(vertical = 10.dp),
                ) {
                    Icon(Icons.Filled.CreateNewFolder, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("文件夹管理", modifier = Modifier.weight(1f))
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    "新建/重命名/删除文件夹；删除文件夹时其中错题移到未分类，子文件夹上移一级。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            HorizontalDivider()

            // 关于
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("关于", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SettingRow("版本", "0.8.2 (Android)")
                SettingRow("桌面端 / iOS 端", "数据格式完全互通")
                Text(
                    "Word 富文本笔记在安卓端为只读（可导出），编辑请用桌面端。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    if (folderManageOpen) {
        FolderManageView(onDone = { folderManageOpen = false })
    }
}

@Composable
private fun SettingRow(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(90.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// MARK: - 文件夹管理（对应桌面端 Sidebar 的文件夹树管理、iOS 端 FolderManageView）

@Composable
private fun FolderManageView(onDone: () -> Unit) {
    val store = LocalBookStore.current
    val db by store.db.collectAsState()

    var newName by remember { mutableStateOf("") }
    androidx.activity.compose.BackHandler(onBack = { onDone() })
    var newParent by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Folder?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<Folder?>(null) }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onDone) {
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurface)
                }
                Text("文件夹管理", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = onDone) { Text("完成") }
            }

            Text("新建文件夹", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("上级文件夹 ", style = MaterialTheme.typography.bodySmall)
                var parentMenu by remember { mutableStateOf(false) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { parentMenu = true }
                        .padding(vertical = 4.dp),
                ) {
                    Text(folderPathName(db.folders, newParent), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    Text(" ▾", style = MaterialTheme.typography.labelSmall)
                }
                DropdownMenu(expanded = parentMenu, onDismissRequest = { parentMenu = false }) {
                    DropdownMenuItem(
                        text = { Text("（根层级）") },
                        onClick = { newParent = null; parentMenu = false },
                    )
                    flatFolders(db.folders).forEach { item ->
                        DropdownMenuItem(
                            text = { Text("　".repeat(item.depth) + item.folder.name) },
                            onClick = { newParent = item.folder.id; parentMenu = false },
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    placeholder = { Text("新文件夹名称") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Button(onClick = {
                    val n = newName.trim()
                    if (n.isEmpty()) return@Button
                    store.createFolder(n, newParent)
                    newName = ""
                }) { Text("创建") }
            }

            HorizontalDivider()

            Text("已有文件夹", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val flats = flatFolders(db.folders)
            if (flats.isEmpty()) {
                Text("还没有文件夹", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            flats.forEach { item ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(vertical = 4.dp),
                ) {
                    Text("　".repeat(item.depth) + item.folder.name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text(
                        "${countInFolder(db.mistakes, db.folders, item.folder.id)} 题",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                    IconButton(onClick = {
                        renameDraft = item.folder.name
                        renaming = item.folder
                    }) {
                        Icon(Icons.Filled.Edit, contentDescription = "重命名", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    IconButton(onClick = { deleting = item.folder }) {
                        Icon(Icons.Filled.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (renaming != null) {
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("重命名文件夹") },
            text = {
                OutlinedTextField(
                    value = renameDraft,
                    onValueChange = { renameDraft = it },
                    placeholder = { Text("名称") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    renaming?.let { store.renameFolder(it.id, renameDraft) }
                    renaming = null
                }) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("取消") } },
        )
    }

    if (deleting != null) {
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除文件夹「${deleting?.name ?: ""}」？") },
            text = { Text("其中错题移到未分类，子文件夹上移一级") },
            confirmButton = {
                TextButton(onClick = {
                    deleting?.let { store.deleteFolder(it.id) }
                    deleting = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
        )
    }
}
