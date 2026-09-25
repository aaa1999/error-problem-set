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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import kotlinx.coroutines.launch

// MARK: - 同步（推送 / 按设备拉取）（对应桌面端 SyncDialog、iOS 端 SyncView.swift）
// 推送：整库增量上传到本设备在服务端的槽位；
// 拉取：全部设备各自落盘到 devices/（不合并），错题本顶栏按设备切换只读浏览。

@Composable
fun SyncView(onClose: () -> Unit) {
    val store = LocalBookStore.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val db by store.db.collectAsState()
    val remoteDevices by store.remoteDevices.collectAsState()

    var pushMode by remember { mutableStateOf(true) } // true = 推送 false = 按设备拉取
    androidx.activity.compose.BackHandler(onBack = onClose)
    var addr by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var rememberAddr by remember { mutableStateOf(false) }
    var engine by remember { mutableStateOf<SyncEngine?>(null) }
    var busy by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<SyncProgress?>(null) }
    var resultText by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf("") }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        SyncStore.load(context)?.let { s ->
            addr = s.server
            token = s.token ?: ""
            rememberAddr = true
        }
    }

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
        progress = null
    }

    fun run() {
        resetOutputs()
        val target = resolveTarget() ?: return
        val e = SyncEngine(context)
        engine = e
        busy = true
        scope.launch {
            try {
                if (pushMode) {
                    val r = e.push(target, store.db.value, store.dataDir) { p -> progress = p }
                    rememberTarget(target)
                    val parts = mutableListOf("上传图片 ${r.uploadedAssets}/${r.totalAssets} 张（其余服务器已有，跳过）")
                    if (r.missingLocal > 0) parts.add("${r.missingLocal} 张本地文件缺失已跳过")
                    resultText = "同步完成：${parts.joinToString("，")}；${r.mistakes} 道错题、${r.notes} 篇笔记、${r.folders} 个文件夹已推送到本设备的版本。"
                } else {
                    val r = e.pullDevices(target, store.dataDir) { p -> progress = p }
                    rememberTarget(target)
                    store.reloadRemoteDevices()
                    if (r.onlySelf) {
                        resultText = "服务器上还没有其他设备的数据（本机自己的推送不会重复拉取）。"
                    } else {
                        val parts = r.pulled.map { "${it.name}（${it.mistakes} 题 / ${it.notes} 笔记）" }
                        val extras = mutableListOf<String>()
                        if (r.downloadedAssets > 0) extras.add("下载图片 ${r.downloadedAssets} 张")
                        if (r.missingAssets > 0) extras.add("${r.missingAssets} 张图片服务端缺失已跳过")
                        resultText =
                            "拉取完成：${r.pulled.size} 台设备已保存到本地（${parts.joinToString("、")}）" +
                                (if (extras.isEmpty()) "" else "，${extras.joinToString("，")}") +
                                "。在错题本顶栏按 设备 → 文件夹 浏览；本机数据未做任何改动。"
                    }
                }
            } catch (e2: SyncAborted) {
                errorMessage = "已中止：重新同步会自动续上（已完成的保留）。"
            } catch (e2: Exception) {
                errorMessage = e2.message ?: "同步失败"
            }
            busy = false
            progress = null
        }
    }

    fun phaseText(p: SyncProgress): String = when (p.phase) {
        0 -> if (pushMode) "正在连接服务器、获取清单…" else "正在连接服务器、获取设备清单…"
        3 -> {
            val cur = p.current?.take(20) ?: ""
            "正在拉取设备数据 ${minOf(p.done + 1, maxOf(p.total, 1))}/${p.total}（$cur…）"
        }
        1 -> {
            val cur = p.current?.take(16) ?: ""
            val label = if (pushMode) "上传" else "下载"
            "正在${label}图片 ${minOf(p.done + 1, maxOf(p.total, 1))}/${p.total}（$cur…）"
        }
        else -> if (pushMode) "正在推送题库数据（data.json）…" else "拉取完成。"
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
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (busy) "隐藏" else "取消")
                }
                Text("☁ 同步", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (busy) {
                    TextButton(onClick = { engine?.abort() }) { Text("中止") }
                } else if (resultText.isEmpty()) {
                    Button(onClick = { run() }, enabled = addr.isNotBlank()) {
                        Text(if (pushMode) "开始同步" else "拉取全部设备")
                    }
                } else {
                    Button(onClick = { run() }) { Text(if (pushMode) "再次同步" else "再次拉取") }
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
                ) { Text("⬇ 按设备拉取") }
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
                    "推送 ${db.mistakes.size} 道错题、${db.notes.size} 篇笔记及引用的 ${collectLibraryAssets(db).size} 张图片。推送只覆盖本设备（${DeviceIdentity.name()}）在服务器上的版本，其他设备推送的数据不受影响。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "拉取服务器上全部设备各自推送的整库，每台设备单独保存到本机的 devices/ 目录，不与本机数据合并；之后在错题本顶栏按 设备 → 文件夹 只读浏览、可复制。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (remoteDevices.isNotEmpty()) {
                        Text(
                            "本地已有 ${remoteDevices.size} 台设备的快照：${remoteDevices.joinToString("、") { it.name }}，重新拉取即刷新。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
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
