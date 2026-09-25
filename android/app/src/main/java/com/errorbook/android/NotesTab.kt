package com.errorbook.android

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// MARK: - 笔记列表（对应桌面端 NotesView、iOS 端 NotesTab）

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesTab() {
    val store = LocalBookStore.current
    val db by store.db.collectAsState()
    var query by remember { mutableStateOf("") }
    var editorNoteId by remember { mutableStateOf<String?>(null) }

    val notes = remember(db, query) {
        val q = query.trim().lowercase()
        db.notes
            .filter { n -> q.isEmpty() || n.title.lowercase().contains(q) || n.content.lowercase().contains(q) }
            .sortedByDescending { it.updatedAt }
    }

    editorNoteId?.let { id ->
        NoteEditorView(noteId = id, onDismiss = { editorNoteId = null })
        return
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text("笔记", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                IconButton(onClick = {
                    val n = Note(title = "", format = NoteFormat.MARKDOWN, content = "")
                    store.addNote(n)
                    // 直接进入新建的笔记（内容为空切走会自动丢弃）
                    editorNoteId = n.id
                }) {
                    Icon(Icons.Filled.Edit, contentDescription = "新建笔记")
                }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("搜索笔记…") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp),
            )
            if (db.notes.isEmpty()) {
                EmptyState(
                    icon = Icons.AutoMirrored.Filled.Notes,
                    title = "笔记",
                    message = "Markdown 笔记（即时预览、可插入图片），均支持导出 PDF / Word。\nWord 富文本笔记可查看，编辑请用桌面端。",
                )
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(notes, key = { it.id }) { n ->
                        val dismissState = rememberSwipeToDismissBoxState(
                            confirmValueChange = { v ->
                                if (v == SwipeToDismissBoxValue.EndToStart) {
                                    store.deleteNote(n.id)
                                    true
                                } else {
                                    false
                                }
                            },
                        )
                        SwipeToDismissBox(
                            state = dismissState,
                            enableDismissFromStartToEnd = false,
                            backgroundContent = {
                                Box(
                                    contentAlignment = Alignment.CenterEnd,
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(MaterialTheme.colorScheme.errorContainer)
                                        .padding(end = 20.dp),
                                ) {
                                    Icon(Icons.Filled.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.onErrorContainer)
                                }
                            },
                        ) {
                            NoteRowLabel(note = n) { editorNoteId = n.id }
                        }
                    }
                }
            }
        }
    }
}

/** 笔记列表行 */
@Composable
private fun NoteRowLabel(note: Note, onOpen: () -> Unit) {
    val badgeColor = if (note.format == NoteFormat.WORD) Color(0xFF1976D2) else Color(0xFF7B1FA2)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onOpen() }
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (note.format == NoteFormat.WORD) "Word" else "MD",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = badgeColor,
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(badgeColor.copy(alpha = 0.14f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                note.title.trim().ifEmpty { "无标题" },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                formatTime(note.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        val excerpt = noteExcerpt(note)
        if (excerpt.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Text(
                excerpt,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// MARK: - 笔记编辑器（对应桌面端 NoteEditor + MarkdownEditor/WordEditor）

@Composable
fun NoteEditorView(noteId: String, onDismiss: () -> Unit) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var title by remember { mutableStateOf("") }
    var tfv by remember { mutableStateOf(TextFieldValue("")) }
    var exportError by remember { mutableStateOf("") }
    androidx.activity.compose.BackHandler(onBack = { onDismiss() })
    var confirmDelete by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }

    val db by store.db.collectAsState()
    val note = db.notes.firstOrNull { it.id == noteId }
    val format = note?.format ?: NoteFormat.MARKDOWN
    // Word 富文本为只读预览；markdown 默认编辑态
    var previewMode by remember { mutableStateOf(format == NoteFormat.WORD) }

    val previewHtml = remember(tfv.text, title, format) {
        val content = tfv.text
        fun mapRef(ref: String): String {
            val f = java.io.File(store.dataDir, ref)
            if (!f.exists()) return ""
            val ext = extOf(ref)
            return "data:image/${if (ext == "jpg") "jpeg" else ext};base64," +
                android.util.Base64.encodeToString(f.readBytes(), android.util.Base64.NO_WRAP)
        }
        when (format) {
            NoteFormat.MARKDOWN -> Markdown.render(content) { ref -> mapRef(ref) }
            NoteFormat.WORD -> sanitizeLite(Markdown.mapAssetsInHtml(content) { ref -> mapRef(ref) })
        }
    }

    fun saveNow() {
        val n = store.db.value.notes.firstOrNull { it.id == noteId } ?: return
        store.updateNote(n.copy(title = title, content = tfv.text, updatedAt = nowMs()))
    }

    LaunchedEffect(Unit) {
        if (loaded) return@LaunchedEffect
        loaded = true
        val n = store.db.value.notes.firstOrNull { it.id == noteId }
        if (n != null) {
            title = n.title
            tfv = TextFieldValue(n.content)
        }
    }

    // 自动保存：停止输入 800ms 落盘
    LaunchedEffect(title, tfv.text, loaded) {
        if (!loaded) return@LaunchedEffect
        delay(800)
        if (!isNoteEmpty(title, tfv.text, format)) saveNow()
    }
    // 离开时：没内容就丢弃（新建后没写直接返回），否则补存
    DisposableEffect(noteId) {
        onDispose {
            if (isNoteEmpty(title, tfv.text, format)) {
                store.deleteNote(noteId)
            } else {
                saveNow()
            }
        }
    }

    LaunchedEffect(exportError) {
        if (exportError.isNotEmpty()) {
            delay(2500)
            exportError = ""
        }
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch(Dispatchers.IO) {
            try {
                val data = context.readBytes(uri)
                val block = ImageStore.importPhotoData(data, "jpg", store.dataDir)
                if (block is Block.Image) {
                    val ref = "![](assets/${block.hash}.${block.ext})\n"
                    withContext(Dispatchers.Main) {
                        tfv = TextFieldValue(
                            tfv.text + (if (tfv.text.isEmpty() || tfv.text.endsWith("\n")) ref else "\n$ref"),
                            TextRange(tfv.text.length + 1),
                        )
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { exportError = "图片插入失败：${e.message}" }
            }
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
                    Text("返回")
                }
                Spacer(Modifier.weight(1f))
                var menuOpen by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "导出")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("导出 PDF（打印/另存）") },
                            onClick = {
                                menuOpen = false
                                val activity = context as? Activity
                                val n = Note(id = noteId, title = title, format = format, content = tfv.text)
                                if (activity != null) {
                                    // WebView 创建/挂载必须在主线程
                                    scope.launch(Dispatchers.Main) {
                                        NoteExporter.exportPdf(activity, n, store.dataDir)
                                    }
                                } else {
                                    exportError = "导出失败：无法获取当前窗口"
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("导出 Word（.doc）") },
                            onClick = {
                                menuOpen = false
                                scope.launch(Dispatchers.IO) {
                                    try {
                                        val n = Note(id = noteId, title = title, format = format, content = tfv.text)
                                        val outDir = java.io.File(context.cacheDir, "exports").apply { mkdirs() }
                                        val file = NoteExporter.exportDoc(n, store.dataDir, outDir)
                                        withContext(Dispatchers.Main) {
                                            NoteExporter.shareFile(context, file, "application/msword")
                                        }
                                    } catch (e: Exception) {
                                        withContext(Dispatchers.Main) { exportError = "导出失败：${e.message}" }
                                    }
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("删除笔记", color = MaterialTheme.colorScheme.error) },
                            leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                            onClick = { menuOpen = false; confirmDelete = true },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                placeholder = { Text("标题") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp),
            )

            if (format == NoteFormat.MARKDOWN) {
                SingleChoiceSegmentedButtonRow(
                    modifier = Modifier
                        .padding(horizontal = 12.dp, vertical = 6.dp)
                        .width(180.dp),
                ) {
                    SegmentedButton(
                        selected = !previewMode,
                        onClick = { previewMode = false },
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    ) { Text("编辑") }
                    SegmentedButton(
                        selected = previewMode,
                        onClick = { previewMode = true },
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    ) { Text("预览") }
                }
            } else {
                Text(
                    "Word 富文本为只读预览，编辑请用桌面端",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }

            if (format == NoteFormat.MARKDOWN && !previewMode) {
                Column(modifier = Modifier.weight(1f)) {
                    MarkdownToolbar(
                        onWrap = { prefix, suffix, ph -> tfv = wrapSelection(tfv, prefix, suffix, ph) },
                        onLinePrefix = { prefix -> tfv = prefixLines(tfv, prefix) },
                        onPhoto = {
                            photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                    )
                    Box(modifier = Modifier.weight(1f)) {
                        BasicTextField(
                            value = tfv,
                            onValueChange = { tfv = it },
                            textStyle = TextStyle(fontSize = MaterialTheme.typography.bodyLarge.fontSize, color = MaterialTheme.colorScheme.onSurface),
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
            } else {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState()),
                ) {
                    HtmlPreview(html = previewHtml)
                }
            }

            if (exportError.isNotEmpty()) {
                Text(
                    exportError,
                    style = MaterialTheme.typography.labelSmall,
                    color = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.error)
                        .padding(10.dp),
                )
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除这篇笔记？") },
            confirmButton = {
                TextButton(onClick = {
                    store.deleteNote(noteId)
                    confirmDelete = false
                    onDismiss()
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("取消") } },
        )
    }
}

// MARK: - Markdown 编辑助手（对应 iOS 端 EditorProxy：选区包裹与行首前缀）

fun wrapSelection(tfv: TextFieldValue, prefix: String, suffix: String, placeholder: String): TextFieldValue {
    val sel = tfv.selection
    val text = tfv.text
    val selected = if (sel.length > 0) text.substring(sel.min, sel.max) else placeholder
    val replacement = prefix + selected + suffix
    val newText = text.substring(0, sel.min) + replacement + text.substring(sel.max)
    return TextFieldValue(newText, TextRange(sel.min + prefix.length, sel.min + prefix.length + selected.length))
}

fun prefixLines(tfv: TextFieldValue, prefix: String): TextFieldValue {
    val text = tfv.text
    val sel = tfv.selection
    val start = if (sel.min == 0) 0 else text.lastIndexOf('\n', sel.min - 1) + 1
    val end = sel.max
    val segment = text.substring(start, end)
    val replaced = segment.split("\n").joinToString("\n") { prefix + it }
    val newText = text.substring(0, start) + replaced + text.substring(end)
    return TextFieldValue(newText, TextRange(start, start + replaced.length))
}

// MARK: - Markdown 工具栏

@Composable
private fun MarkdownToolbar(
    onWrap: (String, String, String) -> Unit,
    onLinePrefix: (String) -> Unit,
    onPhoto: () -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        ToolLabel("B", bold = true) { onWrap("**", "**", "粗体") }
        ToolLabel("I", italic = true) { onWrap("*", "*", "斜体") }
        ToolLabel("S", strike = true) { onWrap("~~", "~~", "删除线") }
        ToolLabel("code", mono = true) { onWrap("`", "`", "代码") }
        ToolLabel("# 标题", mono = true) { onLinePrefix("## ") }
        ToolLabel("❝ 引用") { onLinePrefix("> ") }
        ToolLabel("• 列表") { onLinePrefix("- ") }
        ToolLabel("1. 列表", mono = true) { onLinePrefix("1. ") }
        ToolLabel("📷 图片", mono = true) { onPhoto() }
    }
}

@Composable
private fun ToolLabel(
    label: String,
    bold: Boolean = false,
    italic: Boolean = false,
    strike: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    Text(
        label,
        style = MaterialTheme.typography.labelMedium.copy(
            fontWeight = if (bold) FontWeight.Bold else null,
            fontStyle = if (italic) FontStyle.Italic else null,
            textDecoration = if (strike) TextDecoration.LineThrough else null,
            fontFamily = if (mono) androidx.compose.ui.text.font.FontFamily.Monospace else null,
        ),
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surface)
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}
