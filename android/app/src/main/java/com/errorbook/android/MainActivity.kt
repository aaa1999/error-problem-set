package com.errorbook.android

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.isSystemInDarkTheme

// MARK: - 应用入口（对应 iOS 端 App.swift：四个一级 tab：错题本 / 笔记 / 做题 / 设置）

class ErrorBookApp : Application() {
    lateinit var store: BookStore

    override fun onCreate() {
        super.onCreate()
        store = BookStore(this)
    }
}

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 截图/自动化验证用：am start 传 --es tab book|notes|practice|settings 可指定初始页
        val startTab = intent?.getStringExtra("tab")
        setContent {
            val app = applicationContext as ErrorBookApp
            ErrorBookTheme {
                CompositionLocalProvider(LocalBookStore provides app.store) {
                    MainScreen(startTab)
                }
            }
        }
    }
}

@Composable
fun ErrorBookTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colorScheme = if (dark) {
        darkColorScheme(primary = Color(0xFF8FB8E8))
    } else {
        lightColorScheme(primary = Color(0xFF2563AF))
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}

private val tabs = listOf("错题本", "笔记", "做题", "设置")
private val tabIcons = listOf(
    Icons.AutoMirrored.Filled.MenuBook,
    Icons.AutoMirrored.Filled.Notes,
    Icons.Filled.Create,
    Icons.Filled.Settings,
)

@Composable
private fun MainScreen(startTab: String? = null) {
    var tab by rememberSaveable {
        mutableIntStateOf(
            when (startTab) {
                "notes" -> 1
                "practice" -> 2
                "settings" -> 3
                else -> 0
            }
        )
    }
    var batchOpen by remember { mutableStateOf(false) }
    var syncOpen by remember { mutableStateOf(false) }

    // movableContent：切 tab 保留各页状态（筛选、做题会话、编辑中途内容）
    val browseTab = remember { movableContentOf { BrowseTab(openSync = { syncOpen = true }, openBatchImport = { batchOpen = true }) } }
    val notesTab = remember { movableContentOf { NotesTab() } }
    val practiceTab = remember { movableContentOf { PracticeTab() } }
    val settingsTab = remember { movableContentOf { SettingsView(onOpenSync = { syncOpen = true }) } }

    Surface(modifier = Modifier.fillMaxSize()) {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    tabs.forEachIndexed { i, label ->
                        NavigationBarItem(
                            selected = tab == i,
                            onClick = { tab = i },
                            icon = { Icon(tabIcons[i], contentDescription = label) },
                            label = { Text(label) },
                        )
                    }
                }
            },
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                when (tab) {
                    0 -> browseTab()
                    1 -> notesTab()
                    2 -> practiceTab()
                    else -> settingsTab()
                }

                if (batchOpen) {
                    BatchImportOverlay(onClose = { batchOpen = false })
                }
                if (syncOpen) {
                    SyncView(onClose = { syncOpen = false })
                }
            }
        }
    }
}
