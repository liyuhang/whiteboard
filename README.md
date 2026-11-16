# LAN Interactive Whiteboard

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=nodedotjs&logoColor=white">
  <img alt="docker" src="https://img.shields.io/badge/docker--compose-ready-2496ED?logo=docker&logoColor=white">
  <img alt="platform" src="https://img.shields.io/badge/platform-web-lightgrey">
  <img alt="status" src="https://img.shields.io/badge/status-MVP-yellow">
</p>

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  A teacher-led, real-time collaborative whiteboard for a LAN — PC web for the teacher, mobile H5 for students.
</p>

---

A single-process Node.js server with a WebSocket backend and a native Canvas frontend. The teacher creates a room, students join by room code or link, and everyone's strokes are broadcast live. Deployable with Docker Compose.

> **Status: MVP.** Rooms and strokes live in process memory and are lost on restart. See [Production Roadmap](#production-roadmap) before real-world use.

## Features

- 🏫 Teacher creates a room; students join by code or shared link
- ✍️ Real-time multi-user drawing (mouse / touch) with live broadcast
- 🎛️ Teacher controls: toggle student drawing, undo last stroke, clear board
- 🔌 WebSocket incremental sync, auto-reconnect, snapshot on join
- 📐 Normalized `[0,1]` coordinates — same rendering across PC and phone
- 🐳 One-command Docker deployment
- 🛡️ Per-client rate limiting, connection caps, slow-consumer protection, path-traversal guard

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Wire Protocol](#wire-protocol)
- [Deployment & Scaling](#deployment--scaling)
- [Production Roadmap](#production-roadmap)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

```bash
# 1. Configure the teacher secret
cp .env.example .env          # then edit TEACHER_SECRET to a long random value

# 2. Run
npm install && npm start      # http://0.0.0.0:8080

# 3. Verify
curl http://localhost:8080/health
# {"ok":true,"rooms":0,"connections":0,"uptimeSeconds":3}
```

Or with Docker:

```bash
TEACHER_SECRET=your-long-random-secret docker compose up -d --build
```

## Installation

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 20 |
| Docker (optional) | with Compose v2 |

Runtime dependencies: `ws`, `dotenv` only — no framework.

```bash
npm install
```

## Usage

1. Open the **teacher** page `http://<host>:8080/`, enter `TEACHER_SECRET`, click **Create Room**, note the room code (e.g. `04DDB7`).
2. Share the room code or the student link with students.
3. Students open `http://<host>:8080/mobile.html?room=<CODE>` (or enter the code) and join.
4. Anyone draws on the canvas; strokes sync live. The teacher can toggle drawing, undo, or clear.

> Tip: if the browser's autofill dropdown covers the secret field, press `Esc` before typing.

## Configuration

All settings are read from `.env` (or the container environment).

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `TEACHER_SECRET` | `dev-only-change-me` | Auth secret for `POST /api/rooms` (header `X-Teacher-Secret`) |
| `MAX_CONNECTIONS` | `600` | Global connection cap |
| `MAX_POINTS_PER_MESSAGE` | `80` | Max points stored per `stroke_move` |
| `MAX_STROKES_PER_ROOM` | `12000` | Max strokes per room |

> ⚠️ Set `TEACHER_SECRET` to a long random value. Never commit the real secret.

## Documentation

| Document | Description |
|----------|-------------|
| [`CODE_DOCUMENTATION.md`](./CODE_DOCUMENTATION.md) | In-depth developer guide (EN): architecture, modules, protocol, limits, where to change what |
| [`代码说明文档.md`](./代码说明文档.md) | 开发者深度文档（中文） |
| [`README.zh-CN.md`](./README.zh-CN.md) | 本说明的中文版 |

## Wire Protocol

WebSocket endpoint: `GET /ws?room=<CODE>&role=<teacher|student>&name=<name>[&token=<teacherToken>]`.

**Client → Server:** `ping`, `stroke_start`, `stroke_move`, `stroke_end`, `set_drawing`, `clear`, `undo_last`
**Server → Client:** `init`, `pong`, `stroke_start`, `stroke_move`, `stroke_end`, `drawing_permission`, `presence`, `clear`, `remove_stroke`, `error`

Full field-level reference and limits are in [CODE_DOCUMENTATION.md](./CODE_DOCUMENTATION.md#7-wire-protocol).

## Deployment & Scaling

**Docker (recommended):**

```bash
cp .env.example .env      # set TEACHER_SECRET
docker compose up -d --build
docker compose logs -f
```

Ensure the host firewall allows inbound **TCP 8080** and that clients share the LAN.

**Bare metal:**

```bash
cp .env.example .env
npm install
npm start
```

**Sizing for ~500 concurrent clients** — real capacity depends on switch/AP, wireless density, stroke frequency, server CPU/NIC, and how many users draw simultaneously; it cannot be guaranteed by connection count alone. Suggested starting point: 4–8 vCPU, 8–16 GB RAM, gigabit wired NIC (server on wired network), enterprise-grade APs (don't hang 500 devices off one consumer AP). Watch: active WS connections, Node CPU/RSS, `bufferedAmount` / slow-client disconnects, end-to-end stroke latency (target LAN P95 < 150 ms), AP concurrent clients and airtime utilization.

## Production Roadmap

Before production use:

1. **Authentication** — the teacher secret is not a production auth mechanism; issue short-lived per-room tickets for students and validate room access server-side.
2. **HTTPS / WSS** — configure an internal domain with a trusted certificate; non-secure contexts may limit browser capabilities.
3. **Persistence** — write stroke events to Redis Streams / DB and snapshot periodically; in-memory state is lost on restart.
4. **Traffic governance** — batch client points every 30–50 ms; rate-limit per user; cap points-per-stroke and strokes-per-room.
5. **Rendering** — offscreen canvas, path simplification, layered canvas (background / history / current) to avoid full redraws.
6. **Multi-instance** — after a single instance saturates, use Redis Pub/Sub or Streams for cross-instance fan-out with sticky sessions / room routing.
7. **Undo semantics** — current `undo_last` is room-level; add ownership, operation ordering, and teacher-authorized undo.
8. **Observability** — Prometheus metrics, structured logs, per-room counts and message rates.

## Contributing

Contributions are welcome. A typical flow:

1. Fork the repository and create a feature branch.
2. Keep changes focused; run the app and verify the affected flow (teacher create → student join → draw → undo/clear).
3. Update this README and `CODE_DOCUMENTATION.md` when behavior or configuration changes.
4. Open a pull request describing the motivation and the verification you ran.

## License

Released under the [MIT License](./LICENSE). You are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of this software, subject to the terms of the license.
