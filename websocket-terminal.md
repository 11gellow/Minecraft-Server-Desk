# Linux 网页终端 WebSocket

## 握手

- 默认地址 `ws://127.0.0.1:51865/api/terminal`。面板通过 HTTPS 访问时，前端使用同一主机和端口的 `wss://`。
- 使用标准 HTTP/1.1 WebSocket 升级。请求目标必须严格等于 `/api/terminal`，包括查询字符串在内的其他形式会被拒绝。
- 必须提供 `Origin`。使用默认地址时，`Host` 为 `127.0.0.1:51865`，`Origin` 为 `http://127.0.0.1:51865`。面板检查 `Host` 是否在允许列表内，且 `Origin` 的协议必须为 `http` 或 `https`，其主机与端口须按该协议的默认端口规则与 `Host` 匹配。
- 单个面板进程最多同时接受 4 个终端连接。握手不要求 `X-MC-Panel`，前端也不指定 WebSocket 子协议。
- 成功时返回 `101 Switching Protocols`。路径、Host、Origin 或连接数校验失败时返回 `403 Forbidden`，响应正文为空。进入 WebSocket 库的握手校验后，非法升级头、密钥或版本等会返回 `400 Bad Request`；升级请求方法不为 GET 时返回 `405 Method Not Allowed`。

以下仅展示握手格式。`Sec-WebSocket-Key` 由客户端为每次握手生成。

```http
GET /api/terminal HTTP/1.1
Host: 127.0.0.1:51865
Origin: http://127.0.0.1:51865
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
```

## 消息

客户端发送 UTF-8 JSON 文本消息。单条入站消息上限为 64 KiB（65536 字节）。前端连接后立即发送一条 `resize`，窗口尺寸变化时继续发送。

| `type` | 必填字段 | 行为 |
| --- | --- | --- |
| `input` | `data`，字符串 | 写入 PTY 的原始输入。包含普通文本、控制序列或回车。客户端直接发送字符串，Base64 转换只发生在服务端内部。 |
| `resize` | `cols` 和 `rows`，均为 1 到 1000 的整数 | 调整 PTY 的列数和行数。 |

```json
{"type":"resize","cols":120,"rows":40}
```

```json
{"type":"input","data":"pwd\r"}
```

服务端发送 **二进制帧**，内容是 PTY 的原始输出字节，可含 ANSI 控制序列或分段的字符。前端以 `ArrayBuffer` 接收并把字节交给 xterm.js。输出与用户输入的消息没有一一对应关系。无效 JSON、未知消息类型和无效字段会被忽略，服务端无需返回确认消息。

## 关闭

| 关闭码 | 触发条件 |
| --- | --- |
| `1008` | 服务端为该连接缓冲的待发送数据超过 1 MiB，关闭原因 `Terminal output overloaded`。 |
| `1009` | 入站消息超过 WebSocket 库设置的 64 KiB 上限。 |
| `1011` | 服务端无法启动终端子进程，关闭原因 `Could not start terminal`。 |
| `1012` | 面板更换监听端口，旧监听上的连接被关闭，关闭原因 `Port changed`。 |

终端子进程退出或其标准输入报错时，服务端主动关闭连接，未指定应用关闭码。客户端断开后，服务端关闭终端子进程的标准输入。

所有 JSON HTTP API 见 [OpenAPI 3.0.3 YAML](openapi.yaml)。
