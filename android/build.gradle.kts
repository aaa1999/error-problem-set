// Android 端（原生 Kotlin + Jetpack Compose），与桌面端 / iOS 端数据格式完全互通。
// 版本组合按 2025 年中稳定线选取：AGP 8.13 + Gradle 8.14 + Kotlin 2.2。
plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.20" apply false
}
