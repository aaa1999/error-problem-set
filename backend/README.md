# 错题本同步后端（backend/）

桌面端 / iOS 端 / Android 端「☁ 同步」的服务端，**Python 3.8+ 标准库实现，零第三方依赖**，单文件 `sync_server.py`，克隆到任意服务器/NAS/树莓派即可跑。

接口协议规范（v3：按设备分槽推送 + 全设备合并拉取、状态码、令牌、curl 示例）见 [../docs/sync-protocol.md](../docs/sync-protocol.md)。

## 多设备模型（v3）

多台设备（桌面 + iPhone + Android）共用一个服务端时**互不合并、互不覆盖**：

- **推送分槽**：每台设备在服务端各有一个槽位（`devices/<设备id>/data.json`），一次推送只覆盖**本设备**的最新版本；设备 id 由客户端持久化且**重装 App 不变**（iOS 钥匙串 / Android `ANDROID_ID` / 桌面应用数据目录）；
- **按设备拉取**：客户端 `GET /sync/devices` 拿清单后逐台 `GET /sync/data?device=<id>` 取该设备原始整库，落到本地 `devices/<id>/` 各自保存，浏览按 设备 → 文件夹（远程只读），**不与本机数据合并**；
- **v2 兼容**：`GET /sync/data` 仍返回全部设备的合并视图（错题/笔记按 id 取 `updatedAt` 最新、文件夹按路径合并），供旧客户端与整库备份使用；旧版客户端（无设备头）推送一律落 `default` 槽位；旧版单文件布局首次启动时自动迁移。

## 快速开始

```bash
python3 sync_server.py --dir /srv/errorbook --port 8081
# 建议加令牌（局域网内其他设备将无法匿名推送/读取）：
python3 sync_server.py --dir /srv/errorbook --port 8081 --token 我的秘钥
```

启动后会打印本机内网 IP，桌面端「☁ 同步」弹窗里填 `IP:端口`（如 `192.168.1.100:8081`），勾选「记住此地址」即可；令牌填在「访问令牌」输入框。

浏览器打开 `http://IP:端口/` 可看到状态页（协议版本、**设备清单**——每台设备的名称/最后推送时间/规模、合并后的总统计），用于确认服务在跑。

## 自测

```bash
python3 -m unittest test_sync_server -v     # 多设备分槽 / 设备清单 / 按设备拉取 / 旧版迁移 / ETag / 令牌等 20 个用例
```

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--dir` | （必填） | 数据落盘目录，生成 `devices/ + assets/ + data.json`（合并结果物化副本） |
| `--host` | `0.0.0.0` | 监听地址；只允许本机访问可改 `127.0.0.1` |
| `--port` | `8081` | 监听端口 |
| `--token` | 空 | 访问令牌，校验请求头 `X-Sync-Token`；也可用环境变量 `SYNC_TOKEN`。留空 = 不验证 |
| `--max-body-mb` | `64` | 单个请求体大小上限（MB），超限 `413` 拒收 |

## 数据落盘与备份

```
<--dir>/
├── data.json              # 合并结果的物化副本（每次推送后刷新；整个目录因此仍是合法的
│                          #   错题本数据目录，可拷走被桌面端「合并导入」直接消费）
├── devices/
│   ├── <设备id>/
│   │   ├── data.json      # 该设备最近一次推送
│   │   ├── meta.json      # 设备名 / 最后推送时间 / 推送次数
│   │   └── snapshots/     # 该设备被覆盖前的旧版快照（保留最近 10 份，可手工恢复）
│   └── default/           # 未带设备头的旧客户端（v1/v2）槽位
└── assets/                # 全部设备共用，图片按内容哈希命名，同名覆盖幂等
```

- 写入均为**原子写**（临时文件 + rename），传输中断不会写坏已有文件
- 收到的 data.json 会先做 JSON 校验，非法内容直接拒收；**覆盖前自动快照该设备旧版**（保留最近 10 份），误推送也能找回上一版
- `GET /sync/data`、`GET /sync/asset/<name>` 支持 `ETag` + `If-None-Match`（命中回 `304`）与 `HEAD`，反复拉取省流量
- 单个请求体默认上限 64MB（`--max-body-mb` 可调），超限 `413` 拒收
- **备份 = 拷贝整个 `--dir` 目录**；U 盘拷走后可被桌面端「合并导入」直接消费
- 服务端不会删除文件；若想清理已不被引用的图片，可自行定期对照根 `data.json`（合并结果）清理 `assets/`
- 从 v1/v2 的单文件布局升级：启动时检测到旧的根 `data.json` 且尚无 `devices/`，会自动把它挪进 `devices/default/`，数据不丢、不分裂

## 常驻部署

### systemd（Linux 服务器，开机自启）

`/etc/systemd/system/errorbook-sync.service`：

```ini
[Unit]
Description=Errorbook sync server
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/errorbook-backend/sync_server.py --dir /srv/errorbook --port 8081 --token 我的秘钥
Restart=always
RestartSec=3
# 加固（可选）
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/errorbook

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now errorbook-sync
journalctl -u errorbook-sync -f     # 看日志（每次同步/上传都有记录）
```

### macOS / 临时跑

```bash
nohup python3 sync_server.py --dir ~/errorbook-backup --port 8081 >> sync.log 2>&1 &
tail -f sync.log
```

## 安全说明

- 纯 HTTP 明文传输，**面向可信局域网/个人服务器设计**；需要公网暴露请置于反向代理（TLS）之后，或用 wireguard/ssh 隧道
- 令牌是明文等值比较的简易门禁（防局域网误写），不是强认证；公网场景务必配合 TLS
- 图片文件名与设备 id 均按白名单严格校验（`哈希.扩展名` / `^[A-Za-z0-9_-]{1,64}$`），无路径穿越风险
