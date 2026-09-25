# 错题本远程同步协议（v3）

桌面端 / iOS 端 / Android 端「☁ 同步」功能使用的服务端接口规范。服务端只需实现下面 **7 个 HTTP 端点**，即可支持错题本的**推送**与**按设备拉取**（错题、笔记、文件夹、预建标签、做题清单与图片）。

- 客户端实现：`src/lib/sync.ts`（桌面端）、`ios/ErrorBook/SyncEngine.swift`（iOS 端）、`android/app/src/main/java/com/errorbook/android/SyncEngine.kt`（Android 端）
- 协议版本：v1（错题本 v0.7.0，推送 3 端点）；v2（v0.8，追加拉取 2 端点）；v3（追加**多设备**模型：按设备分槽推送 + 按设备拉取 + 设备清单，v2 的合并拉取端点保留作兼容）

## v3 多设备模型（核心）

多台设备共用一个服务端时**互不合并、互不覆盖**：

- **推送按设备分槽**：服务端为每个设备各存一份 `devices/<设备id>/data.json`。一次 `PUT /sync/data` 只覆盖**该设备自己的最新版本**，不动其他设备的槽位。
- **拉取按设备分开**：客户端先 `GET /sync/devices` 拿设备清单，再逐台 `GET /sync/data?device=<id>` 取**该设备的原始整库**（不做任何合并），各自落到本地 `<数据目录>/devices/<id>/`。浏览时按 设备 → 文件夹 组织，远程设备**只读**。
- **设备标识只跟物理设备有关，重装 App 不变**：iOS 存钥匙串（卸载重装不清除）、Android 用 `ANDROID_ID`（重装稳定）、桌面端存应用数据目录文件。id 形如 `ios-<uuid>` / `android-<16位hex>` / `desktop-<16位hex>`，全局不冲突。
- 本机自己的数据永远只在本机的 `data.json`（录入/编辑/做题/推送都作用于它）；推送=覆盖本机槽位，拉取=刷新其他设备的本地快照，两者都不改本机库。

### 各设备数据怎么「合起来看」

不合并。所有设备的数据都拉到本地后，浏览界面按「设备 → 该设备的文件夹树」逐台查看（桌面端在侧栏「远程设备」，iOS/Android 在顶栏设备菜单切换）；图片共用一个 `assets/`（内容哈希命名，天然无冲突）。想把某台设备的数据并入本机库，用既有的「合并导入」选 `devices/<设备id>/` 目录（幂等、只增不删）。

## 设计要点（为什么是这几个端点）

- 错题本的图片以**内容哈希命名**（`assets/<sha1>.<ext>`），文件名即指纹，因此不需要打 zip 包：
  推送时客户端先问服务端「你已有哪些图片」，只上传缺的；拉取时只下载本地缺的——天然增量、幂等、可断点续传（重跑自动跳过）。
- `data.json` 是整库 JSON（错题 + 文件夹 + 笔记 + 预建标签 + 做题清单），体积通常只有几 KB：推送**整库覆盖本设备的槽位**；拉取**按设备原样落盘**。
- 兼容：v2 客户端用的合并拉取端点（`GET /sync/data` 返回全部设备合并视图）保留；v3 服务端每次推送后还会把合并结果物化到数据目录根部 `data.json`，整个目录仍是合法的错题本数据目录。

## 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | 用户在客户端填的 `http://<ip>:<port>`，所有端点都挂在根路径的 `/sync/` 前缀下 |
| 方法与体 | `GET`（无请求体）或 `PUT`（请求体为原始字节 / JSON 文本） |
| 字符编码 | 请求体、响应体均为 UTF-8 |
| 鉴权（可选） | 若启用，客户端会在**每个请求**带上 `X-Sync-Token: <令牌>` 头；校验失败返回 `401` 或 `403` |
| 设备头（v3） | `PUT /sync/data` 应带 `X-Device-Id: <^[A-Za-z0-9_-]{1,64}$>`（客户端持久化的设备标识，重装 App 不变）；可带 `X-Device-Name`（**URL 编码**后的设备名，HTTP 头放不了中文），服务端解码后展示在状态页。缺 `X-Device-Id` 时服务端按 `default` 槽位处理（旧客户端兼容） |
| 成功状态码 | `200` 或 `204`；响应体不要求（manifest、设备清单、GET /sync/data 除外） |

## 端点

### 1. `GET /sync/manifest` — 服务端已有图片清单

客户端同步的第一步，用于差量计算。**也是客户端判断「这个地址是不是错题同步服务」的探针**：
连接成功但返回 404 或响应不是 `{ assets: [...] }` 时，客户端会报「该地址不是错题同步服务端」。

**请求**

```http
GET /sync/manifest
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/json`）

```json
{
  "assets": ["3a5f...e2.png", "9c1d...ab.jpg"]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `assets` | `string[]` | 服务端已保存的全部图片文件名（含扩展名）。没有任何图片时为 `[]`，字段不能缺 |

- 数组元素是文件名字符串，顺序无关，客户端只做集合差运算。
- 可以附加其他字段（如 `version`、统计数），客户端会忽略。

**错误**：令牌不符 `401/403`；未实现该路径 `404`。

### 2. `PUT /sync/asset/{name}` — 上传一张图片

**请求**

```http
PUT /sync/asset/3a5f...e2.png
Content-Type: application/octet-stream
X-Sync-Token: <令牌>        （可选）

<图片原始字节>
```

| 项 | 说明 |
| --- | --- |
| `{name}` | 图片文件名，形如 `<40位十六进制哈希>.<ext>`，`ext ∈ png / jpg / jpeg / webp / gif / bmp / avif` |
| 请求体 | 图片文件的原始字节（不是 base64、不是 multipart） |

**响应**：成功 `200` 或 `204`。

服务端要求：

- **必须校验文件名**，仅接受 `^[A-Za-z0-9_-]{6,64}\.(png|jpe?g|webp|gif|bmp|avif)$` 一类的合法格式，防止路径穿越（`../`、绝对路径等）。
- 保存为 `<数据目录>/assets/<name>`（所有设备共用，内容哈希全局唯一）；**同名覆盖写是正常情况**（内容哈希一致，幂等），建议原子写（先写临时文件再 rename）。

**错误**：令牌不符 `401/403`；文件名不合法建议 `400`。

### 3. `PUT /sync/data` — 推送整份题库到本设备的槽位

客户端在所有缺失图片上传完成后调用，**最后执行**。

**请求**

```http
PUT /sync/data
Content-Type: application/json
X-Sync-Token: <令牌>        （可选）
X-Device-Id: android-a1b2c3d4e5f60718
X-Device-Name: %E6%A1%8C%E9%9D%A2%E7%AB%AF   （可选，URL 编码的设备名）

{ "version": 3, "mistakes": [...], "folders": [...], "notes": [...] }
```

请求体即桌面端磁盘上 `data.json` 的完整内容（UTF-8 JSON 文本），
顶层结构为 `{ version: 3, mistakes: Mistake[], folders: Folder[], notes: Note[], tags: string[], pendingImports: PendingImport[] }`，
其中错题/笔记的图片引用均指向 `assets/<name>`（即端点 2 上传的文件）。

**响应**：成功 `200` 或 `204`。参考实现额外返回 `{ ok, device, merged: { mistakes, notes, folders, devices } }`（合并视图的规模统计），客户端忽略。

服务端要求：

- **只覆盖该设备自己的槽位** `devices/<设备id>/data.json`，不得影响其他设备的槽位；
- **先校验 JSON 可解析**再落盘（避免半截传输覆盖掉好数据）；
- 建议原子写（tmp + rename）；覆盖该设备旧版前自动快照（参考实现保留最近 10 份）。

**错误**：令牌不符 `401/403`；JSON 解析失败 / `X-Device-Id` 含非法字符 `400`。

### 4. `GET /sync/devices` — 设备清单（v3，按设备拉取的第一步）

**请求**

```http
GET /sync/devices
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/json`）

```json
{
  "devices": [
    { "id": "desktop-9f2a...", "name": "Mac·9f2a", "lastPush": "2026-09-25 13:42:25",
      "mistakes": 120, "notes": 5, "folders": 8, "tags": 3 },
    { "id": "android-a1b2...", "name": "Pixel 7", "lastPush": "...", "mistakes": 45, "notes": 1, "folders": 3, "tags": 0 }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `devices` | `object[]` | 全部已推送过的设备，**最近推送的在前** |
| `id` | `string` | 设备标识（客户端持久化、重装不变） |
| `name` | `string` | 设备名（推送时 `X-Device-Name` 解码而来；缺省为 id） |
| `lastPush` | `string` | 该设备最后推送时间（服务端本地时区） |
| `mistakes/notes/folders/tags` | `number` | 该设备槽位的规模统计 |

客户端拿到清单后**跳过本机自己的 id**，逐台调用端点 5。

**错误**：令牌不符 `401/403`；v2 服务端未实现该路径返回 `404`，客户端据此提示「服务端版本过旧，请升级到协议 v3」。

### 5. `GET /sync/data?device=<id>` — 拉取指定设备的原始整库（v3）

**请求**

```http
GET /sync/data?device=desktop-9f2a...
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/json`）：该设备槽位 `data.json` 的原始字节，**不做任何合并**。带 `ETag`（内容哈希），支持 `If-None-Match` → `304` 与 `HEAD`。

服务端要求：

- `device` 参数必须通过设备 id 白名单校验（`^[A-Za-z0-9_-]{1,64}$`，防路径穿越），非法 `400`；
- 设备不存在或尚未推送过 `404`（清单与槽位竞态时客户端跳过该设备）。

### 6. `GET /sync/data` — 拉取全部设备合并后的整库（v2 兼容）

v2 客户端与整库备份用：返回全部设备槽位按合并规则（错题/笔记按 id 取 `updatedAt` 最新、文件夹按「名称+父级」路径合并并重映射、标签/做题清单并集）合并后的整库。v3 客户端不使用该端点。

- 服务端尚无任何数据 `404`；
- 参考实现同时把该合并结果物化到数据目录根部 `data.json`（每次推送后刷新），因此整个数据目录仍是合法的错题本数据目录。

### 7. `GET /sync/asset/{name}` — 下载一张图片

**请求**

```http
GET /sync/asset/3a5f...e2.png
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/octet-stream`）：图片文件的原始字节。拉取设备库后，客户端把各设备引用到而本地缺的图片下到**主 `assets/`**（内容哈希命名，各设备共用，天然去重）。

服务端要求：

- 文件名校验同端点 2；
- 文件不存在返回 `404`——客户端**不视为错误**，保留引用、跳过该图继续（与合并导入对缺失源图的口径一致）。

**错误**：令牌不符 `401/403`；文件名不合法 `400/404`；文件不存在 `404`。

## 服务端实现建议（v3）

以下非协议强制，但参考实现（backend/sync_server.py）均已内置，自建服务端建议照做：

- **每设备快照**：`PUT /sync/data` 覆盖前把该设备的旧版拷进 `devices/<id>/snapshots/`（参考实现保留最近 10 份）
- **请求体上限**：对 PUT 请求体设大小上限（参考实现默认 64MB，`--max-body-mb` 可调），超限 `413` 拒收
- **缓存协商（可选）**：`GET /sync/data`（含 `?device=`）响应带 `ETag`（内容哈希），`GET /sync/asset` 以文件名（即内容哈希）为强 ETag；`If-None-Match` 命中回 `304`。也支持 `HEAD`
- **原子写**：所有落盘先写临时文件再 rename，传输中断不会写坏已有文件
- **v2 布局迁移**：旧版单文件 `data.json` 在服务端启动时自动挪进 `devices/default/`，旧客户端（无设备头）的后续推送也落同槽，数据不分裂

## 客户端行为时序（供服务端理解负载形态）

推送：

```
1. GET  /sync/manifest                     ← 每次推送 1 次
2. PUT  /sync/asset/<name>                 ← 0..N 次，仅上传 manifest 里没有的图片
3. PUT  /sync/data                         ← 每次推送 1 次，最后执行（带 X-Device-Id/Name 头）
```

拉取（v3，按设备）：

```
1. GET  /sync/manifest                     ← 每次拉取 1 次（探针 + 图片清单）
2. GET  /sync/devices                      ← 每次拉取 1 次（跳过本机 id）
3. GET  /sync/data?device=<id>             ← 0..N 次，每台其他设备 1 次，原样落到 devices/<id>/
   （逐台串行，设备之间可能被用户中止；已落盘的保留，重新拉取自动续上）
4. GET  /sync/asset/<name>                 ← 0..N 次，仅下载本地缺的图片到主 assets/
5. 本机 data.json 不动；浏览按 设备 → 文件夹，远程设备只读
```

## 存储布局

```
<服务端数据目录>/
  data.json                  # 合并结果的物化副本（v2 兼容视图；可直接被「合并导入」消费）
  devices/
    <设备id>/
      data.json              # 该设备最近一次推送（端点 3 的落盘 / 端点 5 的数据源）
      meta.json              # { name, lastPush, pushCount }（设备名/最后推送时间）
      snapshots/             # 该设备覆盖前的旧版快照（保留最近 10 份）
    default/                 # 未带 X-Device-Id 的旧客户端（v1/v2）的槽位
  assets/
    <hash>.<ext>             # 全部设备共用的图片（按内容哈希命名，幂等覆盖）

<客户端数据目录>/
  data.json + assets/        # 本机库（录入/编辑/做题/推送的唯一对象）+ 共用图片池
  devices/
    <设备id>/
      data.json              # 拉取下来的该设备整库快照（只读浏览）
      device.json            # { id, name, pulledAt }（本地展示名）
```

服务端可自行周期性清理（根 `data.json` 合并结果中未被引用的）`assets` 文件（客户端不会主动删除远端文件）。

## curl 示例

```bash
# 查看服务端已有图片
curl http://192.168.1.100:8081/sync/manifest

# 带令牌
curl -H "X-Sync-Token: my-secret" http://192.168.1.100:8081/sync/manifest

# 上传一张图片
curl -X PUT --data-binary @./assets/3a5f...e2.png \
     -H "Content-Type: application/octet-stream" \
     http://192.168.1.100:8081/sync/asset/3a5f...e2.png

# 推送整份库到本设备的槽位（v3：设备头）
curl -X PUT --data-binary @./data.json \
     -H "Content-Type: application/json" \
     -H "X-Device-Id: desktop-a3f1c9e0" \
     -H "X-Device-Name: %E6%A1%8C%E9%9D%A2%E7%AB%AF" \
     http://192.168.1.100:8081/sync/data

# 设备清单（v3）
curl -H "X-Sync-Token: my-secret" http://192.168.1.100:8081/sync/devices

# 拉取指定设备的原始整库（v3，不合并）
curl -H "X-Sync-Token: my-secret" \
     "http://192.168.1.100:8081/sync/data?device=desktop-a3f1c9e0"

# 拉取全部设备合并视图（v2 兼容）
curl -H "X-Sync-Token: my-secret" http://192.168.1.100:8081/sync/data

# 下载一张图片
curl -H "X-Sync-Token: my-secret" -o ./3a5f...e2.png \
     http://192.168.1.100:8081/sync/asset/3a5f...e2.png
```

## 参考实现

官方 Python 实现（标准库、零依赖、可直接部署）见 **[backend/sync_server.py](../backend/sync_server.py)**，
部署与常驻运行说明（systemd/nohup）见 [backend/README.md](../backend/README.md)，
多设备分槽 / 设备清单 / 按设备拉取 / 旧版迁移的单元测试见 [backend/test_sync_server.py](../backend/test_sync_server.py)（`python3 -m unittest test_sync_server`）。
该实现额外提供 `GET /` 状态页（返回合并统计与**设备清单**：每台设备的名称、最后推送时间、规模，便于浏览器确认服务在跑），不属于协议必需部分。

## 版本与兼容

- v1（错题本 ≥ v0.7.0）：`/sync/manifest`、`PUT /sync/asset/<name>`、`PUT /sync/data`。
- v2（错题本 ≥ v0.8）：追加 `GET /sync/data`、`GET /sync/asset/<name>`（拉取合并）。
- v3（错题本 ≥ v0.9）：多设备模型——`PUT /sync/data` 带设备头分槽存储、追加 `GET /sync/devices` 与 `GET /sync/data?device=<id>`（按设备拉取，客户端不合并）。v2 端点全部保留：
  - v3 客户端 + v2 服务端：推送照常（但无设备头会落 `default` 槽，多设备互相覆盖）；按设备拉取报「服务端版本过旧」；
  - v1/v2 客户端 + v3 服务端：照常工作——推送落 `default` 槽，合并拉取拿到的是含全部设备数据的合并视图。
- 客户端对 manifest 里的附加字段、PUT 的响应体均忽略，服务端可自由扩展。
