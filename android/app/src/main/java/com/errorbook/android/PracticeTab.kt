package com.errorbook.android

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

// MARK: - 做题 tab（对应桌面端 src/views/PracticeView、iOS 端 PracticeTab.swift）
// 外部刷题的答题卡：输文件夹名 + 题数（1–100）→ 逐题选 A/B/C/D 作答（可标记 ⭐ 值得导入）
// → 做完手动输入正确答案比对 → 答错的和标记过的一键导入错题本（所选文件夹，题干占位待补）。

enum class PracticePhase { ANSWER, KEY, RESULT }

data class PracticeSheet(
    val folderName: String = "",
    val count: Int = 0,
    val mine: List<String?> = emptyList(),   // 我的答案（"A"–"D"，未答 null）
    val key: List<String?> = emptyList(),    // 正确答案（未对 null）
    val flagged: List<Boolean> = emptyList(), // 做题过程中标记 ⭐ 值得导入
    val imported: List<Boolean> = emptyList(), // 已导入错题本
    val importSel: List<Boolean> = emptyList(), // 结果页的导入勾选（进入结果时按「答错 ∪ 标记⭐」预勾，可增减）
) {
    fun verdict(i: Int): String {
        if (key[i] == null) return "unknown"
        if (mine[i] == null) return "blank"
        return if (mine[i] == key[i]) "correct" else "wrong"
    }

    val stats: List<Int>
        get() {
            val v = (0 until count).map { verdict(it) }
            return listOf(
                v.count { it == "correct" },
                v.count { it == "wrong" },
                v.count { it == "blank" },
                v.count { it == "unknown" },
            )
        }

    /** 建议导入 = 答错 ∪ 标记 ⭐ */
    val suggest: List<Int>
        get() = (0 until count).filter { verdict(it) == "wrong" || flagged[it] }
}

private const val NULL_MARK = "\u0001"

private fun List<String?>.encode(): ArrayList<String> = ArrayList(map { it ?: NULL_MARK })

private fun List<Boolean>.encodeFlags(): ArrayList<Boolean> = ArrayList(this)

private fun padBooleans(a: List<Boolean>, n: Int): List<Boolean> = List(n) { i -> a.getOrElse(i) { false } }

private fun decodeStringsN(a: List<String>, n: Int): List<String?> = List(n) { i -> a.getOrNull(i)?.let { if (it == NULL_MARK) null else it } }

/** 会话可保存（旋转/进程重建不丢）；null = 没有会话 */
val PracticeSheetSaver = androidx.compose.runtime.saveable.Saver<PracticeSheet?, ArrayList<Any>>(
    save = { s ->
        if (s == null) {
            arrayListOf()
        } else {
            arrayListOf<Any>(s.folderName, s.count, s.mine.encode(), s.key.encode(), s.flagged.encodeFlags(), s.imported.encodeFlags(), s.importSel.encodeFlags())
        }
    },
    restore = { a ->
        if (a.isEmpty()) {
            null
        } else {
            val n = a[1] as Int
            @Suppress("UNCHECKED_CAST")
            PracticeSheet(
                folderName = a[0] as String,
                count = n,
                mine = decodeStringsN(a[2] as List<String>, n),
                key = decodeStringsN(a[3] as List<String>, n),
                flagged = padBooleans(a[4] as List<Boolean>, n),
                imported = padBooleans(a[5] as List<Boolean>, n),
                importSel = padBooleans(a[6] as List<Boolean>, n),
            )
        }
    },
)

@Composable
fun PracticeTab() {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val prefs = remember { Prefs.get(context) }

    // 做题文件夹：跨启动记住上次用的；会话保存在 tab 里，中途退出全屏页也能继续
    var folderName by remember { mutableStateOf(prefs.getString("practiceFolderName", "") ?: "") }
    var countText by rememberSaveable { mutableStateOf("100") }
    var sheet by rememberSaveable(stateSaver = PracticeSheetSaver) { mutableStateOf<PracticeSheet?>(null) }
    var coverOpen by remember { mutableStateOf(false) }

    fun start() {
        val n = minOf(100, maxOf(1, countText.trim().toIntOrNull() ?: 1))
        countText = "$n"
        prefs.edit().putString("practiceFolderName", folderName.trim()).apply()
        sheet = PracticeSheet(
            folderName = folderName.trim(),
            count = n,
            mine = List(n) { null },
            key = List(n) { null },
            flagged = List(n) { false },
            imported = List(n) { false },
            importSel = List(n) { false },
        )
        coverOpen = true
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("✍️ 做题", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

            val s = sheet
            if (s != null) {
                Button(onClick = { coverOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("继续上次做题")
                }
            }

            Text(
                "文件夹名（导入时按名称查找，没有会自动创建）",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = folderName,
                onValueChange = { folderName = it },
                placeholder = { Text("例如：数学 / 三角函数（留空 = 未分类）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            val folderNames = remember(store.db.value) {
                store.db.value.folders.map { it.name }.distinct().sorted()
            }
            if (folderNames.isNotEmpty()) {
                var pickOpen by remember { mutableStateOf(false) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { pickOpen = true }
                        .padding(vertical = 4.dp),
                ) {
                    Text("选已有文件夹", style = MaterialTheme.typography.labelMedium)
                    Text(" ▾", style = MaterialTheme.typography.labelSmall)
                }
                androidx.compose.material3.DropdownMenu(expanded = pickOpen, onDismissRequest = { pickOpen = false }) {
                    androidx.compose.material3.DropdownMenuItem(
                        text = { Text("（手输新名称）") },
                        onClick = { folderName = ""; pickOpen = false },
                    )
                    folderNames.forEach { n ->
                        androidx.compose.material3.DropdownMenuItem(
                            text = { Text(n) },
                            onClick = { folderName = n; pickOpen = false },
                        )
                    }
                }
            }

            Text("题数（1–100）", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = countText,
                    onValueChange = { countText = it.filter { c -> c.isDigit() } },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.width(90.dp),
                )
                listOf(10, 20, 50, 100).forEach { n ->
                    OutlinedButton(onClick = { countText = "$n" }) { Text("$n") }
                }
            }

            Button(onClick = { start() }, modifier = Modifier.fillMaxWidth()) {
                Text(if (s != null) "重新开始一组" else "开始做题")
            }
            Text(
                "外部刷题的答题卡：逐题选 A/B/C/D，做完输入正确答案比对；答错的和标记 ⭐ 的题可一键导入错题本（之后在错题本里补题目内容和图）。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (coverOpen && sheet != null) {
            PracticePhaseView(
                sheet = sheet!!,
                onUpdate = { sheet = it },
                onFinish = { sheet = null },
                onExit = { coverOpen = false },
            )
        }
    }
}

// MARK: - 阶段页（作答 → 对答案 → 结果）

@Composable
private fun PracticePhaseView(
    sheet: PracticeSheet,
    onUpdate: (PracticeSheet) -> Unit,
    onFinish: () -> Unit,
    onExit: () -> Unit,
) {
    val store = LocalBookStore.current
    var phase by remember { mutableStateOf(PracticePhase.ANSWER) }
    val opts = listOf("A", "B", "C", "D")
    var keyBulk by remember { mutableStateOf("") }
    androidx.activity.compose.BackHandler(onBack = { onExit() })
    var keyBulkMsg by remember { mutableStateOf("") }

    val title = when (phase) {
        PracticePhase.ANSWER -> "做题中" + if (sheet.folderName.isEmpty()) "" else " · ${sheet.folderName}"
        PracticePhase.KEY -> "对答案"
        PracticePhase.RESULT -> "比对结果"
    }

    LaunchedEffect(keyBulkMsg) {
        if (keyBulkMsg.isNotEmpty()) {
            delay(2500)
            keyBulkMsg = ""
        }
    }

    /// 批量导入正确答案：每行「题号 分隔符 答案」（分隔符兼容若干空格/Tab/全角空格/逗号/顿号/句点/冒号；答案不分大小写，全角先转半角）
    fun importKeyBulk() {
        var s = sheet
        var applied = 0
        var bad = 0
        for (raw in keyBulk.lines()) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val m = firstIntAndLetter(line)
            if (m == null || m.first !in 1..s.count || m.second !in "ABCD") {
                bad++
                continue
            }
            s = s.copy(key = s.key.toMutableList().also { it[m.first - 1] = m.second })
            applied++
        }
        onUpdate(s)
        keyBulkMsg = "已填入 $applied 条" + (if (bad > 0) "，跳过无效行 $bad 行" else "")
        keyBulk = ""
    }

    /// 导入一题：在会话文件夹里生成占位条目（题干待补），批改记录写进解析
    fun importOne(i: Int, base: PracticeSheet): PracticeSheet {
        val folder = if (base.folderName.isEmpty()) null else store.findOrCreateFolder(base.folderName, null)
        val record = when (base.verdict(i)) {
            "wrong" -> "我选 ${base.mine[i] ?: "未作答"}，正确答案 ${base.key[i] ?: "未对"}"
            "blank" -> "未作答，正确答案 ${base.key[i] ?: "未对"}"
            else -> "答对（标记 ⭐ 导入）"
        }
        store.addMistake(
            Mistake(
                folderIds = folder?.let { listOf(it.id) } ?: emptyList(),
                question = listOf(Block.Text(newId(), "第 ${i + 1} 题（做题导入，待补充题目内容）")),
                analysis = listOf(Block.Text(newId(), "做题批改（${formatTime(nowMs())}）：$record。")),
            )
        )
        return base.copy(imported = base.imported.toMutableList().also { it[i] = true })
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            ) {
                TextButton(onClick = onExit) { Text("退出") } // 会话保留，可从设置页继续
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                when (phase) {
                    PracticePhase.ANSWER -> {
                        TextButton(onClick = {
                            onUpdate(sheet)
                            phase = PracticePhase.KEY
                        }) { Text("完成作答 →") }
                    }
                    PracticePhase.KEY -> {
                        TextButton(onClick = { phase = PracticePhase.ANSWER }) { Text("← 返回作答") }
                    }
                    PracticePhase.RESULT -> {}
                }
            }

            when (phase) {
                PracticePhase.ANSWER -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Button(
                            onClick = {
                                onUpdate(sheet)
                                phase = PracticePhase.KEY
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("完成作答，去对答案 →") }
                        Text(
                            "已答 ${sheet.mine.count { it != null }} / ${sheet.count} 题；⭐ = 值得导入错题本",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        (0 until sheet.count).forEach { i ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Text(
                                    "${i + 1}",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.width(34.dp),
                                )
                                OptRow(value = sheet.mine[i]) { o ->
                                    onUpdate(sheet.copy(mine = sheet.mine.toMutableList().also { it[i] = if (sheet.mine[i] == o) null else o }))
                                }
                                Spacer(Modifier.weight(1f))
                                IconButton(onClick = {
                                    onUpdate(sheet.copy(flagged = sheet.flagged.toMutableList().also { it[i] = !it[i] }))
                                }) {
                                    Icon(
                                        if (sheet.flagged[i]) Icons.Filled.Star else Icons.Outlined.Star,
                                        contentDescription = "标记",
                                        tint = if (sheet.flagged[i]) Color(0xFFF9A825) else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(24.dp))
                    }
                }

                PracticePhase.KEY -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Button(
                            onClick = {
                                // 进入结果页时预勾「答错 ∪ 标记⭐」，之后由用户自行增减
                                val sel = (0 until sheet.count).map { sheet.verdict(it) == "wrong" || sheet.flagged[it] }
                                onUpdate(sheet.copy(importSel = sel))
                                phase = PracticePhase.RESULT
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("完成比对 →") }
                        Text(
                            "逐题输入正确答案；已对 ${sheet.key.count { it != null }} / ${sheet.count} 题，没对的按「未比对」处理",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            "批量导入正确答案（每行：题号 + 空格或 Tab + 答案，不分大小写）",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = keyBulk,
                            onValueChange = { keyBulk = it },
                            placeholder = { Text("1 A\n2 C\n3 B") },
                            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            minLines = 3,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(onClick = { importKeyBulk() }, enabled = keyBulk.isNotBlank()) {
                            Text("从文本填入")
                        }
                        if (keyBulkMsg.isNotEmpty()) {
                            Text(keyBulkMsg, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        (0 until sheet.count).forEach { i ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Text(
                                    "${i + 1}",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.width(34.dp),
                                )
                                OptRow(value = sheet.key[i]) { o ->
                                    onUpdate(sheet.copy(key = sheet.key.toMutableList().also { it[i] = o }))
                                }
                                Spacer(Modifier.weight(1f))
                                val m = sheet.mine[i]
                                if (m != null) {
                                    Text(
                                        "我选 $m",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = when {
                                            m == sheet.key[i] -> Color(0xFF2E7D32)
                                            sheet.key[i] == null -> MaterialTheme.colorScheme.onSurfaceVariant
                                            else -> Color(0xFFD32F2F)
                                        },
                                    )
                                } else {
                                    Text("未答", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                                }
                            }
                        }
                        Spacer(Modifier.height(24.dp))
                    }
                }

                PracticePhase.RESULT -> {
                    val st = sheet.stats
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text("✓ ${st[0]}", color = Color(0xFF2E7D32), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                            Text("✕ ${st[1]}", color = Color(0xFFD32F2F), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                            Text(
                                "未答 ${st[2]} · 未比对 ${st[3]}",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (st[0] + st[1] > 0) {
                                Text(
                                    "正确率 ${st[0] * 100 / (st[0] + st[1])}%",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = Color(0xFF2563AF),
                                )
                            }
                        }
                        val checked = (0 until sheet.count).filter { sheet.importSel[it] && !sheet.imported[it] }
                        if (checked.isNotEmpty()) {
                            Button(
                                onClick = {
                                    var s = sheet
                                    for (i in checked) s = importOne(i, s)
                                    onUpdate(s)
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text("导入勾选的 ${checked.size} 题") }
                        }
                        Button(
                            onClick = {
                                val s = sheet
                                val c = (0 until s.count).filter { s.importSel[it] && !s.imported[it] }
                                if (c.isEmpty()) return@Button
                                store.addPendingImport(
                                    PendingImport(
                                        folderName = s.folderName,
                                        createdAt = nowMs(),
                                        total = s.count,
                                        entries = c.map { i ->
                                            PendingImportEntry(no = i + 1, mine = s.mine[i], key = s.key[i], flagged = s.flagged[i])
                                        },
                                    )
                                )
                                onFinish()
                                onExit()
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("存为待导入清单（推送后在电脑导入）") }
                        OutlinedButton(
                            onClick = {
                                onFinish()
                                onExit()
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("再来一组（结束本次）") }

                        Text(
                            "是否导入错题本（答错 / 标记 ⭐ 默认勾选，可自行调整）",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (sheet.suggest.isEmpty()) {
                            Text("没有候选题——全对且没有标记 ⭐ 👏", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        sheet.suggest.forEach { i ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    if (sheet.imported[i] || sheet.importSel[i]) Icons.Filled.CheckCircle else Icons.Filled.Close,
                                    contentDescription = null,
                                    tint = if (sheet.imported[i]) Color(0xFF2E7D32) else MaterialTheme.colorScheme.primary,
                                    modifier = Modifier
                                        .size(22.dp)
                                        .clickable(enabled = !sheet.imported[i]) {
                                            onUpdate(sheet.copy(importSel = sheet.importSel.toMutableList().also { it[i] = !it[i] }))
                                        },
                                )
                                Text(
                                    "${i + 1}",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.width(30.dp),
                                )
                                Text(verdictText(sheet, i), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                                if (sheet.imported[i]) {
                                    Text("已导入 ✓", style = MaterialTheme.typography.labelSmall, color = Color(0xFF2E7D32))
                                }
                            }
                        }

                        Text("全部题目", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        (0 until sheet.count).chunked(6).forEach { rowIdx ->
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                                rowIdx.forEach { i ->
                                    val v = sheet.verdict(i)
                                    Box(
                                        contentAlignment = Alignment.Center,
                                        modifier = Modifier
                                            .weight(1f)
                                            .height(26.dp)
                                            .clip(RoundedCornerShape(7.dp))
                                            .background(practiceCellBg(v)),
                                    ) {
                                        Text("${i + 1}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = practiceCellFg(v))
                                    }
                                }
                                repeat(6 - rowIdx.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                        Spacer(Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}

private fun verdictText(sheet: PracticeSheet, i: Int): String = when (sheet.verdict(i)) {
    "wrong" -> "我选 ${sheet.mine[i] ?: "—"} ✕ · 正确 ${sheet.key[i] ?: "—"}"
    "blank" -> "未作答 · 正确 ${sheet.key[i] ?: "—"}"
    else -> "答对 ✓" + (if (sheet.flagged[i]) " · 标记 ⭐" else "")
}

/** 结果网格单元格配色 */
private fun practiceCellBg(v: String): Color = when (v) {
    "correct" -> Color(0xFF2E7D32).copy(alpha = 0.15f)
    "wrong" -> Color(0xFFD32F2F).copy(alpha = 0.15f)
    else -> Color(0xFF777777).copy(alpha = 0.15f)
}

private fun practiceCellFg(v: String): Color = when (v) {
    "correct" -> Color(0xFF2E7D32)
    "wrong" -> Color(0xFFD32F2F)
    else -> Color(0xFF777777)
}

// MARK: A/B/C/D 选项排

@Composable
private fun OptRow(value: String?, onPick: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        listOf("A", "B", "C", "D").forEach { o ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .width(32.dp)
                    .height(28.dp)
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (value == o) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
                    .clickable { onPick(o) },
            ) {
                Text(
                    o,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = if (value == o) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// MARK: 批量答案解析

/** 从「12<Tab>A」这样的行里取题号与大写字母（全角字母/数字先转半角） */
fun firstIntAndLetter(line: String): Pair<Int, String>? {
    var nText = ""
    val rest = StringBuilder(halfWidth(line))
    var i = 0
    while (i < rest.length && rest[i].isDigit()) {
        nText += rest[i]
        i++
    }
    val n = nText.toIntOrNull() ?: return null
    if (n <= 0) return null
    // 跳过分隔符（任意空白（含全角空格）/中英文逗号/顿号/句点/中英文冒号）
    while (i < rest.length) {
        val f = rest[i]
        if (f.isWhitespace() || f == ',' || f == '，' || f == '、' || f == '.' || f == ':' || f == '：') i++ else break
    }
    if (i >= rest.length) return null
    val o = rest[i]
    if (o !in "ABCDabcd") return null
    return n to o.uppercase()
}

/** 全角字母/数字（！–～）转半角：中文输入法打出的 ａ/Ａ/１ 也能解析 */
fun halfWidth(line: String): String = buildString {
    for (c in line) {
        val v = c.code
        append(if (v in 0xFF01..0xFF5E) (v - 0xFEE0).toChar() else c)
    }
}
