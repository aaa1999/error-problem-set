# 错题本

单机跨平台错题本：题目 + 解析一一对应，支持图文混排，一页一题翻页复习。完全离线，数据全部存在本地文件夹。

技术栈：Tauri 2 + React + TypeScript + Vite。设计文档见 [DESIGN.md](./DESIGN.md)。

## 运行与打包

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 开发模式（热更新）
npm run tauri build  # 打包安装包（macOS .app/.dmg、Windows .msi/.exe、Linux .deb/AppImage）
```

打包产物在 `src-tauri/target/release/bundle/` 下。

前置要求：Node.js ≥ 18，Rust 工具链（`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）。

### 在 Windows 上编译

前置环境：

1. [Node.js ≥ 18](https://nodejs.org/)
2. [Rust（MSVC 工具链）](https://rustup.rs/)——默认 `stable-x86_64-pc-windows-msvc`
3. [Visual Studio 生成工具](https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/)，勾选「使用 C++ 的桌面开发」
4. WebView2 运行时（Win10/11 一般自带）

然后同样执行 `npm install && npm run tauri build`，产物在 `src-tauri/target/release/bundle/` 下：

- `nsis/错题本_0.x.x_x64-setup.exe`——**推荐**。默认安装到用户目录（如 `C:\Users\你\AppData\Local\Programs\错题本`），目录可写，首次启动可选「使用安装目录」的便携模式
- `msi/错题本_0.x.x_x64_en-US.msi`——默认装进 `Program Files`，该目录不可写，数据目录请选文档目录或其他位置

## 功能（M1 + v0.2）

- **录入**：题目、解析各一个图文混排编辑区，标签随手打；**可插入任意多张图片**，按插入顺序排列（悬停图片可 ↑↓ 调整顺序、✕ 删除）
- **图片四通道导入**：剪贴板粘贴截图（支持一次多张）· 拖拽文件 · 📎 系统文件对话框（多选，按选择顺序）· 路径框输入（支持一次多个路径，逗号/换行分隔）；在访达里复制图片文件后直接 Cmd+V 也能导入
- **批量导入**：选一个文件夹（**连同子文件夹递归扫描**），按文件名自然排序，每张图可选「题目图（新错题）」或「解析图 ↩（并入同文件夹上一题）」；默认在目标文件夹下**按源文件夹结构自动创建同名子文件夹**（也可每组手动指定目标），统一打标签后一次导入
- **翻页浏览**：一页一题，解析默认遮罩（先想再看），左右键/触屏滑动翻页，图片点击放大
- **文件夹管理**：浏览页左侧侧栏，多层文件夹树（新建/重命名/删除/新建子文件夹），按文件夹浏览（含子文件夹），当前题可一键「移动」
- **多标签**：一道错题可打多个标签；侧栏按标签多选筛选（取交集）
- **编辑已有错题**时停止输入约 1 秒自动保存

## 快捷键（浏览模式）

| 按键 | 功能 |
|------|------|
| `←` / `→` | 上一题 / 下一题 |
| `空格` | 显示 / 隐藏解析 |
| `E` | 编辑当前题 |
| `N` | 新增错题 |
| `Ctrl/⌘ + Enter`（录入模式） | 保存 |

## 数据目录

首次启动选择一个文件夹作为数据目录——**Windows 默认推荐安装目录下的 `data` 文件夹（便携模式，程序文件夹拷走即备份）**，也可选文档目录 `~/Documents/错题本/` 或任意自定义位置；macOS 默认文档目录。顶栏可随时更换。目录结构：

```
数据目录/
├── data.json      # 全部错题（文字内容 + 图片引用）
├── assets/        # 图片文件，按内容哈希命名，自动去重
└── snapshots/     # data.json 的历史快照，保留最近 20 份
```

- **备份 = 拷贝整个文件夹**；放进 iCloud/OneDrive 等同步盘即可多设备共用
- 保存采用原子写入（临时文件 + 替换），断电不会写坏 data.json
- 删除错题后如需找回，可从 snapshots 里恢复旧版 data.json
- 顶栏「更换目录」可切换到另一份数据

## 说明

- 图片一律**拷贝**进数据目录（不引用原路径），原图移动/删除不影响错题本
- 纯个人单机工具，fs/asset 权限放开到了全盘（`**`）；介意的话可收紧 `src-tauri/capabilities/default.json` 里的 scope
- 后续规划（见 DESIGN.md）：M2 管理列表/搜索/导出，M3 间隔重复复习
