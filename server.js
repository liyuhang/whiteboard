"use strict";

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const TEACHER_SECRET = process.env.TEACHER_SECRET || "dev-only-change-me";
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 600);
const MAX_POINTS = Number(process.env.MAX_POINTS_PER_MESSAGE || 80);
const MAX_STROKES = Number(process.env.MAX_STROKES_PER_ROOM || 12000);
const PUBLIC = path.join(__dirname, "public");

const rooms = new Map();
const clients = new Set();

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function getRoom(id) {
  return rooms.get(id);
}

function broadcast(room, payload, except = null) {
  const data = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 1024 * 1024) {
        client.close(1013, "slow consumer");
        continue;
      }
      client.send(data);
    }
  }
}

function publicRoomState(room) {
  return {
    type: "init",
    roomId: room.id,
    drawingEnabled: room.drawingEnabled,
    canvas: room.canvas,
    strokes: Array.from(room.strokes.values()),
    participants: room.clients.size
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      rooms: rooms.size,
      connections: clients.size,
      uptimeSeconds: Math.floor(process.uptime())
    });
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const supplied = req.headers["x-teacher-secret"];
    if (!supplied || supplied !== TEACHER_SECRET) {
      return json(res, 401, { error: "invalid_teacher_secret" });
    }

    let id;
    do {
      id = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(id));

    const teacherToken = crypto.randomBytes(24).toString("hex");
    const room = {
      id,
      teacherToken,
      drawingEnabled: true,
      canvas: { width: 1200, height: 800, background: "#ffffff" },
      strokes: new Map(),
      clients: new Set(),
      createdAt: Date.now(),
      sequence: 0
    };
    rooms.set(id, room);
    return json(res, 201, { roomId: id, teacherToken, studentUrl: `/mobile.html?room=${id}` });
  }

  if (req.method === "GET" && url.pathname === "/api/rooms") {
    const id = url.searchParams.get("id");
    const room = id && getRoom(id);
    if (!room) return json(res, 404, { error: "room_not_found" });
    return json(res, 200, {
      roomId: room.id,
      drawingEnabled: room.drawingEnabled,
      participants: room.clients.size
    });
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/pc.html";
  const filePath = path.normalize(path.join(PUBLIC, pathname));
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== PUBLIC) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  });
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  if (clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, "server connection limit");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const roomId = (url.searchParams.get("room") || "").toUpperCase();
  const role = url.searchParams.get("role") || "student";
  const name = (url.searchParams.get("name") || (role === "teacher" ? "Teacher" : "Student")).slice(0, 32);
  const token = url.searchParams.get("token") || "";
  const room = getRoom(roomId);

  if (!room || (role !== "teacher" && role !== "student")) {
    ws.close(1008, "invalid room or role");
    return;
  }
  if (role === "teacher" && token !== room.teacherToken) {
    ws.close(1008, "invalid teacher token");
    return;
  }

  const client = { ws, room, role, name, id: crypto.randomUUID(), lastMessageAt: 0, messageCount: 0 };
  clients.add(client);
  room.clients.add(ws);
  ws._client = client;

  ws.send(JSON.stringify(publicRoomState(room)));
  broadcast(room, { type: "presence", participants: room.clients.size, name, action: "join" }, ws);

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    const now = Date.now();
    if (now - client.lastMessageAt >= 1000) {
      client.lastMessageAt = now;
      client.messageCount = 0;
    }
    client.messageCount++;
    if (client.messageCount > 100) return; // per-client message ceiling

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: now }));
      return;
    }

    if (msg.type === "stroke_start" || msg.type === "stroke_move" || msg.type === "stroke_end") {
      if (client.role === "student" && !room.drawingEnabled) {
        ws.send(JSON.stringify({ type: "error", code: "drawing_disabled" }));
        return;
      }

      const strokeId = String(msg.strokeId || "");
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(strokeId)) return;

      if (msg.type === "stroke_start") {
        if (room.strokes.size >= MAX_STROKES) {
          ws.send(JSON.stringify({ type: "error", code: "room_stroke_limit" }));
          return;
        }
        const color = typeof msg.color === "string" && /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : "#202020";
        const width = Math.max(1, Math.min(24, Number(msg.width) || 3));
        const stroke = {
          id: strokeId,
          userId: client.id,
          userName: client.name,
          color,
          width,
          points: [],
          done: false,
          createdAt: now
        };
        room.strokes.set(strokeId, stroke);
        const point = normalizePoint(msg.point);
        if (point) stroke.points.push(point);
        room.sequence++;
        broadcast(room, { type: "stroke_start", stroke: { ...stroke, points: [...stroke.points] }, seq: room.sequence }, ws);
        return;
      }

      const stroke = room.strokes.get(strokeId);
      if (!stroke || stroke.userId !== client.id || stroke.done) return;

      if (msg.type === "stroke_move") {
        const points = Array.isArray(msg.points) ? msg.points.slice(0, MAX_POINTS).map(normalizePoint).filter(Boolean) : [];
        if (!points.length) return;
        stroke.points.push(...points);
        // Keep memory bounded. In production, simplify paths and periodically snapshot.
        if (stroke.points.length > 20000) stroke.points = stroke.points.slice(-20000);
        room.sequence++;
        broadcast(room, { type: "stroke_move", strokeId, points, seq: room.sequence }, ws);
      } else {
        stroke.done = true;
        room.sequence++;
        broadcast(room, { type: "stroke_end", strokeId, seq: room.sequence }, ws);
      }
      return;
    }

    if (client.role === "teacher" && msg.type === "set_drawing") {
      room.drawingEnabled = Boolean(msg.enabled);
      broadcast(room, { type: "drawing_permission", enabled: room.drawingEnabled });
      return;
    }

    if (client.role === "teacher" && msg.type === "clear") {
      room.strokes.clear();
      room.sequence++;
      broadcast(room, { type: "clear", seq: room.sequence });
      return;
    }

    if (client.role === "teacher" && msg.type === "undo_last") {
      const all = Array.from(room.strokes.values());
      const last = all[all.length - 1];
      if (last) {
        room.strokes.delete(last.id);
        room.sequence++;
        broadcast(room, { type: "remove_stroke", strokeId: last.id, seq: room.sequence });
      }
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    room.clients.delete(ws);
    broadcast(room, { type: "presence", participants: room.clients.size, name, action: "leave" });
  });
  ws.on("error", () => {});
});

function normalizePoint(p) {
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
  return { x: Math.max(0, Math.min(1, Number(p.x))), y: Math.max(0, Math.min(1, Number(p.y))) };
}

setInterval(() => {
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (client.ws.bufferedAmount > 2 * 1024 * 1024) client.ws.close(1013, "slow consumer");
      else client.ws.ping();
    }
  }
}, 25000).unref();

server.listen(PORT, HOST, () => {
  console.log(`LAN Whiteboard listening on http://${HOST}:${PORT}`);
  console.log(`Teacher room creation requires X-Teacher-Secret`);
});
