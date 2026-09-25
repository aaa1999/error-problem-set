package com.errorbook.android

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Label
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.Update
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// MARK: - 错题本浏览（对应桌面端 BrowseView、iOS 端 BrowseTab：一页一题，离线翻页复习）

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseTab(
    openSync: () -> Unit,
    openBatchImport: () -> Unit,
) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val db by store.db.collectAsState()

    // "" 全部 | "uncat" 未分类 | 文件夹 id
    var selectedFolder by remember { mutableStateOf("") }
    val activeTags = remember { mutableStateListOf<String>() }
    var tagModeAnd by remember { mutableStateOf(true) }
    var revealed by remember { mutableStateOf(false) }
    // 排列方式（time | error | random），SharedPreferences 跨启动保持；随机用 seed 固定的稳定洗牌
    val prefs = remember { Prefs.get(context) }
    var orderRaw by remember { mutableStateOf(prefs.getString("browseOrder", "time") ?: "time") }
    var shuffleSeed by remember { mutableIntStateOf((1..Int.MAX_VALUE).random()) }

    val list = remember(db, selectedFolder, activeTags.toList(), tagModeAnd, orderRaw, shuffleSeed) {
        var arr = db.mistakes
        val folders = db.folders
        if (selectedFolder == "uncat") {
            val ids = folders.map { it.id }.toSet()
            arr = arr.filter { m -> m.folderIds.none { it in ids } }
        } else if (selectedFolder.isNotEmpty()) {
            val set = descendantSet(folders, selectedFolder)
            arr = arr.filter { m -> m.folderIds.any { it in set } }
        }
        if (activeTags.isNotEmpty()) {
            arr = arr.filter { m ->
                if (tagModeAnd) activeTags.all { it in m.tags } else activeTags.any { it in m.tags }
            }
        }
        when (orderRaw) {
            // 随机：seed 固定的稳定洗牌（换 seed 才换序，翻页中途不跳）
            "random" -> seededShuffle(arr, shuffleSeed)
            // 错误率：只排带选项且标记了答案的题（高 → 低 → 作答多 → 先录入）
            "error" -> arr
                .filter { it.options.isNotEmpty() && it.answer != null }
                .sortedWith(
                    compareByDescending<Mistake> { optionRate(it) }
                        .thenByDescending { it.attempts }
                        .thenBy { it.createdAt }
                )
            // 时间：按录入时间升序
            else -> arr.sortedBy { it.createdAt }
        }
    }

    val pagerState = rememberPagerState(initialPage = 0) { list.size }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val current: Mistake? = list.getOrNull(pagerState.currentPage)

    // 覆盖层状态
    var entryTarget by remember { mutableStateOf<Mistake?>(null) }
    var entryNew by remember { mutableStateOf(false) }
    var moveOpen by remember { mutableStateOf(false) }
    var tagSheetFor by remember { mutableStateOf<Mistake?>(null) }
    var lightboxPath by remember { mutableStateOf<String?>(null) }
    var numOpen by remember { mutableStateOf(false) }
    var newTagOpen by remember { mutableStateOf(false) }
    var newTagDraft by remember { mutableStateOf("") }
    // 录入三入口：普通 = entryNew；文件夹/标签录入先选目标再进录入页
    var folderEntryOpen by remember { mutableStateOf(false) }
    val folderEntrySel = remember { mutableStateListOf<String>() }
    var tagEntryOpen by remember { mutableStateOf(false) }
    val tagEntrySel = remember { mutableStateListOf<String>() }
    var entryPresetFolders by remember { mutableStateOf<List<String>?>(null) }
    var entryPresetTags by remember { mutableStateOf<List<String>?>(null) }

    fun enterRandom() {
        if (orderRaw != "random") shuffleSeed = (1..Int.MAX_VALUE).random()
        orderRaw = "random"
    }

    // 筛选/排列变化：回第一题、合上解析
    LaunchedEffect(selectedFolder, activeTags.toList(), tagModeAnd, orderRaw, shuffleSeed) {
        revealed = false
        if (pagerState.currentPage != 0) pagerState.scrollToPage(0)
    }
    // 翻页重置解析
    LaunchedEffect(pagerState) {
        snapshotFlow { pagerState.currentPage }.collect {
            revealed = false
        }
    }
    // 列表缩短时夹住页码
    LaunchedEffect(list.size) {
        if (pagerState.currentPage >= list.size) {
            pagerState.scrollToPage(maxOf(0, list.size - 1))
        }
    }

    val crumb = when {
        selectedFolder.isEmpty() -> "全部错题"
        selectedFolder == "uncat" -> "未分类"
        else -> folderPathName(db.folders, selectedFolder)
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            TopAppBar(
                title = {
                    Text(crumb, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                actions = {
                    // 录入三入口：普通 / 文件夹 / 标签
                    var addMenu by remember { mutableStateOf(false) }
                    Box {
                        IconButton(onClick = { addMenu = true }) {
                            Icon(Icons.Filled.Add, contentDescription = "添加")
                        }
                        DropdownMenu(expanded = addMenu, onDismissRequest = { addMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("普通录入") },
                                leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                                onClick = { addMenu = false; entryNew = true },
                            )
                            DropdownMenuItem(
                                text = { Text("文件夹录入…") },
                                leadingIcon = { Icon(Icons.Filled.Folder, contentDescription = null) },
                                onClick = { addMenu = false; folderEntrySel.clear(); folderEntryOpen = true },
                            )
                            DropdownMenuItem(
                                text = { Text("标签录入…") },
                                leadingIcon = { Icon(Icons.Filled.Label, contentDescription = null) },
                                onClick = { addMenu = false; tagEntrySel.clear(); tagEntryOpen = true },
                            )
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("批量导入截图") },
                                leadingIcon = { Icon(Icons.Filled.PhotoLibrary, contentDescription = null) },
                                onClick = { addMenu = false; openBatchImport() },
                            )
                        }
                    }
                    IconButton(onClick = openSync) {
                        Icon(Icons.Filled.CloudUpload, contentDescription = "同步")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )

            // filterBar 常驻（空列表也显示）：排列方式与筛选菜单永远可达，
            // 避免错误率排序下点到没有选择题的文件夹时被困在空态里
            FilterBar(
                db = db,
                selectedFolder = selectedFolder,
                onSelectFolder = { selectedFolder = it },
                activeTags = activeTags,
                tagModeAnd = tagModeAnd,
                onTagModeAnd = { tagModeAnd = it },
                orderRaw = orderRaw,
                onOrder = {
                    orderRaw = it
                    prefs.edit().putString("browseOrder", it).apply()
                },
                onEnterRandom = { enterRandom() },
                onReshuffle = { shuffleSeed = (1..Int.MAX_VALUE).random() },
                onNewTag = { newTagOpen = true },
                tagCounts = store.tagCounts,
            )

            if (list.isEmpty()) {
                val emptyLib = db.mistakes.isEmpty()
                EmptyState(
                    icon = if (emptyLib) Icons.AutoMirrored.Filled.MenuBook else Icons.Filled.Update,
                    title = if (emptyLib) "还没有错题" else "当前条件下没有错题",
                    message = when {
                        emptyLib -> "先录入第一道题，或把攒了一堆的截图批量导入进来。"
                        orderRaw == "error" -> "没有带选项的错题——错误率排序只统计录入时填了选项并标记了正确答案的题；也可换文件夹或标签筛选条件试试。"
                        else -> "换个文件夹或标签筛选条件试试。"
                    },
                    actionTitle = if (emptyLib) "＋ 录入错题" else "清除筛选",
                    action = if (emptyLib) ({ entryNew = true }) else ({
                        selectedFolder = ""
                        activeTags.clear()
                    }),
                )
            } else {
                Box(modifier = Modifier.weight(1f)) {
                    HorizontalPager(
                        state = pagerState,
                        modifier = Modifier.fillMaxSize(),
                        pageSpacing = 8.dp,
                    ) { page ->
                        val m = list[page]
                        MistakeCardView(
                            mistake = m,
                            revealed = revealed,
                            onReveal = { revealed = true },
                            onImageTap = { lightboxPath = it },
                            onEdit = { entryTarget = m },
                            onTagEdit = { tagSheetFor = m },
                            onMoveRequest = { moveOpen = true },
                        )
                    }
                }
                BottomBar(
                    index = pagerState.currentPage,
                    count = list.size,
                    onPrev = {
                        if (pagerState.currentPage > 0) scope.launch {
                            pagerState.animateScrollToPage(pagerState.currentPage - 1)
                        }
                    },
                    onNext = {
                        if (pagerState.currentPage < list.size - 1) scope.launch {
                            pagerState.animateScrollToPage(pagerState.currentPage + 1)
                        }
                    },
                    onOverview = { numOpen = true },
                )
            }
        }

        // ---------- 覆盖层 ----------

        if (entryTarget != null) {
            EntrySheetOverlay(editing = entryTarget, onDismiss = { entryTarget = null })
        }
        if (entryNew) {
            EntrySheetOverlay(editing = null, onDismiss = { entryNew = false })
        }
        entryPresetFolders?.let { folders ->
            EntrySheetOverlay(editing = null, presetFolders = folders, onDismiss = { entryPresetFolders = null })
        }
        entryPresetTags?.let { tags ->
            EntrySheetOverlay(editing = null, presetTags = tags, onDismiss = { entryPresetTags = null })
        }
        if (moveOpen) {
            MoveSheet(
                folders = db.folders,
                initial = current?.folderIds ?: emptyList(),
                onSave = { ids ->
                    current?.let { m -> store.setMistakeFolders(m.id, ids) }
                    moveOpen = false
                },
                onCancel = { moveOpen = false },
            )
        }
        tagSheetFor?.let { m ->
            TagEditSheet(mistakeId = m.id, onDone = { tagSheetFor = null })
        }
        lightboxPath?.let { path ->
            LightboxOverlay(path = path, onClose = { lightboxPath = null })
        }
        if (numOpen) {
            NumberOverviewSheet(
                list = list,
                current = pagerState.currentPage,
                onPick = {
                    numOpen = false
                    scope.launch { pagerState.scrollToPage(it) }
                },
                onClose = { numOpen = false },
            )
        }
        if (newTagOpen) {
            AlertDialog(
                onDismissRequest = { newTagOpen = false; newTagDraft = "" },
                title = { Text("新建标签") },
                text = {
                    Column {
                        OutlinedTextField(
                            value = newTagDraft,
                            onValueChange = { newTagDraft = it },
                            placeholder = { Text("标签名称") },
                            singleLine = true,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "预建标签不挂在错题上也保留，方便提前规划标签体系",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        store.createTag(newTagDraft)
                        newTagDraft = ""
                        newTagOpen = false
                    }) { Text("新建") }
                },
                dismissButton = {
                    TextButton(onClick = { newTagDraft = ""; newTagOpen = false }) { Text("取消") }
                },
            )
        }
        if (folderEntryOpen) {
            PickerSheet(
                title = "文件夹录入",
                confirmText = "开始录入",
                confirmEnabled = folderEntrySel.isNotEmpty(),
                onConfirm = {
                    folderEntryOpen = false
                    entryPresetFolders = folderEntrySel.toList()
                },
                onCancel = { folderEntryOpen = false },
            ) {
                FolderMultiPicker(folders = db.folders, value = folderEntrySel)
            }
        }
        if (tagEntryOpen) {
            PickerSheet(
                title = "标签录入",
                confirmText = "开始录入",
                confirmEnabled = tagEntrySel.isNotEmpty(),
                onConfirm = {
                    tagEntryOpen = false
                    entryPresetTags = tagEntrySel.toList()
                },
                onCancel = { tagEntryOpen = false },
            ) {
                if (store.allTags.isEmpty()) {
                    Text(
                        "还没有标签：先在标签菜单里新建，或普通录入后在题上打标签",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    store.allTags.forEach { t ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { if (tagEntrySel.contains(t)) tagEntrySel.remove(t) else tagEntrySel.add(t) }
                                .padding(vertical = 6.dp),
                        ) {
                            Text(t, modifier = Modifier.weight(1f))
                            if (tagEntrySel.contains(t)) Text("✓", color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
}

// MARK: 筛选栏

@Composable
private fun FilterBar(
    db: Database,
    selectedFolder: String,
    onSelectFolder: (String) -> Unit,
    activeTags: androidx.compose.runtime.snapshots.SnapshotStateList<String>,
    tagModeAnd: Boolean,
    onTagModeAnd: (Boolean) -> Unit,
    orderRaw: String,
    onOrder: (String) -> Unit,
    onEnterRandom: () -> Unit,
    onReshuffle: () -> Unit,
    onNewTag: () -> Unit,
    tagCounts: List<Pair<String, Int>>,
) {
    val folders = db.folders
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // 文件夹菜单
            var folderMenu by remember { mutableStateOf(false) }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { folderMenu = true }
                    .padding(vertical = 4.dp),
            ) {
                Icon(Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(4.dp))
                Text(
                    when {
                        selectedFolder.isEmpty() -> "全部错题"
                        selectedFolder == "uncat" -> "未分类（${countUncategorized(db.mistakes, folders)}）"
                        else -> folderPathName(folders, selectedFolder)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(" ▾", style = MaterialTheme.typography.labelSmall)
            }
            DropdownMenu(expanded = folderMenu, onDismissRequest = { folderMenu = false }) {
                DropdownMenuItem(text = { Text("全部错题") }, onClick = { folderMenu = false; onSelectFolder("") })
                DropdownMenuItem(
                    text = { Text("未分类（${countUncategorized(db.mistakes, folders)}）") },
                    onClick = { folderMenu = false; onSelectFolder("uncat") },
                )
                HorizontalDivider()
                flatFolders(folders).forEach { item ->
                    DropdownMenuItem(
                        text = {
                            Row {
                                Text("　".repeat(item.depth) + item.folder.name, modifier = Modifier.weight(1f))
                                Text(
                                    "${countInFolder(db.mistakes, folders, item.folder.id)}",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        },
                        onClick = { folderMenu = false; onSelectFolder(item.folder.id) },
                    )
                }
            }

            Spacer(Modifier.width(8.dp))

            // 标签菜单（无筛选时）
            if (activeTags.isEmpty() && selectedFolder.isEmpty()) {
                var tagMenu by remember { mutableStateOf(false) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { tagMenu = true }
                        .padding(vertical = 4.dp),
                ) {
                    Icon(Icons.Filled.Label, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(4.dp))
                    Text("标签", style = MaterialTheme.typography.labelMedium)
                    Text(" ▾", style = MaterialTheme.typography.labelSmall)
                }
                DropdownMenu(expanded = tagMenu, onDismissRequest = { tagMenu = false }) {
                    DropdownMenuItem(
                        text = { Text(if (tagModeAnd) "✓ 需同时包含（且）" else "需同时包含（且）") },
                        onClick = { onTagModeAnd(true) },
                    )
                    DropdownMenuItem(
                        text = { Text(if (!tagModeAnd) "✓ 任一满足（或）" else "任一满足（或）") },
                        onClick = { onTagModeAnd(false) },
                    )
                    DropdownMenuItem(
                        text = { Text("＋ 新建标签…") },
                        onClick = { tagMenu = false; onNewTag() },
                    )
                    if (tagCounts.isEmpty()) {
                        DropdownMenuItem(text = { Text("还没有标签") }, onClick = { })
                    } else {
                        HorizontalDivider()
                        tagCounts.forEach { (tag, count) ->
                            DropdownMenuItem(
                                text = { Text("$tag（$count）") },
                                onClick = {
                                    tagMenu = false
                                    if (!activeTags.contains(tag)) activeTags.add(tag)
                                },
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.width(8.dp))

            // 排列方式：按录入时间 / 按错误率 / 随机（稳定洗牌，点「随机」再点一次换一批）
            var orderMenu by remember { mutableStateOf(false) }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { orderMenu = true }
                    .padding(vertical = 4.dp),
            ) {
                Icon(
                    when (orderRaw) {
                        "random" -> Icons.Filled.Shuffle
                        "error" -> Icons.Filled.BarChart
                        else -> Icons.Filled.Update
                    },
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    when (orderRaw) {
                        "random" -> "随机"
                        "error" -> "错误率"
                        else -> "时间"
                    },
                    style = MaterialTheme.typography.labelMedium,
                )
                Text(" ▾", style = MaterialTheme.typography.labelSmall)
            }
            DropdownMenu(expanded = orderMenu, onDismissRequest = { orderMenu = false }) {
                DropdownMenuItem(
                    text = { Text((if (orderRaw == "time") "✓ " else "") + "按录入时间（旧 → 新）") },
                    onClick = { orderMenu = false; onOrder("time") },
                )
                DropdownMenuItem(
                    text = { Text((if (orderRaw == "error") "✓ " else "") + "按错误率（高 → 低，只看带选项的题）") },
                    onClick = { orderMenu = false; onOrder("error") },
                )
                DropdownMenuItem(
                    text = { Text((if (orderRaw == "random") "✓ " else "") + "随机排列（复习防背序）") },
                    onClick = { orderMenu = false; onEnterRandom() },
                )
                if (orderRaw == "random") {
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("重新洗牌（换一批）") },
                        onClick = { orderMenu = false; onReshuffle() },
                    )
                }
            }
        }

        // 当前条件一目了然：文件夹 / 标签各是可单独移除的 chip，末尾一键重置
        if (activeTags.isNotEmpty() || selectedFolder.isNotEmpty()) {
            FlowRow(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (selectedFolder.isNotEmpty()) {
                    TagChip(if (selectedFolder == "uncat") "未分类" else folderPathName(folders, selectedFolder)) {
                        onSelectFolder("")
                    }
                }
                activeTags.forEach { t ->
                    TagChip(t) {
                        activeTags.remove(t)
                    }
                }
                Text(
                    "⟲ 重置",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFFD32F2F),
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xFFD32F2F).copy(alpha = 0.12f))
                        .clickable {
                            onSelectFolder("")
                            activeTags.clear()
                        }
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                )
            }
            if (activeTags.size >= 2) {
                TextButton(onClick = { onTagModeAnd(!tagModeAnd) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) {
                    Text(if (tagModeAnd) "同时含" else "含任一", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

// MARK: 底栏

@Composable
private fun BottomBar(index: Int, count: Int, onPrev: () -> Unit, onNext: () -> Unit, onOverview: () -> Unit) {
    Surface(tonalElevation = 3.dp) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onPrev, enabled = index > 0) {
                Icon(Icons.Filled.ChevronLeft, contentDescription = "上一题")
            }
            Spacer(Modifier.weight(1f))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onOverview() }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Icon(Icons.Filled.GridView, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "${if (count > 0) index + 1 else 0} / $count",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = onNext, enabled = index < count - 1) {
                Icon(Icons.Filled.ChevronRight, contentDescription = "下一题")
            }
        }
    }
}

// MARK: 通用选择弹层（文件夹录入 / 标签录入 / 调整所属文件夹共用的壳）

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PickerSheet(
    title: String,
    confirmText: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    content: @Composable () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onCancel) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel) { Text("取消") }
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                )
                TextButton(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmText) }
            }
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

// MARK: 调整所属文件夹

@Composable
private fun MoveSheet(
    folders: List<Folder>,
    initial: List<String>,
    onSave: (List<String>) -> Unit,
    onCancel: () -> Unit,
) {
    val sel = remember { mutableStateListOf<String>().apply { addAll(initial) } }
    PickerSheet(
        title = "调整所属文件夹",
        confirmText = "保存",
        confirmEnabled = true,
        onConfirm = { onSave(sel.toList()) },
        onCancel = onCancel,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { sel.clear() }
                .padding(vertical = 6.dp),
        ) {
            Text("未分类", modifier = Modifier.weight(1f))
            if (sel.isEmpty()) Text("✓", color = MaterialTheme.colorScheme.primary)
        }
        Text(
            "文件夹（可多选）",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
        )
        flatFolders(folders).forEach { item ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { if (sel.contains(item.folder.id)) sel.remove(item.folder.id) else sel.add(item.folder.id) }
                    .padding(vertical = 4.dp),
            ) {
                Text("　".repeat(item.depth) + item.folder.name, modifier = Modifier.weight(1f))
                if (sel.contains(item.folder.id)) Text("✓", color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

// MARK: 题号总览（对应桌面端 num-overview 弹层）
// 当前筛选（文件夹 + 标签）与排列方式下的全部题按导入日期分组展开成题号网格：点题号跳题
// 红 = 错过 · 绿 = 作答全对 · 灰 = 未作答 / 非选择题 · 蓝框 = 当前题

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NumberOverviewSheet(
    list: List<Mistake>,
    current: Int,
    onPick: (Int) -> Unit,
    onClose: () -> Unit,
) {
    val groups = remember(list) {
        val order = mutableListOf<String>()
        val byDay = LinkedHashMap<String, MutableList<Pair<Int, Mistake>>>()
        list.forEachIndexed { i, m ->
            val day = formatDay(m.createdAt)
            if (!byDay.containsKey(day)) order.add(day)
            byDay.getOrPut(day) { mutableListOf() }.add(i to m)
        }
        order.map { it to byDay[it]!! }
    }
    val listState = rememberLazyListState()

    ModalBottomSheet(onDismissRequest = onClose) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                "题号总览（${list.size} 题）",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 480.dp)
                    .padding(vertical = 8.dp),
            ) {
                groups.forEachIndexed { gi, (day, items) ->
                    item(key = "day-$gi") {
                        Column(modifier = Modifier.padding(horizontal = 14.dp)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.padding(top = 8.dp),
                            ) {
                                Text(day, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                                Text("${items.size} 题", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            // 6 列题号网格
                            items.chunked(6).forEach { rowItems ->
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 8.dp),
                                ) {
                                    rowItems.forEach { (i, m) ->
                                        val bg = when {
                                            m.wrong > 0 -> Color(0xFFD32F2F).copy(alpha = 0.15f)
                                            m.attempts > 0 -> Color(0xFF2E7D32).copy(alpha = 0.15f)
                                            else -> MaterialTheme.colorScheme.surfaceVariant
                                        }
                                        val fg = when {
                                            m.wrong > 0 -> Color(0xFFD32F2F)
                                            m.attempts > 0 -> Color(0xFF2E7D32)
                                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                                        }
                                        Box(
                                            contentAlignment = Alignment.Center,
                                            modifier = Modifier
                                                .weight(1f)
                                                .height(34.dp)
                                                .clip(RoundedCornerShape(8.dp))
                                                .background(bg)
                                                .then(
                                                    if (i == current) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
                                                    else Modifier
                                                )
                                                .clickable { onPick(i) },
                                        ) {
                                            Text("${i + 1}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = fg)
                                        }
                                    }
                                                    // 补齐空位保持对齐
                                    repeat(6 - rowItems.size) {
                                        Spacer(Modifier.weight(1f))
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Text(
                "按导入日期分组 · 红 = 错过 · 绿 = 作答全对 · 灰 = 未作答 / 非选择题；点题号跳转",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
    // 打开时滚到当前题所在分组
    LaunchedEffect(list, current) {
        if (list.isEmpty() || current !in list.indices) return@LaunchedEffect
        val day = formatDay(list[current].createdAt)
        val gi = groups.indexOfFirst { it.first == day }
        if (gi >= 0) listState.scrollToItem(gi)
    }
}

// MARK: 单题卡片

@Composable
fun MistakeCardView(
    mistake: Mistake,
    revealed: Boolean,
    onReveal: () -> Unit,
    onImageTap: (String) -> Unit,
    onEdit: () -> Unit,
    onTagEdit: () -> Unit,
    onMoveRequest: () -> Unit,
) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    var confirmDelete by remember { mutableStateOf(false) }
    // 一键复制整道题的短暂反馈
    var copiedFlash by remember { mutableStateOf(false) }
    // 选择题作答：本次浏览内每题只作答一次，答完自动看解析并累计统计（落盘）
    var picked by remember(mistake.id) { mutableStateOf<Int?>(null) }

    val analysisEmpty = isBlocksEmpty(mistake.analysis)

    fun answerOption(i: Int) {
        if (picked != null) return
        val ans = mistake.answer ?: return
        picked = i
        onReveal() // 答完自动翻开解析
        val ok = i == ans
        store.updateMistake(
            mistake.copy(
                attempts = mistake.attempts + 1,
                wrong = mistake.wrong + (if (ok) 0 else 1),
                updatedAt = nowMs(),
            )
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // 标签行
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            mistake.tags.forEach { t -> TagChip(t) }
            Text(
                "＋ 标签",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { onTagEdit() }
                    .padding(horizontal = 9.dp, vertical = 4.dp),
            )
        }

        Text("题目", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        BlockListView(blocks = mistake.question, onImageTap = onImageTap)

        if (mistake.options.isNotEmpty() && mistake.answer != null) {
            OptionBlock(
                mistake = mistake,
                picked = picked,
                onPick = { answerOption(it) },
            )
        }

        HorizontalDivider()

        if (revealed || analysisEmpty) {
            Text("解析", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (analysisEmpty) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("这道题还没有解析", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onEdit) { Text("去补解析") }
                }
            } else {
                BlockListView(blocks = mistake.analysis, onImageTap = onImageTap)
            }
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { onReveal() }
                    .padding(vertical = 18.dp),
            ) {
                Text("👁 点击查看解析", style = MaterialTheme.typography.bodyMedium)
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                formatTime(mistake.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
            )
            if (copiedFlash) {
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color(0xFF2E7D32), modifier = Modifier.size(12.dp))
                Text("已复制（含图片）", style = MaterialTheme.typography.labelSmall, color = Color(0xFF2E7D32))
            }
            Spacer(Modifier.weight(1f))
            var menuOpen by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("只复制题目（含图片）") },
                        onClick = {
                            menuOpen = false
                            copyMistakeToClipboard(context, mistake, store.db.value.folders, store.dataDir, questionOnly = true)
                            copiedFlash = true
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("复制全部内容（题目、选项、解析…）") },
                        onClick = {
                            menuOpen = false
                            copyMistakeToClipboard(context, mistake, store.db.value.folders, store.dataDir)
                            copiedFlash = true
                        },
                    )
                    DropdownMenuItem(text = { Text("编辑") }, leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) }, onClick = { menuOpen = false; onEdit() })
                    DropdownMenuItem(text = { Text("标签") }, leadingIcon = { Icon(Icons.Filled.Label, contentDescription = null) }, onClick = { menuOpen = false; onTagEdit() })
                    DropdownMenuItem(text = { Text("调整所属文件夹") }, leadingIcon = { Icon(Icons.Filled.Folder, contentDescription = null) }, onClick = { menuOpen = false; onMoveRequest() })
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                        onClick = { menuOpen = false; confirmDelete = true },
                    )
                }
            }
        }
    }

    LaunchedEffect(copiedFlash) {
        if (copiedFlash) {
            delay(1600)
            copiedFlash = false
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("确定删除这道题吗？") },
            text = { Text("旧数据在数据目录的 snapshots 里还有备份") },
            confirmButton = {
                TextButton(onClick = {
                    store.deleteMistake(mistake.id)
                    confirmDelete = false
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("取消") } },
        )
    }
}

// MARK: 选择题作答区

@Composable
private fun OptionBlock(mistake: Mistake, picked: Int?, onPick: (Int) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("作答", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val rate = optionRate(mistake)
            Text(
                "错误率 $rate%（${mistake.wrong}/${mistake.attempts}）",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = when {
                    mistake.attempts == 0 -> MaterialTheme.colorScheme.onSurfaceVariant
                    rate >= 50 -> Color(0xFFD32F2F)
                    else -> Color(0xFF2E7D32)
                },
            )
        }
        mistake.options.forEachIndexed { i, opt ->
            val answered = picked != null
            val isCorrect = i == mistake.answer
            val isWrongPick = answered && i == picked && !isCorrect
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(
                        when {
                            answered && isCorrect -> Color(0xFF2E7D32).copy(alpha = 0.12f)
                            isWrongPick -> Color(0xFFD32F2F).copy(alpha = 0.12f)
                            else -> MaterialTheme.colorScheme.surfaceVariant
                        }
                    )
                    .clickable(enabled = !answered) { onPick(i) }
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(24.dp)
                        .clip(RoundedCornerShape(50))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Text("${'A' + i}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                }
                Text(opt, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                if (answered && isCorrect) {
                    Text(
                        if (picked == i) "选对了" else "正确答案",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color(0xFF2E7D32),
                    )
                }
                if (isWrongPick) {
                    Text("你的选择", style = MaterialTheme.typography.labelSmall, color = Color(0xFFD32F2F))
                }
            }
        }
    }
}

// MARK: 只读块渲染

@Composable
fun BlockListView(blocks: List<Block>, onImageTap: (String) -> Unit) {
    val store = LocalBookStore.current
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        blocks.forEach { b ->
            when (b) {
                is Block.Text -> {
                    if (b.text.isNotEmpty()) {
                        Text(b.text, style = MaterialTheme.typography.bodyLarge)
                    }
                }
                is Block.Image -> {
                    val path = ImageStore.assetFile(store.dataDir, b.hash, b.ext).path
                    AssetImage(path = path, onTap = { onImageTap(path) })
                }
            }
        }
    }
}

// MARK: 当前题标签编辑（对应桌面端 tag-pop）

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TagEditSheet(mistakeId: String, onDone: () -> Unit) {
    val store = LocalBookStore.current
    var draft by remember { mutableStateOf("") }
    val m = store.db.value.mistakes.firstOrNull { it.id == mistakeId }

    ModalBottomSheet(onDismissRequest = onDone) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(bottom = 24.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("标签", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = onDone) { Text("完成") }
            }
            if (m != null) {
                Text("已选标签", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (m.tags.isEmpty()) {
                    Text("还没有标签", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(vertical = 6.dp),
                    ) {
                        m.tags.forEach { t ->
                            TagChip(t) {
                                store.updateMistake(m.copy(tags = m.tags.filter { it != t }, updatedAt = nowMs()))
                            }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("全部标签（点击添加/移除）", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (store.allTags.isEmpty()) {
                    Text("还没有标签，在下面输入新建一个", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                store.allTags.forEach { t ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                val tags = if (m.tags.contains(t)) m.tags - t else m.tags + t
                                store.updateMistake(m.copy(tags = tags, updatedAt = nowMs()))
                            }
                            .padding(vertical = 6.dp),
                    ) {
                        Text(t, modifier = Modifier.weight(1f))
                        if (m.tags.contains(t)) Text("✓", color = MaterialTheme.colorScheme.primary)
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("新建标签", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = { Text("新标签名称") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = {
                        val t = draft.trim()
                        if (t.isNotEmpty() && !m.tags.contains(t)) {
                            store.updateMistake(m.copy(tags = m.tags + t, updatedAt = nowMs()))
                        }
                        draft = ""
                    }) { Text("添加") }
                }
            }
        }
    }
}
