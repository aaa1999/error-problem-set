package com.errorbook.android

import android.graphics.Bitmap
import android.util.LruCache
import android.webkit.WebView
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.ui.input.pointer.pointerInput
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

// MARK: - 本地资源图（assets/<hash>.<ext>）带内存缓存（对应 iOS 端 Components.swift 的 AssetImage）

object BitmapCache {
    private val cache = object : LruCache<String, Bitmap>(64 * 1024 * 1024) {} // 约 64MB 位图缓存

    fun load(path: String, maxDim: Int): Bitmap? {
        val key = "$path#$maxDim"
        cache.get(key)?.let { return it }
        val bmp = decodeSampledFile(File(path), maxDim) ?: return null
        cache.put(key, bmp)
        return bmp
    }
}

@Composable
fun AssetImage(path: String, modifier: Modifier = Modifier, maxDim: Int = 2048, onTap: (() -> Unit)? = null) {
    var bmp by remember(path) { mutableStateOf<Bitmap?>(null) }
    var missing by remember(path) { mutableStateOf(false) }
    LaunchedEffect(path) {
        bmp = withContext(Dispatchers.IO) { BitmapCache.load(path, maxDim) }
        missing = bmp == null
    }
    if (bmp != null) {
        Image(
            bitmap = bmp!!.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = onTap != null) { onTap?.invoke() },
        )
    } else if (missing) {
        Box(
            modifier = modifier
                .fillMaxWidth()
                .height(80.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Text("图片缺失", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        Box(
            modifier = modifier
                .fillMaxWidth()
                .height(60.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
        )
    }
}

// MARK: - 灯箱（全屏可缩放，对应 LightboxView）

@Composable
fun LightboxOverlay(path: String, onClose: () -> Unit) {
    var scale by remember { mutableStateOf(1f) }
    androidx.activity.compose.BackHandler(onBack = { onClose() })
    var lastScale by remember { mutableStateOf(1f) }
    var offsetX by remember { mutableStateOf(0f) }
    var offsetY by remember { mutableStateOf(0f) }
    val transformed = rememberTransformableState { zoomChange, panChange, _ ->
        val newScale = (scale * zoomChange).coerceIn(1f, 6f)
        if (newScale > 1f) {
            offsetX += panChange.x
            offsetY += panChange.y
        } else {
            offsetX = 0f
            offsetY = 0f
        }
        scale = newScale
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .transformable(transformed)
            .pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = {
                        scale = if (scale > 1f) 1f else 2.5f
                        if (scale == 1f) {
                            offsetX = 0f
                            offsetY = 0f
                        }
                    },
                    onTap = { onClose() },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = scale,
                    scaleY = scale,
                    translationX = offsetX,
                    translationY = offsetY,
                ),
            contentAlignment = Alignment.Center,
        ) {
            AssetImage(path = path, maxDim = 4096, modifier = Modifier.fillMaxSize())
        }
        // 关闭按钮
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(16.dp),
        ) {
            Icon(Icons.Filled.Close, contentDescription = "关闭", tint = Color.White)
        }
    }
}

// MARK: - HTML 预览（Markdown 渲染结果 / Word 笔记，对应 HTMLPreview）

@Composable
fun HtmlPreview(html: String, modifier: Modifier = Modifier) {
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                isVerticalScrollBarEnabled = true
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
            }
        },
        update = { wv ->
            val doc = """
                <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                body{font-family:system-ui,-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif;font-size:16px;line-height:1.75;color:#1a1a1a;
                     padding:14px 14px 28px;word-break:break-word;-webkit-text-size-adjust:100%}
                img{max-width:100%;border-radius:8px}
                pre{background:#f4f4f4;padding:10px;border-radius:8px;overflow-x:auto;white-space:pre-wrap}
                code{font-family:Menlo,monospace;background:#f2f2f2;border-radius:3px;padding:0 4px}
                pre code{background:none;padding:0}
                blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid #bbb;color:#555}
                table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #999;padding:4px 8px}
                a{color:#2563af}
                </style></head><body>$html</body></html>
            """.trimIndent()
            wv.loadDataWithBaseURL(null, doc, "text/html", "utf-8", null)
        },
        modifier = modifier,
    )
}

// MARK: - 标签（对应 TagChip / TagInput）

@Composable
fun TagChip(text: String, onRemove: (() -> Unit)? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.14f))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
        )
        if (onRemove != null) {
            Icon(
                Icons.Filled.Close,
                contentDescription = "移除",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .size(10.dp)
                    .clickable { onRemove() },
            )
        }
    }
}

/** 标签输入：已选 chips + 输入框 + 全库标签建议 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun TagInput(
    tags: MutableList<String>,
    suggestions: List<String>,
    modifier: Modifier = Modifier,
) {
    var draft by remember { mutableStateOf("") }

    fun addDraft() {
        val t = draft.trim()
        draft = ""
        if (t.isEmpty() || tags.contains(t)) return
        tags.add(t)
    }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (tags.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tags.forEach { t ->
                    TagChip(t) { tags.remove(t) }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("输入标签，回车添加") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { addDraft() }) { Text("添加") }
        }
        val others = suggestions.filter { it !in tags }.take(20)
        if (others.isNotEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
            ) {
                others.forEach { t ->
                    Text(
                        "＋ $t",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .clickable { if (!tags.contains(t)) tags.add(t) }
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

// MARK: - 文件夹选择（对应 FolderPicker / FolderMultiPicker）

/** 单选下拉（批量导入目标文件夹等） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerMenu(
    folders: List<Folder>,
    value: String?,
    onPick: (String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable { open = true }
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text("📁 ", style = MaterialTheme.typography.bodyMedium)
        Text(
            folderPathName(folders, value),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
        )
        Text(" ▾", style = MaterialTheme.typography.labelSmall)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text(folderPathName(folders, null)) },
            onClick = {
                onPick(null)
                open = false
            },
        )
        flatFolders(folders).forEach { item ->
            DropdownMenuItem(
                text = { Text("　".repeat(item.depth) + item.folder.name) },
                onClick = {
                    onPick(item.folder.id)
                    open = false
                },
            )
        }
    }
}

/** 多选入口按钮：显示当前所属（多个时「第一个 +N」），点开勾选弹层；空列表 = 未分类 */
@Composable
fun FolderMultiPicker(
    folders: List<Folder>,
    value: MutableList<String>,
) {
    var open by remember { mutableStateOf(false) }
    val label = if (value.isEmpty()) {
        "未分类"
    } else {
        val first = folderPathName(folders, value.first())
        if (value.size == 1) first else "$first +${value.size - 1}"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable { open = true }
            .padding(horizontal = 4.dp, vertical = 2.dp),
    ) {
        Text("📁 ", style = MaterialTheme.typography.bodyMedium)
        Text(label, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        Text(" ▾", style = MaterialTheme.typography.labelSmall)
    }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("所属文件夹") },
            text = {
                Column {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { value.clear() }
                            .padding(vertical = 6.dp),
                    ) {
                        Text("未分类", modifier = Modifier.weight(1f))
                        if (value.isEmpty()) Text("✓", color = MaterialTheme.colorScheme.primary)
                    }
                    Text(
                        "文件夹（可多选）",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                    )
                    val flats = flatFolders(folders)
                    if (flats.isEmpty()) {
                        Text(
                            "还没有文件夹，可在设置 → 文件夹管理里新建",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        flats.forEach { item ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        if (value.contains(item.folder.id)) value.remove(item.folder.id) else value.add(item.folder.id)
                                    }
                                    .padding(vertical = 4.dp),
                            ) {
                                Text("　".repeat(item.depth) + item.folder.name, modifier = Modifier.weight(1f))
                                if (value.contains(item.folder.id)) {
                                    Text("✓", color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { open = false }) { Text("完成") }
            },
        )
    }
}

// MARK: - 空状态（对应 EmptyStateView）

@Composable
fun EmptyState(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    actionTitle: String? = null,
    action: (() -> Unit)? = null,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
            modifier = Modifier.size(72.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (actionTitle != null && action != null) {
            Spacer(Modifier.height(12.dp))
            androidx.compose.material3.Button(onClick = action) {
                Text(actionTitle, fontWeight = FontWeight.Bold)
            }
        }
    }
}

// MARK: - Compose FlowRow 引用（foundation 布局）

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun FlowRow(
    modifier: Modifier = Modifier,
    horizontalArrangement: Arrangement.Horizontal = Arrangement.Start,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    androidx.compose.foundation.layout.FlowRow(
        modifier = modifier,
        horizontalArrangement = horizontalArrangement,
    ) {
        content()
    }
}

// MARK: - 全局 CompositionLocal 与偏好存储（@AppStorage / UserDefaults 的对应物）

val LocalBookStore = androidx.compose.runtime.staticCompositionLocalOf<BookStore> {
    error("BookStore 未提供")
}

object Prefs {
    const val NAME = "errorbook"

    fun get(context: android.content.Context) = context.getSharedPreferences(NAME, android.content.Context.MODE_PRIVATE)
}

@Composable
fun rememberPrefs() = Prefs.get(androidx.compose.ui.platform.LocalContext.current)
