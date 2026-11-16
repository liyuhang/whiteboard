# LAN Interactive Whiteboard · Code Documentation

> Applies to: the source in this directory (already includes the three fixes from this phase).
> Architecture: single-process Node.js + `ws` WebSocket + native Canvas frontend, deployed via Docker Compose.
> Shape: a teacher on PC creates a room; students on phone/PC join by room code; strokes are broadcast in real time.
> 中文文档见同目录 `代码说明文档.md`.

---

## Table of Contents

- [Quick Start (get running in 5 minutes)](#quick-start-get-running-in-5-minutes)
- [1. Project Layout](#1-project-layout)
- [2. Tech Stack & How to Run](#2-tech-stack--how-to-run)
- [3. Environment Variables](#3-environment-variables)
- [4. Backend `server.js`](#4-backend-serverjs)
- [5. Frontend `public/app.js`](#5-frontend-publicappjs-shared-by-teacher-and-student)
- [6. Frontend Pages & Styles](#6-frontend-pages--styles)
- [7. Wire Protocol](#7-wire-protocol)
- [8. Limits & Defaults](#8-limits--defaults)
- [9. Fixes Included in This Version](#9-fixes-included-in-this-version)
- [10. Known Limitations & Suggestions](#10-known-limitations--suggestions)
- [11. Developer Navigation: Where to Change What](#11-developer-navigation-where-to-change-what)

---

## Quick Start (get running in 5 minutes)

**Requirements**: Node.js ≥ 20 (to run locally) **or** Docker (to run in a container). The only runtime dependencies are `ws` and `dotenv`.

**Option A · Run locally**
```bash
cd <project-dir>
cp .env.example .env      # edit .env and set TEACHER_SECRET to a long random value
npm install
npm start                 # listens on http://0.0.0.0:8080 by default
```

**Option B · Run with Docker**
```bash
TEACHER_SECRET=your-long-random-secret docker compose up -d --build
```

**Verify the service**
```bash
curl http://localhost:8080/health
# Expected: {"ok":true,"rooms":0,"connections":0,"uptimeSeconds":3}
```

**Try the collaboration flow**
1. Open the teacher page `http://localhost:8080/`, enter `TEACHER_SECRET`, click "Create Room", and note the room code (e.g. `04DDB7`).
2. On another device or tab, open the student page `http://localhost:8080/mobile.html?room=04DDB7` — it joins automatically.
3. Drag on the canvas in either page to draw; strokes sync in real time. The teacher can undo, clear, and toggle student drawing.

**Stop**: local `Ctrl+C`; Docker `docker compose down`.

> Tip: the teacher secret input may be covered by the browser's autofill dropdown — press `Esc` first, then type.

---

## 1. Project Layout

```
.
├── server.js              # Backend: HTTP server + WebSocket server + room/stroke state
├── package.json           # Dependencies & scripts (dotenv, ws)
├── Dockerfile             # Image build (node:20-alpine)
├── docker-compose.yml     # Orchestration (ports, env, restart policy)
├── .env.example           # Environment variable template
├── README.md              # Original project README
├── CODE_DOCUMENTATION.md  # This file
├── 代码说明文档.md         # Chinese version
└── public/                # Static frontend (served directly by server.js)
    ├── pc.html            # Teacher page
    ├── mobile.html        # Student page
    ├── app.js             # Shared frontend logic (role from body[data-role])
    └── style.css          # Styles (shared, with mobile adaptation)
```

---

## 2. Tech Stack & How to Run

- **Runtime**: Node.js 20 (image `node:20-alpine`).
- **Dependencies**: `ws` (WebSocket), `dotenv` (reads `.env`). No framework.
- **Local**: `cp .env.example .env`, edit it, then `npm install && npm start` (`start` = `node server.js`).
- **Container**: `docker compose up -d --build`; container name `lan-whiteboard`, port `8080`, restart policy `unless-stopped`.
- **Entry points**:
  - Teacher: `http://<IP>:8080/` (root maps to `pc.html`)
  - Student: `http://<IP>:8080/mobile.html?room=<CODE>`
  - Health: `http://<IP>:8080/health`

---

## 3. Environment Variables

| Variable | Default | Purpose | Location |
|----------|---------|---------|----------|
| `PORT` | 8080 | Listen port | server.js:10 |
| `HOST` | 0.0.0.0 | Bind address | server.js:11 |
| `TEACHER_SECRET` | dev-only-change-me | Auth secret for creating a room (checked against header `X-Teacher-Secret`) | server.js:12 |
| `MAX_CONNECTIONS` | 600 | Global connection cap | server.js:13 |
| `MAX_POINTS_PER_MESSAGE` | 80 | Max points stored per `stroke_move` | server.js:14 |
| `MAX_STROKES_PER_ROOM` | 12000 | Max strokes per room | server.js:15 |

> Security: set `TEACHER_SECRET` to a long random value; add HTTPS/WSS before exposing to an untrusted network. Never commit the real secret.

---

## 4. Backend `server.js`

### 4.1 Global state
- `rooms: Map<roomId, room>` (server.js:18) — all rooms.
- `clients: Set<client>` (server.js:19) — all connections, used for `/health` counts and the heartbeat sweep.
- **room shape** (83-92): `{ id, teacherToken, drawingEnabled, canvas, strokes:Map, clients:Set<ws>, createdAt, sequence }`.
- **stroke shape** (202-211): `{ id, userId, userName, color, width, points:[{x,y}], done, createdAt }`.
- **client shape** (160): `{ ws, room, role, name, id(uuid), lastMessageAt, messageCount }`.
- `sequence` increments on every room operation and is carried on broadcast messages (monotonic, for ordering/consistency).

### 4.2 HTTP routes (`http.createServer`, 59-121)
1. `GET /health` (62-69): `{ok:true, rooms, connections, uptimeSeconds}`.
2. `POST /api/rooms` (71-95): verifies `X-Teacher-Secret` (else 401); generates a 6-hex-uppercase room id with `crypto.randomBytes(3)` (deduped); generates a 24-byte `teacherToken`; returns `{roomId, teacherToken, studentUrl}`.
3. `GET /api/rooms?id=` (97-106): `{roomId, drawingEnabled, participants}`; 404 if not found.
4. Static files (108-120): `/` → `/pc.html`; after `path.normalize`, the resolved path must stay inside `public/` or it returns **403 Forbidden** (path-traversal guard); sets `Content-Type` by extension.

### 4.3 WebSocket (`/ws`)
- `WebSocketServer` with `noServer:true`, `maxPayload:64KB`, `perMessageDeflate:false` (123-127); only upgrades with `pathname==="/ws"` are accepted (129-136).
- **Connection setup** (138-166):
  1. Over `MAX_CONNECTIONS` → `close(1013)`.
  2. Parse `room/role/name/token`; room id uppercased, `name` truncated to 32 chars.
  3. Missing room or bad role → `close(1008)`; teacher token mismatch → `close(1008)`.
  4. Register into `clients` and `room.clients`; send `init` (`publicRoomState`); broadcast `presence join` to others (**excluding self**, see 4.5).

### 4.4 Message handling (`ws.on("message")`, 168-261)
- Invalid JSON / missing `type` → ignored (170-171).
- **Per-client rate limit** (173-179): within a sliding 1s window, messages beyond 100 are dropped.
- `ping` → `pong` (181-184).
- **Drawing trio** `stroke_start / stroke_move / stroke_end` (186-237):
  - Student while `drawingEnabled=false` → `error: drawing_disabled` (187-190).
  - `strokeId` validated by `^[a-zA-Z0-9_-]{1,80}$`; invalid ignored (192-193).
  - `stroke_start` (195-218): at `MAX_STROKES` → `error: room_stroke_limit`; color must be `#rrggbb` else `#202020`; width clamped to `[1,24]` (invalid → 3); start point stored via `normalizePoint`; broadcast `stroke_start` (**excluding self**).
  - `stroke_move` (223-230): only the owner, and only while not `done`; takes first `MAX_POINTS` points, normalized & filtered; a stroke over 20000 points keeps the latest 20000; broadcast (excluding self).
  - `stroke_end` (231-235): sets `done=true`; broadcast (excluding self).
- **Teacher commands** (require `role==="teacher"`):
  - `set_drawing` (239-243): sets `drawingEnabled`, broadcasts `drawing_permission` (to all, including self).
  - `clear` (245-250): `strokes.clear()`, broadcasts `clear`.
  - `undo_last` (252-260): removes the last entry in `room.strokes` iteration order (i.e. the **last started** stroke), broadcasts `remove_stroke`.

### 4.5 Broadcast & protection (`broadcast`, 35-46)
- Iterates `room.clients`, skipping the `except` connection (sender echo suppression).
- If a connection's `bufferedAmount > 1MB` → `close(1013, slow consumer)`, without affecting others.
- **Key convention**: `stroke_start/move/end` and `presence join` all use `except=ws` (never sent back to the sender); `drawing_permission/clear/remove_stroke/presence leave` go to everyone. The frontend draws its own strokes locally, so it does not need the echo.

### 4.6 Coordinate normalization (`normalizePoint`, 271-274)
- Non-finite values → `null` (point dropped); otherwise `x/y` clamped to `[0,1]` (`Math.max(0,Math.min(1,..))`).

### 4.7 Heartbeat & cleanup (263-283)
- On `close`, the client is removed from `clients` and `room.clients`, and `presence leave` is broadcast.
- Every 25s sweep: `bufferedAmount>2MB` → close, otherwise send a ws-level `ping` to keep alive (`.unref()` so it doesn't block exit).

---

## 5. Frontend `public/app.js` (shared by teacher and student)

### 5.1 Role & connection
- `isTeacher = document.body.dataset.role === "teacher"` (app.js:3) distinguishes the two pages; one script serves both.
- `wsUrl()` (14-19): picks `ws/wss` by `location.protocol`; the teacher appends `teacherToken` from `sessionStorage`.
- `connect()` (23-43): `onopen` sets "connected" and sends an app-level `ping` every 20s; `onclose` auto-reconnects after 1.5s; `onmessage` parses JSON into `handleMessage`.

### 5.2 Message handling `handleMessage` (44-73)
- `init` (45-53): sets `drawingEnabled`, rebuilds the `strokes` Map, **fills in the online count `m.participants`**, `render()` full redraw, updates permission.
- `stroke_start`: store in Map and `renderStroke` (full draw).
- `stroke_move`: append points and `drawPoints` (incremental).
- `stroke_end`: mark `done`.
- `clear`: clear Map and redraw; `remove_stroke`: delete one stroke and redraw (full).
- `drawing_permission`: update permission; `presence`: update count; `error`: show message by code.

### 5.3 Drawing events & throttling
- `pointerdown` (130-139): generates `strokeId=timestamp_random`, builds a local `currentStroke` (with start point), draws immediately, sends `stroke_start`.
- `pointermove` (140-151): **reads `getCoalescedEvents()`** to recover intermediate real trajectory points dropped by the browser into `pendingPoints`; schedules `flushPoints` after 35ms if none pending.
- `flushPoints` (152-160): takes up to 80 points per batch, appends locally + sends `stroke_move` + draws incrementally; continues draining if backlog remains.
- `finishStroke` (161-167): clears timer, drains remaining points, sends `stroke_end`; bound to `pointerup/pointercancel/lostpointercapture`.

### 5.4 Canvas rendering (79-124)
- `render()`: `clearRect` + white fill + `renderStroke` per stroke (full). Used for snapshot, clear, undo, etc.
- `renderStroke → drawPoints(s, points, full=true)`: one continuous `beginPath` for the whole stroke.
- `drawPoints` (88-124) has two paths:
  - **Full (`full=true`)**: connect the whole batch at once and record `s._lastDrawn`.
  - **Incremental (`full=false`)**: `moveTo` from `s._lastDrawn` (last point of the previous batch) then `lineTo` this batch, **closing the inter-batch gap**; if no previous point, draw the start dot first. Updates `s._lastDrawn` at the end of each batch.

### 5.5 Teacher toolbar & student join
- Teacher (172-187): `toggleDrawing` sends `set_drawing`; `clear` sends `clear` after a confirm; `undo` sends `undo_last`; `copyLink` copies the student join link.
- `createRoom()` (189-206): POST `/api/rooms`, stores `teacherToken` in `sessionStorage`, switches to the workspace and connects.
- `joinStudent()` (208-217): reads the `room` URL param or the input, uppercases, then connects; if the URL already has `room`, it auto-joins (224).

---

## 6. Frontend Pages & Styles

- **pc.html**: `data-role="teacher"`; create panel (secret / teacher name / create button) + workspace (room code, connection, online count, drawing permission, color `#e53935`, width 1–18, toolbar buttons) + `canvas#board` (1200×800).
- **mobile.html**: `data-role="student"`; join panel (room code ≤6, nickname) + workspace (color `#1565c0`, width) + canvas; `viewport` disables zoom for mobile.
- **style.css**: shared; `canvas` uses `aspect-ratio:3/2` and `touch-action:none` (prevents browser gestures from interfering with drawing); `@media(max-width:640px)` mobile adaptation; `.hidden` toggles panels.

---

## 7. Wire Protocol

### Client → Server
| type | fields | meaning |
|------|--------|---------|
| `ping` | — | app-level heartbeat, server replies `pong` |
| `stroke_start` | `strokeId,color,width,point{x,y}` | begin a stroke |
| `stroke_move` | `strokeId,points[]` | append points (≤80) |
| `stroke_end` | `strokeId` | end a stroke |
| `set_drawing` | `enabled` | teacher only: toggle student drawing |
| `clear` | — | teacher only: clear board |
| `undo_last` | — | teacher only: undo last stroke |

### Server → Client
| type | fields | recipients | meaning |
|------|--------|-----------|---------|
| `init` | `roomId,drawingEnabled,canvas,strokes[],participants` | the connecting client | connection snapshot |
| `pong` | `ts` | requester | heartbeat reply |
| `stroke_start/move/end` | `stroke/points/strokeId,seq` | other members | stroke broadcast (sender excluded) |
| `drawing_permission` | `enabled` | all | permission change |
| `clear` | `seq` | all | clear |
| `remove_stroke` | `strokeId,seq` | all | undo one stroke |
| `presence` | `participants,name,action(join/leave)` | join excludes self / leave to all | join-leave & count |
| `error` | `code` | requester | `drawing_disabled` / `room_stroke_limit` |

---

## 8. Limits & Defaults

| Limit | Value | Behavior |
|-------|-------|----------|
| Global connections | 600 | over → `close(1013)` |
| Per-client message rate | 100/sec | over → dropped |
| Points per move | 80 | first 80 stored |
| Points per stroke | 20000 | over → keep latest 20000 |
| Strokes per room | 12000 | over → `error: room_stroke_limit` |
| Message payload | 64KB | over → rejected by ws layer |
| Slow consumer | bufferedAmount>1MB (broadcast) / >2MB (sweep) | `close(1013)` |
| Line width | [1,24] | out of range clamped, invalid → 3 |
| Coordinates | [0,1] | out of range clamped, invalid dropped |

---

## 9. Fixes Included in This Version

1. **Fast handwriting produced broken/dashed lines** → in `app.js`, incremental `drawPoints` now bridges from `s._lastDrawn` (previous batch's last point), and `pointermove` reads `getCoalescedEvents()` to recover the real trajectory.
2. **"Undo last stroke" made all strokes disappear for the teacher** → `server.js` now broadcasts `stroke_start` with `except=ws` (no echo to the sender), so the sender's local stroke is no longer overwritten to a single point; `render()` redraws correctly.
3. **Late joiners showed a wrong online count (e.g. student 1 vs teacher 2)** → `publicRoomState()` now includes `participants` in `init`, and the frontend `init` branch fills it in; a new connection shows the correct count immediately.

---

## 10. Known Limitations & Suggestions

- **Persistence**: rooms and strokes live only in process memory and are lost on container restart. For production, add Redis persistence or periodic snapshots.
- **Undo semantics**: `undo_last` removes the "last started" stroke (Map insertion order) and may hit a stroke someone is currently drawing (its later points are silently dropped by the server). Suggested: only undo `done` strokes, order by finish time, and notify the drawer to remove it locally when undoing an in-progress stroke.
- **Transport security**: currently HTTP/WS for LAN convenience. For production, add HTTPS/WSS, student authentication, and per-room access tokens.
- **Line width edge case**: `Number(width)||3` makes `width=0` fall back to the default 3 instead of clamping to 1 (use `??` if 0 should mean the thinnest).
- **Frontend state**: the teacher's `teacherToken` lives in `sessionStorage`; a background-tab discard/reload loses it and breaks reconnection auth. This is browser behavior — use more robust session handling in production.

---

## 11. Developer Navigation: Where to Change What

| What you want to do | Where to change |
|---------------------|-----------------|
| Change listen port/address | `PORT`/`HOST` in `.env`, or server.js:10-11 |
| Change the auth secret | `TEACHER_SECRET` in `.env` (never commit the real secret) |
| Tune connection/points/stroke caps | `MAX_CONNECTIONS` / `MAX_POINTS_PER_MESSAGE` / `MAX_STROKES_PER_ROOM` in `.env` |
| Room create/query logic | server.js:71-106 |
| Broadcast & echo strategy | server.js:35-46 (`broadcast`) and its call sites |
| Stroke ingest / rate limit / validation | server.js:168-260 |
| Undo / clear / permission semantics | server.js:239-260 |
| Frontend drawing / throttling / smoothing | app.js:88-124 (`drawPoints`), 140-160 (`pointermove`/`flushPoints`) |
| Extend WebSocket message types | server.js message branches + app.js:44-73 (`handleMessage`) |
| Page structure / controls | `public/pc.html`, `public/mobile.html` |
| Styles / mobile adaptation | `public/style.css` |

> After changing `server.js` / `public/*`, rebuild with `docker compose up -d --build` to apply. For frontend-only debugging, edit files under `public/` and hard-refresh the browser (`Ctrl+F5`).
