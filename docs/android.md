# Android 版错题本（原生 Kotlin + Jetpack Compose）

`android/` 目录是错题本的原生 Android 应用，与桌面版（Tauri）、iOS 版**数据格式完全互通**：

- 同一份 `data.json`（schema v3：错题 / 文件夹 / 笔记 / 预建标签 / 待导入清单）+ `assets/` 内容哈希图片 + `snapshots/` 滚动备份
- 同一套远程同步协议（推送到自建 Python 服务端 + 拉取合并，见 `docs/sync-protocol.md`）
- 图片按内容 SHA-1 哈希命名，各端互相导入自动去重

## 功能对照

| 功能 | 桌面版 | iOS 版 | Android 版 |
| --- | --- | --- | --- |
| 浏览翻页（文件夹 + 标签筛选、解析遮罩） | ✅ | ✅ | ✅（左右滑动翻页；时间/错误率/随机排列） |
| 选择题作答与错误率 | ✅ | ✅ | ✅（录入填选项标答案，浏览点选作答计错误率，按错误率排序复习） |
| 做题答题卡（外部刷题 → 批改 → 导入错题本） | ✅ | ✅ | ✅（文件夹名 + 题数 1–100，A/B/C/D 作答、⭐ 标记、对答案、一键导入、存待导入清单） |
| 一键复制整道题（含图片富文本） | ✅ 浏览页「复制」 | ✅ | ✅ 卡片菜单（纯文本 + HTML 双分量剪贴板） |
| 录入/编辑错题（文字 + 图片块、标签、多文件夹） | ✅ | ✅ | ✅（相册选图，编辑自动保存） |
| 批量导入截图 | 文件夹/多选文件 | ✅ | ✅ 相册多选 + 「文件」选文件夹（SAF 递归扫描、按源结构镜像建夹） |
| 笔记（Markdown） | ✅ | ✅ | ✅（编辑 + 预览 + 工具栏 + 插图） |
| 笔记（Word 富文本） | ✅ 编辑 | 只读 | 只读（编辑请回桌面端） |
| 导出 PDF | 位图切片（文字不可选） | ✅ 原生分页（文字可选中） | ✅ 系统打印框架（A4 分页、文字可选中，「保存为 PDF」） |
| 导出 Word | MHTML .doc | ✅ 同格式 | ✅ 同格式 MHTML .doc |
| 远程同步（推送 + 拉取合并） | ✅ | ✅ | ✅（同一服务端，协议 v2，局域网明文 http 已放行） |
| 数据目录合并导入 | ✅ | ✅ | ✅（「文件」里选目录，向下自动识别两层） |
| 文件夹管理 | 侧栏 | ✅ 设置 → 文件夹管理 | ✅ 设置 → 文件夹管理 |
| 预建标签（不挂错题也保留） | ✅ 侧栏「＋ 新建」 | ✅ 标签菜单「新建标签…」 | ✅ 标签菜单「＋ 新建标签…」 |
| 更换数据目录 | ✅ | ❌ | ❌（固定为 App 外部私有目录，见下） |

## 开发与构建

推荐 Android Studio（自带 JDK 与 SDK 管理，打开 `android/` 目录即可运行）。命令行构建需要 JDK 17 与 Android SDK（platform 36），并配置 `local.properties` 的 `sdk.dir` 或环境变量 `ANDROID_HOME`：

```bash
cd android
./gradlew assembleDebug     # 依赖自动下载
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release 构建（个人自用未开混淆）：

```bash
./gradlew assembleRelease   # 产物在 app/build/outputs/apk/release/
adb install -r app/build/outputs/apk/release/app-release-unsigned.apk
```

截图/自动化验证技巧：`adb shell am start -n com.errorbook.android/.MainActivity --es tab notes`
（`--es tab book|notes|practice|settings` 指定初始页，对应 iOS 的 `-tab` 启动参数）。

## 数据在 Android 端的位置

App 数据目录固定为外部私有存储（免存储权限、无需弹窗）：

```
/storage/emulated/0/Android/data/com.errorbook.android/files/错题本/
├── data.json
├── assets/
└── snapshots/
```

- **USB 连电脑（MTP 文件传输）**：在电脑的文件管理器里展开 `Android/data/com.errorbook.android/files/` 即见 `错题本` 文件夹，可直接与桌面版数据目录互拷
- **本机「文件」App**：部分系统限制直接访问 `Android/data`，跨 App 拷贝请走 USB 或下面的合并导入
- 卸载 App 即删除该目录（与 iOS 沙盒同语义），重要数据记得定期 USB 拷出或同步到自建服务端

### 桌面数据迁到 Android（三种方式任选）

1. **USB 整目录拷贝**：把桌面版的数据目录（data.json + assets）整个拷进上面位置（合并可用方式 2）
2. **App 内合并导入**：设置 → 从数据目录合并导入，在「文件」选择器里选中拷到手机的数据目录（选到上一级也能识别，向下扫两层），按 id 去重、可重复执行
3. **同步服务端**：桌面端推送到自建服务端后，Android 端 ☁ 同步 → 拉取合并（换新手机恢复数据也用它）

## 已知边界

- Word 富文本笔记 Android 端只读（渲染正常、可导出），富文本编辑请用桌面端
- 数据目录固定为 App 外部私有目录，不能像桌面一样把数据放在任意目录/网盘
- 导出 PDF 走系统打印面板（选「保存为 PDF」或直接打印），与 iOS 分享面板送出文件的形式略有差异
- 局域网自建服务的明文 http 已放行（`usesCleartextTraffic`），公网使用请自行上 https 或令牌
- 笔记摘要、自然排序等细节行为与桌面端 / iOS 端对齐（三端口径一致）
