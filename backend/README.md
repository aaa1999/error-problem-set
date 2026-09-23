# 错题本同步后端（backend/）

桌面端 / iOS 端「☁ 同步」的服务端，**Python 3.8+ 标准库实现，零第三方依赖**，单文件 `sync_server.py`，克隆到任意服务器/NAS/树莓派即可跑。

接口协议规范（v2：推送 3 端点 + 拉取 2 端点、状态码、令牌、curl 示例）见 [../docs/sync-protocol.md](../docs/sync-protocol.md)。客户端「从远程拉取」会把服务端存的整库合并回本地（只增不删），换新设备恢复数据也走这条路。

## 快速开始

```bash
python3 sync_server.py --dir /srv/errorbook --port 8081
# 建议加令牌（局域网内其他设备将无法匿名推送/读取）：
python3 sync_server.py --dir /srv/errorbook --port 8081 --token 我的秘钥
```

启动后会打印本机内网 IP，桌面端「☁ 同步」弹窗里填 `IP:端口`（如 `192.168.1.100:8081`），勾选「记住此地址」即可；令牌填在「访问令牌」输入框。

浏览器打开 `http://IP:端口/` 可看到状态页（协议版本、已同步的题数/笔记数、数据目录），用于确认服务在跑。

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--dir` | （必填） | 数据落盘目录，生成 `data.json + assets/`——本身就是合法的错题本数据目录 |
| `--host` | `0.0.0.0` | 监听地址；只允许本机访问可改 `127.0.0.1` |
| `--port` | `8081` | 监听端口 |
| `--token` | 空 | 访问令牌，校验请求头 `X-Sync-Token`；也可用环境变量 `SYNC_TOKEN`。留空 = 不验证 |
| `--max-body-mb` | `64` | 单个请求体大小上限（MB），超限 `413` 拒收 |

## 数据落盘与备份

```
<--dir>/
├── data.json      # 每次同步整份覆盖（最后推送为准）
├── snapshots/     # data.json 被覆盖前的旧版快照（保留最近 20 份，可手工恢复）
└── assets/        # 图片按内容哈希命名，同名覆盖幂等
```

- 写入均为**原子写**（临时文件 + rename），传输中断不会写坏已有文件
- 收到的 `data.json` 会先做 JSON 校验，非法内容直接拒收；**覆盖前自动快照旧版**进 `snapshots/`（保留最近 20 份），误推送也能找回上一版
- `GET /sync/data`、`GET /sync/asset/<name>` 支持 `ETag` + `If-None-Match`（命中回 `304`）与 `HEAD`，反复拉取省流量
- 单个请求体默认上限 64MB（`--max-body-mb` 可调），超限 `413` 拒收
- **备份 = 拷贝整个 `--dir` 目录**；U 盘拷走后可被桌面端「合并导入」直接消费
- 服务端不会删除文件；若想清理已不被引用的图片，可自行定期对照 data.json 清理 `assets/`

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
- 图片文件名按白名单严格校验（`哈希.扩展名`），无路径穿越风险
