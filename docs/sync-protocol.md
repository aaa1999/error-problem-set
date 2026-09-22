# 错题本远程同步协议（v1）

桌面端「☁ 同步」功能使用的服务端接口规范。服务端只需实现下面 **3 个 HTTP 端点**，即可接收错题本的推送（错题、笔记、文件夹与图片）。

- 客户端实现：`src/lib/sync.ts`（桌面端）
- 协议版本：v1（随错题本 v0.7.0 发布）

## 设计要点（为什么是这 3 个端点）

- 错题本的图片以**内容哈希命名**（`assets/<sha1>.<ext>`），文件名即指纹，因此不需要打 zip 包：
  客户端先问服务端「你已有哪些图片」，只上传缺的，天然增量、幂等、可断点续传（重跑自动跳过已传）。
- `data.json` 是整库 JSON（错题 + 文件夹 + 笔记），体积通常只有几 KB，每次**全量覆盖推送**，最后推送为准。
- 服务端落盘后就是一个合法的错题本数据目录（`data.json` + `assets/`），可直接被桌面端「合并导入」消费，
  也为将来做「从远程拉取合并」留好了底。

## 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | 用户在客户端填的 `http://<ip>:<port>`，所有端点都挂在根路径的 `/sync/` 前缀下 |
| 方法与体 | 全部为 `GET`（无请求体）或 `PUT`（请求体为原始字节 / JSON 文本） |
| 字符编码 | 请求体、响应体均为 UTF-8 |
| 鉴权（可选） | 若启用，客户端会在**每个请求**带上 `X-Sync-Token: <令牌>` 头；校验失败返回 `401` 或 `403` |
| 成功状态码 | `200` 或 `204`，响应体不要求（客户端只看状态码，manifest 除外） |

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

## 客户端行为时序（供服务端理解负载形态）

```
1. GET  /sync/manifest                     ← 每次同步 1 次
2. PUT /sync/asset/<name>                  ← 0..N 次，仅上传 manifest 里没有的图片
   （逐张串行上传，图片之间可能被用户中止；中止后重新同步会从 manifest 续传）
3. PUT  /sync/data                         ← 每次同步 1 次，最后执行
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
curl http://192.168.1.100:8080/sync/manifest

# 带令牌
curl -H "X-Sync-Token: my-secret" http://192.168.1.100:8080/sync/manifest

# 上传一张图片
curl -X PUT --data-binary @./assets/3a5f...e2.png \
     -H "Content-Type: application/octet-stream" \
     http://192.168.1.100:8080/sync/asset/3a5f...e2.png

# 推送整份库
curl -X PUT --data-binary @./data.json \
     -H "Content-Type: application/json" \
     http://192.168.1.100:8080/sync/data
```

## 参考实现

官方 Python 实现（标准库、零依赖、可直接部署）见 **[backend/sync_server.py](../backend/sync_server.py)**，
部署与常驻运行说明（systemd/nohup）见 [backend/README.md](../backend/README.md)。
该实现额外提供 `GET /` 状态页（返回服务信息与已同步统计，便于浏览器确认服务在跑），不属于协议必需部分。

## 版本与兼容

- v1（错题本 ≥ v0.7.0）：`/sync/manifest`、`/sync/asset/<name>`、`/sync/data`。
- 客户端对 manifest 里的附加字段、PUT 的响应体均忽略，服务端可自由扩展。
- 后续若增加「从远程拉取合并」，将以新端点（如 `GET /sync/data`）形式追加，不破坏 v1。
