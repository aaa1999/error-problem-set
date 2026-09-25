# iOS 版错题本（原生 SwiftUI）

`ios/` 目录是错题本的原生 iOS 应用，与桌面版（Tauri）**数据格式完全互通**：

- 同一份 `data.json`（schema v3：错题 / 文件夹 / 笔记 / 预建标签）+ `assets/` 内容哈希图片 + `snapshots/` 滚动备份
- 同一套远程同步协议（推送到自建 Python 服务端 + 按设备拉取只读浏览，见 `docs/sync-protocol.md`）
- 图片按内容 SHA-1 哈希命名，两个端互相导入自动去重

## 功能对照

| 功能 | 桌面版 | iOS 版 |
| --- | --- | --- |
| 浏览翻页（文件夹 + 标签筛选、解析遮罩） | ✅ | ✅（左右滑动翻页；时间/错误率/随机排列） |
| 选择题作答与错误率 | ✅ | ✅（录入填选项标答案，浏览点选作答计错误率，按错误率排序复习） |
| 做题答题卡（外部刷题 → 批改 → 导入错题本） | ✅ | ✅（文件夹名 + 题数 1–100，A/B/C/D 作答、⭐ 标记、对答案、一键导入） |
| 一键复制整道题（含图片富文本） | ✅ 浏览页「复制」 | ✅ 卡片菜单「复制全部内容」 |
| 录入/编辑错题（文字 + 图片块、标签、文件夹） | ✅ | ✅（相册选图，编辑自动保存） |
| 批量导入截图 | 文件夹/多选文件 | ✅ 相册多选 + 「文件」App 选文件夹（含子目录镜像建夹） |
| 笔记（Markdown） | ✅ | ✅（编辑 + 预览 + 工具栏 + 插图） |
| 笔记（Word 富文本） | ✅ 编辑 | 只读查看（编辑请回桌面端） |
| 导出 PDF | 位图切片（文字不可选） | ✅ 原生分页渲染（**文字可选中**），分享面板送出 |
| 导出 Word | MHTML .doc | ✅ 同格式 MHTML .doc |
| 远程同步（推送 + 按设备拉取只读浏览） | ✅ | ✅（同一服务端，协议 v3 多设备，局域网 http 已放行） |
| 数据目录合并导入 | ✅ | ✅（「文件」App 里选目录，向下自动识别两层） |
| 文件夹管理 | 侧栏 | ✅ 设置 → 文件夹管理 |
| 预建标签（不挂错题也保留） | ✅ 侧栏「＋ 新建」 | ✅ 浏览页标签菜单「新建标签…」 |
| 更换数据目录 | ✅ | ❌ 固定为 App 沙盒 Documents/错题本（iOS 限制） |

## 开发与构建

```bash
cd ios
xcodegen generate          # 由 project.yml 生成 ErrorBook.xcodeproj（仓库已含生成结果，改配置后才需要重跑）
open ErrorBook.xcodeproj   # Xcode 里选 iPhone 模拟器 Cmd+R

# 或命令行构建 + 装进已启动的模拟器
xcodebuild -project ErrorBook.xcodeproj -scheme ErrorBook \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
xcrun simctl install booted build/DerivedData/Build/Products/Debug-iphonesimulator/错题本.app
xcrun simctl launch booted com.errorbook.ios
```

截图验证技巧：`xcrun simctl launch booted com.errorbook.ios -tab notes`（`-tab book|notes|settings` 指定初始页）。

## 数据在 iOS 端的位置

App 数据目录固定为沙盒内 `Documents/错题本`（`data.json` + `assets/` + `snapshots/`）。已开启
`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`：

- **本机**：「文件」App → 我的 iPhone → 错题本 → 错题本
- **电脑**：Finder / iTunes → 设备 → 文件共享 → 错题本

### 桌面数据迁到 iPhone（两种方式任选）

1. **整目录拷贝**：把桌面版的数据目录（data.json + assets）整个拷进上面位置（合并则用 App 内
   设置 → 合并导入，按 id 去重，可重复执行）。
2. **同步服务端**：桌面端推送到自建服务端后……注意：当前协议只有**推送**没有拉取，iOS 端也
   只能推送。跨设备取回数据请用方式 1。

## 真机部署（个人自用，免开发者账号）

1. 用数据线连接 iPhone，Xcode 打开 `ios/ErrorBook.xcodeproj`
2. Signing & Capabilities → Team 选自己的 Apple ID（没有就 Add Account，免费个人账号即可）
3. 修改 Bundle Identifier 为唯一值（如 `com.你的名字.errorbook`），选真机 Cmd+R
4. 首次运行后到 设置 → 通用 → VPN与设备管理 里信任开发者证书

免费个人签名的限制：**证书 7 天过期**，过期后 App 无法打开，需要重新连 Xcode 运行一次；
每台设备最多 3 个自签 App。长期使用建议注册 Apple Developer（$99/年）或 TestFlight 分发。

> 上架 App Store 前需要另行收紧安全配置（CSP、`NSAllowsArbitraryLoads` 改为按需域名例外等），
> 目前按「个人自用 + 自有服务器明文 HTTP」设计。

## 已知边界

- Word 富文本笔记 iOS 端只读（渲染正常、可导出），富文本编辑请用桌面端
- iOS 端数据目录固定在沙盒内，不能像桌面一样把数据放在任意目录/网盘
- 笔记摘要、自然排序等细节行为与桌面端对齐（包括 markdown 摘要保留行内标记的显示习惯）
