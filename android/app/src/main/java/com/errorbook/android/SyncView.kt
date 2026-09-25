package com.errorbook.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// MARK: - 同步（推送 / 拉取）（对应桌面端 SyncDialog、iOS 端 SyncView.swift）
// 推送：整库增量上传；拉取：取远端整库 → 预览差量 → 幂等并入本地（不覆盖、不删除本地数据）。

@Composable
fun SyncView(onClose: () -> Unit) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val db by store.db.collectAsState()

    var pushMode by remember { mutableStateOf(true) } // true = 推送 false = 拉取
    androidx.activity.compose.BackHandler(onBack = onClose)
    var addr by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var rememberAddr by remember { mutableStateOf(false) }
    var engine by remember { mutableStateOf<SyncEngine?>(null) }
    var busy by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<SyncProgress?>(null) }
    var resultText by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf("") }
    // 拉取两步走：先取远端库算差量给用户确认，再执行合并
    var pullPlan by remember { mutableStateOf<MergePlan?>(null) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        SyncStore.load(context)?.let { s ->
            addr = s.server
            token = s.token ?: ""
            rememberAddr = true
        }
    }

    val pullNothingNew = pullPlan?.let { p ->
        p.newMistakes.isEmpty() && p.newNotes.isEmpty() && p.newTags.isEmpty() && p.imageKeys.isEmpty()
    } ?: false

    fun resolveTarget(): SyncTarget? {
        val server = normalizeServerAddr(addr) ?: run {
            errorMessage = "服务器地址无效。示例：192.168.1.100:8080（缺 http:// 前缀会自动补上）"
            return null
        }
        addr = server
        return SyncTarget(server, token.trim().ifEmpty { null })
    }

    fun rememberTarget(t: SyncTarget) {
        if (rememberAddr) SyncStore.save(context, t) else SyncStore.clear(context)
    }

    fun resetOutputs() {
        errorMessage = ""
        resultText = ""
        pullPlan = null
        progress = null
    }

    fun runPush() {
        resetOutputs()
        val target = resolveTarget() ?: return
        val e = SyncEngine()
        engine = e
        busy = true
        scope.launch {
            try {
                val r = e.push(target, store.db.value, store.dataDir) { p -> progress = p }
                rememberTarget(target)
                val parts = mutableListOf("上传图片 ${r.uploadedAssets}/${r.totalAssets} 张（其余服务器已有，跳过）")
                if (r.missingLocal > 0) parts.add("${r.missingLocal} 张本地文件缺失已跳过")
                resultText = "同步完成：${parts.joinToString("，")}；${r.mistakes} 道错题、${r.notes} 篇笔记、${r.folders} 个文件夹已推送。"
            } catch (e2: SyncAborted) {
                errorMessage = "已中止：本次已上传 ${e2.uploaded} 张图片，重新同步会自动续传。"
            } catch (e2: Exception) {
                errorMessage = e2.message ?: "同步失败"
            }
            busy = false
            progress = null
        }
    }

    fun runPullCheck() {
        resetOutputs()
        val target = resolveTarget() ?: return
        val e = SyncEngine()
        engine = e
        busy = true
        scope.launch {
            try {
                pullPlan = e.pullPlan(target, store.db.value) { p -> progress = p }
            } catch (e2: Exception) {
                errorMessage = e2.message ?: "拉取失败"
            }
            busy = false
            progress = null
        }
    }

    fun runPullMerge(plan: MergePlan) {
        errorMessage = ""
        val target = resolveTarget() ?: return
        val e = SyncEngine()
        engine = e
        busy = true
        scope.launch {
            try {
                val r = e.pull(target, plan, store) { p -> progress = p }
                rememberTarget(target)
                resultText = "${mergeOutcomeText(plan, r.outcome)}本次下载图片 ${r.downloadedAssets} 张。"
                pullPlan = null
            } catch (e2: MergeAborted) {
                errorMessage = "已中止：已下载 ${e2.fetched} 张图片，重新拉取会自动续上。"
            } catch (e2: Exception) {
                errorMessage = e2.message ?: "拉取失败"
            }
            busy = false
            progress = null
        }
    }

    fun phaseText(p: SyncProgress): String = when (p.phase) {
        0 -> if (pushMode) "正在连接服务器、获取清单…" else "正在连接服务器、拉取题库数据…"
        1 -> {
            val cur = p.current?.take(16) ?: ""
            val label = if (pushMode) "上传" else "下载"
            "正在${label}图片 ${minOf(p.done + 1, maxOf(p.total, 1))}/${p.total}（$cur…）"
        }
        else -> if (pushMode) "正在推送题库数据（data.json）…" else "正在并入本地库…"
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (busy) "隐藏" else "取消")
                }
                Text("☁ 同步", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (busy) {
                    TextButton(onClick = { engine?.abort() }) { Text("中止") }
                } else if (pushMode) {
                    if (resultText.isEmpty()) {
                        Button(onClick = { runPush() }, enabled = addr.isNotBlank()) { Text("开始同步") }
                    } else {
                        Button(onClick = { runPush() }) { Text("再次同步") }
                    }
                } else {
                    val p = pullPlan
                    when {
                        p != null && pullNothingNew -> TextButton(onClick = { runPullCheck() }) { Text("重新检查") }
                        p != null -> Button(onClick = { runPullMerge(p) }) { Text("开始合并") }
                        resultText.isEmpty() -> Button(onClick = { runPullCheck() }, enabled = addr.isNotBlank()) { Text("检查并预览") }
                        else -> Button(onClick = { runPullCheck() }) { Text("再次拉取") }
                    }
                }
            }

            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = pushMode,
                    onClick = { if (!busy) { pushMode = true; resetOutputs() } },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                ) { Text("⬈ 推送") }
                SegmentedButton(
                    selected = !pushMode,
                    onClick = { if (!busy) { pushMode = false; resetOutputs() } },
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                ) { Text("⬇ 拉取") }
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("服务器", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = addr,
                    onValueChange = { addr = it },
                    placeholder = { Text("例如 192.168.1.100:8080") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    placeholder = { Text("访问令牌（可选）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.Checkbox(checked = rememberAddr, onCheckedChange = { rememberAddr = it })
                    Text("记住此地址", style = MaterialTheme.typography.bodySmall)
                }
            }

            if (pushMode) {
                Text(
                    "推送 ${db.mistakes.size} 道错题、${db.notes.size} 篇笔记及引用的 ${collectLibraryAssets(db).size} 张图片；服务器已有的图片自动跳过，可随时重复同步。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                val p = pullPlan
                if (p != null) {
                    Text(
                        if (pullNothingNew) {
                            "服务器数据已全部在本地，无需合并。"
                        } else {
                            "服务器上有 ${p.source.mistakes.size} 道错题、${p.source.notes.size} 篇笔记、${p.source.folders.size} 个文件夹：将合并新增 ${p.newMistakes.size} 道错题、${p.newNotes.size} 篇笔记、${p.newTags.size} 个标签（含 ${p.imageCount} 张图片），其余本地已存在自动跳过。合并不会覆盖或删除本地任何数据。"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        "拉取服务器上的整份题库并合并到本地：新增的错题/笔记/文件夹/标签并入，本地已有的自动跳过，缺的图片按内容哈希下载。换新设备恢复数据、或多端互相同步都用它，可随时重复执行。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (busy) {
                progress?.let { p ->
                    LinearProgressIndicator(
                        progress = { (p.done + (if (p.phase == 2) 1 else 0)) / maxOf(p.total + 1, 1).toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(phaseText(p), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (errorMessage.isNotEmpty()) {
                Text(errorMessage, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            if (resultText.isNotEmpty()) {
                Text(resultText, style = MaterialTheme.typography.labelSmall, color = androidx.compose.ui.graphics.Color(0xFF2E7D32))
            }
        }
    }
}
