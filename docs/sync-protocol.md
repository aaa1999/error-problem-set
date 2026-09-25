# 错题本远程同步协议（v2）

桌面端 / iOS 端 / Android 端「☁ 同步」功能使用的服务端接口规范。服务端只需实现下面 **5 个 HTTP 端点**，即可支持错题本的**推送**与**拉取**（错题、笔记、文件夹、预建标签与图片）。

- 客户端实现：`src/lib/sync.ts`（桌面端）、`ios/ErrorBook/SyncEngine.swift`（iOS 端）、`android/app/src/main/java/com/errorbook/android/SyncEngine.kt`（Android 端）
- 协议版本：v1（错题本 v0.7.0，推送 3 端点）；v2（追加拉取 2 端点，向后兼容）

## 设计要点（为什么是这几个端点）

- 错题本的图片以**内容哈希命名**（`assets/<sha1>.<ext>`），文件名即指纹，因此不需要打 zip 包：
  推送时客户端先问服务端「你已有哪些图片」，只上传缺的；拉取时只下载本地缺的——天然增量、幂等、可断点续传（重跑自动跳过）。
- `data.json` 是整库 JSON（错题 + 文件夹 + 笔记 + 预建标签），体积通常只有几 KB：推送**全量覆盖**（最后推送为准）；拉取后客户端做**幂等合并**（错题/笔记按 id 去重、文件夹按名称+父级、预建标签并入），**不会覆盖或删除本地已有数据**。
- 服务端落盘后就是一个合法的错题本数据目录（`data.json` + `assets/`），可直接被桌面端「合并导入」消费。

## 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | 用户在客户端填的 `http://<ip>:<port>`，所有端点都挂在根路径的 `/sync/` 前缀下 |
| 方法与体 | `GET`（无请求体）或 `PUT`（请求体为原始字节 / JSON 文本） |
| 字符编码 | 请求体、响应体均为 UTF-8 |
| 鉴权（可选） | 若启用，客户端会在**每个请求**带上 `X-Sync-Token: <令牌>` 头；校验失败返回 `401` 或 `403` |
| 成功状态码 | `200` 或 `204`；响应体不要求（manifest、GET /sync/data 除外） |

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
- 保存为 `<数据目录>/assets/<name>`；**同名覆盖写是正常情况**（内容哈希一致，幂等），建议原子写（先写临时文件再 rename）。

**错误**：令牌不符 `401/403`；文件名不合法建议 `400`。

### 3. `PUT /sync/data` — 推送整份题库

客户端在所有缺失图片上传完成后调用，**最后执行**。

**请求**

```http
PUT /sync/data
Content-Type: application/json
X-Sync-Token: <令牌>        （可选）

{ "version": 3, "mistakes": [...], "folders": [...], "notes": [...] }
```

请求体即桌面端磁盘上 `data.json` 的完整内容（UTF-8 JSON 文本，`JSON.stringify(db, null, 2)` 格式），
顶层结构为 `{ version: 3, mistakes: Mistake[], folders: Folder[], notes: Note[] }`，
其中错题/笔记的图片引用均指向 `assets/<name>`（即端点 2 上传的文件）。

**响应**：成功 `200` 或 `204`。

服务端要求：

- **先校验 JSON 可解析**再落盘（避免半截传输覆盖掉好数据）；
- 保存为 `<数据目录>/data.json`，覆盖式，最后推送为准；建议原子写（tmp + rename）。

**错误**：令牌不符 `401/403`；JSON 解析失败建议 `400`。

### 4. `GET /sync/data` — 拉取整份题库（v2 追加）

拉取合并的第一步：客户端取回整库 JSON，在本地算差量（新增的错题/笔记/文件夹/标签、缺的图片）并给用户确认预览。

**请求**

```http
GET /sync/data
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/json`）：`data.json` 的完整内容，结构同端点 3 的请求体。

**错误**：

- 令牌不符 `401/403`；
- 服务端尚无数据（还没被推送过）`404`，客户端据此提示「请先从任意一端推送」；也用于客户端识别「服务端版本过旧、未实现拉取」。

服务端要求：直接返回 `<数据目录>/data.json` 的字节即可，无需加工。

### 5. `GET /sync/asset/{name}` — 下载一张图片（v2 追加）

**请求**

```http
GET /sync/asset/3a5f...e2.png
X-Sync-Token: <令牌>        （可选）
```

**响应 `200`**（`Content-Type: application/octet-stream`）：图片文件的原始字节。

服务端要求：

- 文件名校验同端点 2（`^[A-Za-z0-9_-]{6,64}\.(png|jpe?g|webp|gif|bmp|avif)$`，防路径穿越）；
- 文件不存在返回 `404`——客户端**不视为错误**，保留引用、跳过该图继续合并（与合并导入对缺失源图的口径一致）。

**错误**：令牌不符 `401/403`；文件名不合法 `400/404`；文件不存在 `404`。

## 服务端实现建议（v2）

以下非协议强制，但参考实现（backend/sync_server.py）均已内置，自建服务端建议照做：

- **快照**：`PUT /sync/data` 覆盖前把旧 `data.json` 拷进 `snapshots/`（保留最近 20 份）——误推送/坏数据不致丢失上一版，可手工恢复
- **请求体上限**：对 PUT 请求体设大小上限（参考实现默认 64MB，`--max-body-mb` 可调），超限 `413` 拒收，防滥用
- **缓存协商（可选）**：`GET /sync/data` 响应带 `ETag`（内容哈希），`GET /sync/asset` 以文件名（即内容哈希）为强 ETag；客户端带 `If-None-Match` 命中时回 `304` 无正文。也支持 `HEAD`（同 GET 头、无正文）供探活
- **原子写**：所有落盘先写临时文件再 rename，传输中断不会写坏已有文件

## 客户端行为时序（供服务端理解负载形态）

推送：

```
1. GET  /sync/manifest                     ← 每次推送 1 次
2. PUT  /sync/asset/<name>                 ← 0..N 次，仅上传 manifest 里没有的图片
   （逐张串行上传，图片之间可能被用户中止；中止后重新同步会从 manifest 续传）
3. PUT  /sync/data                         ← 每次推送 1 次，最后执行
```

拉取（v2）：

```
1. GET  /sync/data                         ← 每次拉取 1 次（客户端本地算差量，供用户确认预览）
2. GET  /sync/asset/<name>                 ← 0..N 次，仅下载本地缺的图片
   （逐张串行下载，图片之间可能被用户中止；已下载的保留，重新拉取自动续上）
3. 合并在客户端本地完成（错题/笔记按 id 去重、文件夹按「名称+父级」、预建标签并入），
   服务端无感知——拉取不会修改服务端任何数据
```

## 存储布局建议

```
<服务端数据目录>/
  data.json          # 端点 3 的落盘，整库 JSON
  assets/
    <hash>.<ext>     # 端点 2 的落盘，按内容哈希命名
```

该布局与桌面端本地数据目录完全一致——把目录拷回 U 盘即可被「合并导入」直接使用。
服务端可自行周期性清理 `data.json` 中未被引用的 `assets` 文件（客户端不会主动删除远端文件）。

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

# 推送整份库
curl -X PUT --data-binary @./data.json \
     -H "Content-Type: application/json" \
     http://192.168.1.100:8081/sync/data

# 拉取整份库（v2）
curl -H "X-Sync-Token: my-secret" http://192.168.1.100:8081/sync/data

# 下载一张图片（v2）
curl -H "X-Sync-Token: my-secret" -o ./3a5f...e2.png \
     http://192.168.1.100:8081/sync/asset/3a5f...e2.png
```

## 参考实现

官方 Python 实现（标准库、零依赖、可直接部署）见 **[backend/sync_server.py](../backend/sync_server.py)**，
部署与常驻运行说明（systemd/nohup）见 [backend/README.md](../backend/README.md)。
该实现额外提供 `GET /` 状态页（返回服务信息与已同步统计，便于浏览器确认服务在跑），不属于协议必需部分。

## 版本与兼容

- v1（错题本 ≥ v0.7.0）：`/sync/manifest`、`PUT /sync/asset/<name>`、`PUT /sync/data`。
- v2（错题本 ≥ v0.8）：追加 `GET /sync/data`、`GET /sync/asset/<name>`（拉取合并）。纯追加，v1 服务端照常工作（客户端拉取时收到 404 会提示服务端版本过旧）。
- 客户端对 manifest 里的附加字段、PUT 的响应体均忽略，服务端可自由扩展。
