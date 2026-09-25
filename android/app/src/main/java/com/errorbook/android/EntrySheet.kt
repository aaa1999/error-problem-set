package com.errorbook.android

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.RemoveCircle
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.toMutableStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.DisposableEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// MARK: - 块编辑器（对应桌面端 BlockEditor、iOS 端 EntrySheet.swift 的 BlockEditor：文字段 + 图片块）

@Composable
fun BlockEditor(
    label: String,
    blocks: androidx.compose.runtime.snapshots.SnapshotStateList<Block>,
    placeholder: String = "",
    modifier: Modifier = Modifier,
) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    var importing by remember { mutableIntStateOf(0) }
    var importError by remember { mutableStateOf("") }

    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(50)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        importing += uris.size
        val dataDir = store.dataDir
        scope.launch(Dispatchers.IO) {
            for (uri in uris) {
                try {
                    val data = context.readBytes(uri)
                    val block = ImageStore.importPhotoData(data, "jpg", dataDir)
                    withContext(Dispatchers.Main) { blocks.add(block) }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) { importError = "导入失败：${e.message}" }
                    delay(3500)
                    withContext(Dispatchers.Main) { importError = "" }
                } finally {
                    withContext(Dispatchers.Main) { importing -= 1 }
                }
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = {
                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }) {
                Icon(Icons.Filled.Image, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("插入图片")
            }
            TextButton(onClick = { blocks.add(Block.Text(newId(), "")) }) {
                Icon(Icons.Filled.TextFields, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("文字段")
            }
            if (importing > 0) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        }

        if (importError.isNotEmpty()) {
            Text(importError, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }

        if (blocks.isEmpty()) {
            Text(
                if (placeholder.isEmpty()) "添加文字或图片" else placeholder,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { blocks.add(Block.Text(newId(), "")) }
                    .padding(10.dp),
            )
        }

        blocks.forEachIndexed { idx, block ->
            when (block) {
                is Block.Text -> {
                    Row(verticalAlignment = Alignment.Top) {
                        OutlinedTextField(
                            value = block.text,
                            onValueChange = { blocks[idx] = Block.Text(block.id, it) },
                            placeholder = { Text("输入文字") },
                            textStyle = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { blocks.removeAt(idx) }, modifier = Modifier.padding(top = 8.dp)) {
                            Icon(Icons.Filled.RemoveCircle, contentDescription = "删除文字段", tint = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                is Block.Image -> {
                    Column {
                        AssetImage(
                            path = ImageStore.assetFile(store.dataDir, block.hash, block.ext).path,
                        )
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                            modifier = Modifier.padding(vertical = 2.dp),
                        ) {
                            IconButton(onClick = { if (idx > 0) blocks.swap(idx, idx - 1) }, enabled = idx > 0) {
                                Icon(Icons.Filled.ArrowUpward, contentDescription = "上移")
                            }
                            IconButton(onClick = { if (idx < blocks.size - 1) blocks.swap(idx, idx + 1) }, enabled = idx < blocks.size - 1) {
                                Icon(Icons.Filled.ArrowDownward, contentDescription = "下移")
                            }
                            Spacer(Modifier.weight(1f))
                            IconButton(onClick = { blocks.removeAt(idx) }) {
                                Icon(Icons.Filled.Delete, contentDescription = "删除图片", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun <T> androidx.compose.runtime.snapshots.SnapshotStateList<T>.swap(a: Int, b: Int) {
    val t = this[a]
    this[a] = this[b]
    this[b] = t
}

// MARK: - 录入/编辑错题（对应桌面端 EntryView、iOS 端 EntrySheet）

@Composable
fun EntrySheetOverlay(
    editing: Mistake?,
    presetFolders: List<String> = emptyList(),
    presetTags: List<String> = emptyList(),
    onDismiss: () -> Unit,
) {
    val store = LocalBookStore.current
    val context = LocalContext.current

    // 录入记忆：勾「记住标签与文件夹」保存后，下次从任何入口录入自动带上（显式预设优先）
    val prefs = remember { Prefs.get(context) }
    var remember_ by remember { mutableStateOf(false) }

    val qBlocks = remember { mutableStateListOf<Block>() }
    val aBlocks = remember { mutableStateListOf<Block>() }
    val tags = remember { mutableStateListOf<String>() }
    val folderIds = remember { mutableStateListOf<String>() }
    // 选择题选项（选填）：填了并在浏览时作答才会统计错误率
    val options = remember { mutableStateListOf<String>() }
    var answer by remember { mutableStateOf<Int?>(null) }
    var flash by remember { mutableStateOf("") }
    androidx.activity.compose.BackHandler(onBack = { onDismiss() })
    var initialized by remember { mutableStateOf(false) }

    val valid = !isBlocksEmpty(qBlocks)
    val trimmedOptions = options.map { it.trim() }.filter { it.isNotEmpty() }
    val optionsReady = trimmedOptions.isEmpty() || answer != null

    fun build(): Mistake = Mistake(
        id = editing?.id ?: newId(),
        folderIds = folderIds.toList(),
        options = trimmedOptions,
        answer = if (trimmedOptions.isEmpty()) null else answer,
        attempts = editing?.attempts ?: 0, // 作答统计随编辑保留，只增不减
        wrong = editing?.wrong ?: 0,
        question = qBlocks.toList(),
        analysis = aBlocks.toList(),
        tags = tags.toList(),
        createdAt = editing?.createdAt ?: nowMs(),
        updatedAt = nowMs(),
    )

    /// 新录时按「记住」开关落记忆：勾 = 存当前文件夹+标签；不勾 = 清掉旧记忆
    fun persistMemory() {
        if (editing != null) return
        prefs.edit().apply {
            if (remember_) {
                putString("entryMemoryFolders", folderIds.joinToString("\n"))
                putString("entryMemoryTags", tags.joinToString("\n"))
                putBoolean("entryMemoryOn", true)
            } else {
                putString("entryMemoryFolders", "")
                putString("entryMemoryTags", "")
                putBoolean("entryMemoryOn", false)
            }
            apply()
        }
    }

    fun saveAndNext() {
        if (!valid) return
        if (!optionsReady) {
            flash = "已填选项：请点 A / B / C / D 选中正确答案，或清空选项"
            return
        }
        store.addMistake(build())
        persistMemory()
        qBlocks.clear(); qBlocks.add(Block.Text(newId(), ""))
        aBlocks.clear(); aBlocks.add(Block.Text(newId(), ""))
        options.clear(); repeat(4) { options.add("") } // 选项恢复为空白 A–D，下一题从新开始
        answer = null
        flash = "已保存 ✓，继续录入下一题"
    }

    fun saveAndDone() {
        if (!valid || !optionsReady) return
        if (editing != null) store.updateMistake(build()) else {
            store.addMistake(build())
            persistMemory()
        }
        onDismiss()
    }

    // 初始化（编辑带出 / 新题空白 A–D + 记忆）
    LaunchedEffect(Unit) {
        if (initialized) return@LaunchedEffect
        initialized = true
        val e = editing
        if (e != null) {
            qBlocks.addAll(e.question)
            aBlocks.addAll(e.analysis)
            tags.addAll(e.tags)
            folderIds.addAll(e.folderIds)
            if (e.options.isEmpty()) repeat(4) { options.add("") } else options.addAll(e.options)
            answer = e.answer
        } else {
            qBlocks.add(Block.Text(newId(), ""))
            aBlocks.add(Block.Text(newId(), ""))
            repeat(4) { options.add("") } // 默认摆出 A–D 四个空框，留空保存即非选择题
            val memoryOn = prefs.getBoolean("entryMemoryOn", false)
            val memFolders = prefs.getString("entryMemoryFolders", "")!!.split("\n").filter { it.isNotEmpty() }
            val memTags = prefs.getString("entryMemoryTags", "")!!.split("\n").filter { it.isNotEmpty() }
            if (presetFolders.isNotEmpty()) folderIds.addAll(presetFolders) else if (memoryOn) folderIds.addAll(memFolders)
            if (presetTags.isNotEmpty()) tags.addAll(presetTags) else if (memoryOn) tags.addAll(memTags)
            remember_ = memoryOn
        }
    }

    // 编辑已有错题：停止输入 900ms 后自动保存，防止忘点保存丢内容
    val signature = listOf(qBlocks.toList(), aBlocks.toList(), tags.toList(), folderIds.toList(), options.toList(), answer)
    LaunchedEffect(signature, initialized) {
        if (!initialized || editing == null) return@LaunchedEffect
        delay(900)
        if (!isBlocksEmpty(qBlocks) && (options.map { it.trim() }.filter { it.isNotEmpty() }.isEmpty() || answer != null)) {
            store.updateMistake(build())
        }
    }
    // 离开兜底保存（新题只认显式保存）
    DisposableEffect(Unit) {
        onDispose {
            if (editing != null && !isBlocksEmpty(qBlocks)) {
                val opts = options.map { it.trim() }.filter { it.isNotEmpty() }
                if (opts.isEmpty() || answer != null) {
                    store.updateMistake(build())
                }
            }
        }
    }

    LaunchedEffect(flash) {
        if (flash.isNotEmpty()) {
            delay(1800)
            flash = ""
        }
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().imePadding()) {
            // 顶栏
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            ) {
                TextButton(onClick = onDismiss) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (editing != null) "返回" else "取消")
                }
                Text(
                    when {
                        editing != null -> "编辑错题"
                        presetFolders.isNotEmpty() -> "文件夹录入"
                        presetTags.isNotEmpty() -> "标签录入"
                        else -> "录入错题"
                    },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                if (editing != null) {
                    TextButton(onClick = { saveAndDone() }, enabled = valid && optionsReady) { Text("保存", fontWeight = FontWeight.Bold) }
                } else {
                    var menuOpen by remember { mutableStateOf(false) }
                    Box {
                        Button(onClick = { menuOpen = true }, enabled = valid) { Text("保存", fontWeight = FontWeight.Bold) }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("保存并录入下一题") }, onClick = { menuOpen = false; saveAndNext() })
                            DropdownMenuItem(text = { Text("保存并去浏览") }, onClick = { menuOpen = false; saveAndDone() })
                        }
                    }
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FolderMultiPicker(folders = store.db.value.folders, value = folderIds)
                    Spacer(Modifier.weight(1f))
                }
                TagInput(tags = tags, suggestions = store.allTags)
                if (editing == null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(checked = remember_, onCheckedChange = { remember_ = it }, modifier = Modifier.height(24.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("记住标签与文件夹（下次录入自动带上）", style = MaterialTheme.typography.labelSmall)
                    }
                }
                BlockEditor(label = "题目", blocks = qBlocks, placeholder = "输入题目文字，或插入截图")
                OptionsEditor(options = options, answer = answer, onAnswer = { answer = it })
                BlockEditor(label = "解析", blocks = aBlocks, placeholder = "输入解析文字，或插入解析截图")
                if (flash.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Check, contentDescription = null, tint = androidx.compose.ui.graphics.Color(0xFF2E7D32), modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(flash, style = MaterialTheme.typography.bodySmall, color = androidx.compose.ui.graphics.Color(0xFF2E7D32))
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

// MARK: 选择题选项编辑器（选填，填了并标记正确答案，浏览时即可作答计错误率）

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun OptionsEditor(
    options: androidx.compose.runtime.snapshots.SnapshotStateList<String>,
    answer: Int?,
    onAnswer: (Int?) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("选项", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (options.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                Text(
                    "点 A / B / C / D 选中正确答案；全留空 = 非选择题",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            Spacer(Modifier.weight(1f))
            if (options.size < 8) {
                OutlinedButton(onClick = { options.add("") }) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("添加选项")
                }
            }
            if (options.isNotEmpty()) {
                OutlinedButton(onClick = {
                    options.clear()
                    repeat(4) { options.add("") }
                    onAnswer(null)
                }) {
                    Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("清空")
                }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEachIndexed { i, opt ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // A/B/C/D 字母徽章：点击即选中为正确答案（实心高亮）
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(26.dp)
                            .clip(CircleShape)
                            .background(if (answer == i) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                            .clickable { onAnswer(i) },
                    ) {
                        Text(
                            "${'A' + i}",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = if (answer == i) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    OutlinedTextField(
                        value = opt,
                        onValueChange = { options[i] = it },
                        textStyle = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.width(150.dp),
                    )
                    IconButton(onClick = {
                        options.removeAt(i)
                        when {
                            answer == i -> onAnswer(null)
                            answer != null && answer > i -> onAnswer(answer!! - 1)
                        }
                    }) {
                        Icon(Icons.Filled.RemoveCircle, contentDescription = "删除选项", tint = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
    }
}
