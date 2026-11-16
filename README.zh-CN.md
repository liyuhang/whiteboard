# 局域网互动白板（PC Web + 手机 H5）

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=nodedotjs&logoColor=white">
  <img alt="docker" src="https://img.shields.io/badge/docker--compose-ready-2496ED?logo=docker&logoColor=white">
  <img alt="platform" src="https://img.shields.io/badge/platform-web-lightgrey">
  <img alt="status" src="https://img.shields.io/badge/status-MVP-yellow">
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  教师主导、面向局域网的实时协作白板 —— 教师用 PC 网页端，学生用手机 H5 端。
</p>

---

单进程 Node.js 服务端 + WebSocket 后端 + 原生 Canvas 前端。教师创建房间，学生凭房间号或链接加入，所有成员笔迹实时广播。可用 Docker Compose 一键部署。

> **状态：MVP。** 房间与笔迹仅存于进程内存，服务重启即丢失。正式使用前请看[生产化路线](#生产化路线)。

## 特性

- 🏫 教师创建房间，学生凭房间号 / 分享链接加入
- ✍️ 多人实时绘画（鼠标 / 触摸），笔迹实时广播
- 🎛️ 教师控制：开关学生绘画、撤销最后一笔、清空白板
- 🔌 WebSocket 增量同步、断线自动重连、加入时下发快照
- 📐 归一化 `[0,1]` 坐标，PC 与手机渲染一致
- 🐳 Docker 一键部署
- 🛡️ 单客户端限流、连接数上限、慢消费者保护、路径穿越防护

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [使用方法](#使用方法)
- [配置](#配置)
- [文档](#文档)
- [通信协议](#通信协议)
- [部署与扩容](#部署与扩容)
- [生产化路线](#生产化路线)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

## 快速开始

```bash
# 1. 配置教师密钥
cp .env.example .env          # 然后把 TEACHER_SECRET 改成长随机值

# 2. 运行
npm install && npm start      # http://0.0.0.0:8080

# 3. 验证
curl http://localhost:8080/health
# {"ok":true,"rooms":0,"connections":0,"uptimeSeconds":3}
```

或使用 Docker：

```bash
TEACHER_SECRET=你的长随机密钥 docker compose up -d --build
```

## 安装

| 依赖 | 版本 |
|------|------|
| Node.js | ≥ 20 |
| Docker（可选） | 含 Compose v2 |

运行时依赖仅 `ws`、`dotenv`，无框架。

```bash
npm install
```

## 使用方法

1. 打开**教师端** `http://<host>:8080/`，输入 `TEACHER_SECRET`，点“创建房间”，记下房间号（如 `04DDB7`）。
2. 将房间号或学生链接分享给学生。
3. 学生打开 `http://<host>:8080/mobile.html?room=<房间号>`（或输入房间号）加入。
4. 任一端在画布绘画，笔迹实时同步；教师可开关绘画、撤销、清空。

> 提示：若浏览器自动填充下拉遮挡密钥框，先按 `Esc` 再输入。

## 配置

所有配置从 `.env`（或容器环境变量）读取。

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `TEACHER_SECRET` | `dev-only-change-me` | 创建房间的鉴权密钥（请求头 `X-Teacher-Secret`） |
| `MAX_CONNECTIONS` | `600` | 全局连接数上限 |
| `MAX_POINTS_PER_MESSAGE` | `80` | 单条 `stroke_move` 入库点数上限 |
| `MAX_STROKES_PER_ROOM` | `12000` | 单房间笔迹总数上限 |

> ⚠️ `TEACHER_SECRET` 务必改为长随机值，切勿把真实密钥提交进仓库。

## 文档

| 文档 | 说明 |
|------|------|
| [`代码说明文档.md`](./代码说明文档.md) | 开发者深度文档（中文）：架构、模块、协议、限制、改哪里 |
| [`CODE_DOCUMENTATION.md`](./CODE_DOCUMENTATION.md) | In-depth developer guide (English) |
| [`README.md`](./README.md) | English version of this file |

## 通信协议

WebSocket 端点：`GET /ws?room=<房间号>&role=<teacher|student>&name=<昵称>[&token=<teacherToken>]`。

**客户端 → 服务端：** `ping`、`stroke_start`、`stroke_move`、`stroke_end`、`set_drawing`、`clear`、`undo_last`
**服务端 → 客户端：** `init`、`pong`、`stroke_start`、`stroke_move`、`stroke_end`、`drawing_permission`、`presence`、`clear`、`remove_stroke`、`error`

字段级完整说明与限制参数见[代码说明文档.md](./代码说明文档.md)。

## 部署与扩容

**Docker（推荐）：**

```bash
cp .env.example .env      # 设置 TEACHER_SECRET
docker compose up -d --build
docker compose logs -f
```

确保服务器防火墙放行 **TCP 8080** 入站，且 PC 与手机处于同一局域网。

**裸机运行：**

```bash
cp .env.example .env
npm install
npm start
```

**500 人并发建议** —— 实际承载取决于交换机/AP、无线终端密度、笔画频率、服务端 CPU/网卡以及同时活跃绘画人数，不能仅凭连接数保证。建议起步配置：4～8 vCPU、8～16 GB 内存、千兆有线网卡（服务端走有线）、企业级无线 AP（不要让 500 台设备全挂在单个家用 AP 上）。压测时重点观察：WebSocket 活跃连接数、Node.js CPU/RSS、`bufferedAmount` 与慢客户端断开数、端到端笔迹延迟（建议局域网 P95 < 150ms）、AP 并发客户端数与空口利用率。

## 生产化路线

正式使用前需补齐：

1. **身份认证** —— 教师密钥不能作为生产认证；学生使用短期房间票据，服务端校验房间权限。
2. **HTTPS / WSS** —— 配置内网域名与可信证书；非安全上下文可能限制部分浏览器能力。
3. **持久化** —— 将笔画事件写入 Redis Stream / 数据库并定时快照；当前内存数据重启即丢失。
4. **流量治理** —— 客户端按 30～50ms 批量发送坐标；服务端按用户限速，限制单笔最大点数与房间笔画数。
5. **绘制优化** —— 离屏 Canvas、路径简化、分层 Canvas（背景/历史/当前），避免每次操作全量重绘。
6. **多实例扩展** —— 单实例达到瓶颈后，用 Redis Pub/Sub 或 Streams 做跨实例广播，配合粘性会话/房间路由。
7. **撤销语义** —— 当前 `undo_last` 为房间级；建议增加用户归属、操作序号与教师授权撤销。
8. **监控** —— Prometheus 指标、结构化日志、房间人数与消息速率统计。

## 贡献指南

欢迎贡献，典型流程：

1. Fork 仓库并创建特性分支。
2. 保持改动聚焦，运行并验证受影响流程（教师建房 → 学生加入 → 绘画 → 撤销/清空）。
3. 行为或配置变更时，同步更新本 README 与 `代码说明文档.md`。
4. 提交 PR，说明动机与你做过的验证。

## 许可证

本项目基于 [MIT 许可证](./LICENSE) 发布。在遵循许可证条款的前提下，你可以自由地使用、复制、修改、合并、发布、分发、再许可和/或销售本软件的副本。
