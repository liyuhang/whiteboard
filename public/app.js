const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isTeacher = document.body.dataset.role === "teacher";
let socket, roomId, userName, drawingEnabled = true, currentStroke = null;
let strokes = new Map();
let reconnectTimer = null;
let pingTimer = null;
let pendingPoints = [];
let flushTimer = null;
const canvas = $("board");
const ctx = canvas.getContext("2d");

function setStatus(s) { $("status").textContent = s; }
function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({ room: roomId, role: isTeacher ? "teacher" : "student", name: userName });
  if (isTeacher) q.set("token", sessionStorage.getItem("teacherToken") || "");
  return `${scheme}//${location.host}/ws?${q}`;
}
function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}
function connect() {
  if (!roomId) return;
  clearTimeout(reconnectTimer);
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    setStatus("已连接");
    $("connection").textContent = "在线";
    pingTimer = setInterval(() => send({type:"ping"}), 20000);
  };
  socket.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleMessage(m);
  };
  socket.onclose = () => {
    clearInterval(pingTimer);
    setStatus("连接断开，正在重连…");
    $("connection").textContent = "重连中";
    reconnectTimer = setTimeout(connect, 1500);
  };
  socket.onerror = () => setStatus("连接异常");
}
function handleMessage(m) {
  if (m.type === "init") {
    drawingEnabled = m.drawingEnabled;
    strokes.clear();
    for (const s of m.strokes || []) strokes.set(s.id, s);
    if (m.participants != null) $("participants").textContent = m.participants;
    render();
    updatePermission();
    return;
  }
  if (m.type === "stroke_start") {
    strokes.set(m.stroke.id, m.stroke);
    renderStroke(m.stroke);
  } else if (m.type === "stroke_move") {
    const s = strokes.get(m.strokeId);
    if (s) { s.points.push(...m.points); drawPoints(s, m.points); }
  } else if (m.type === "stroke_end") {
    const s = strokes.get(m.strokeId); if (s) s.done = true;
  } else if (m.type === "clear") {
    strokes.clear(); render();
  } else if (m.type === "remove_stroke") {
    strokes.delete(m.strokeId); render();
  } else if (m.type === "drawing_permission") {
    drawingEnabled = m.enabled; updatePermission();
  } else if (m.type === "presence") {
    $("participants").textContent = m.participants;
  } else if (m.type === "error") {
    setStatus(m.code === "drawing_disabled" ? "老师已暂时关闭学生绘画" : `服务端提示：${m.code}`);
  }
}
function updatePermission() {
  const el = $("permission");
  if (el) el.textContent = drawingEnabled ? "学生绘画：已开启" : "学生绘画：已关闭";
  if (!isTeacher) canvas.style.opacity = drawingEnabled ? "1" : ".85";
}
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
  for (const s of strokes.values()) renderStroke(s);
}
function renderStroke(s) {
  if (!s || !s.points || !s.points.length) return;
  drawPoints(s, s.points, true);
}
function drawPoints(s, points, full = false) {
  if (!points || !points.length) return;
  ctx.save();
  ctx.strokeStyle = s.color || "#202020";
  ctx.lineWidth = s.width || 3;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const toXY = p => ({x:p.x*canvas.width, y:p.y*canvas.height});
  if (full) {
    const pts = points.map(toXY);
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth/2, 0, Math.PI*2); ctx.fillStyle=ctx.strokeStyle; ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);
      ctx.stroke();
    }
    s._lastDrawn = points[points.length-1];
    ctx.restore();
    return;
  }
  // 增量绘制：从上一批最后一个点起笔，填补批与批之间的缺口
  const prev = s._lastDrawn;
  const pts = points.map(toXY);
  if (prev) {
    const p0 = toXY(prev);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y);
    for (let i=0;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth/2, 0, Math.PI*2); ctx.fillStyle=ctx.strokeStyle; ctx.fill();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  s._lastDrawn = points[points.length-1];
  ctx.restore();
}
function pointFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)) };
}
function canDraw() { return isTeacher || drawingEnabled; }
canvas.addEventListener("pointerdown", e => {
  if (!canDraw() || !socket || socket.readyState !== WebSocket.OPEN) return;
  e.preventDefault(); canvas.setPointerCapture(e.pointerId);
  const p = pointFromEvent(e);
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
  currentStroke = { id, color: $("color").value, width: Number($("width").value), points:[p], userName };
  strokes.set(id, currentStroke);
  send({type:"stroke_start", strokeId:id, color:currentStroke.color, width:currentStroke.width, point:p});
  renderStroke(currentStroke);
});
canvas.addEventListener("pointermove", e => {
  if (!currentStroke) return;
  e.preventDefault();
  // 高速书写时浏览器会合并 pointermove，读取 coalesced 事件恢复真实轨迹点
  const coalesced = (typeof e.getCoalescedEvents === "function") ? e.getCoalescedEvents() : null;
  if (coalesced && coalesced.length) {
    for (const ev of coalesced) pendingPoints.push(pointFromEvent(ev));
  } else {
    pendingPoints.push(pointFromEvent(e));
  }
  if (!flushTimer) flushTimer = setTimeout(flushPoints, 35);
});
function flushPoints() {
  flushTimer = null;
  if (!currentStroke || !pendingPoints.length) { pendingPoints=[]; return; }
  const points = pendingPoints.splice(0,80);
  currentStroke.points.push(...points);
  send({type:"stroke_move", strokeId:currentStroke.id, points});
  drawPoints(currentStroke, points);
  if (pendingPoints.length) flushTimer=setTimeout(flushPoints,35);
}
function finishStroke() {
  if (!currentStroke) return;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer=null; }
  flushPoints();
  send({type:"stroke_end", strokeId:currentStroke.id});
  currentStroke.done=true; currentStroke=null;
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);

if (isTeacher) {
  $("toggleDrawing").addEventListener("click", () => {
    drawingEnabled = !drawingEnabled;
    send({type:"set_drawing", enabled:drawingEnabled});
    updatePermission();
  });
  $("clear").addEventListener("click", () => {
    if (confirm("确定清空所有人的白板内容？")) send({type:"clear"});
  });
  $("undo").addEventListener("click", () => send({type:"undo_last"}));
  $("copyLink").addEventListener("click", async () => {
    const link = `${location.origin}/mobile.html?room=${roomId}`;
    try { await navigator.clipboard.writeText(link); setStatus("学生链接已复制"); }
    catch { prompt("复制学生加入链接：", link); }
  });
}

async function createRoom() {
  const secret = $("secret").value.trim();
  if (!secret) { setStatus("请填写教师管理密钥"); return; }
  try {
    const r = await fetch("/api/rooms", {method:"POST", headers:{"X-Teacher-Secret":secret}});
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "创建失败");
    roomId = data.roomId;
    sessionStorage.setItem("teacherToken", data.teacherToken);
    userName = $("teacherName").value.trim() || "Teacher";
    $("setup").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    $("canvasWrap").classList.remove("hidden");
    $("roomLabel").textContent = roomId;
    $("studentLink").textContent = `${location.origin}/mobile.html?room=${roomId}`;
    connect();
  } catch(e) { setStatus(`创建房间失败：${e.message}`); }
}

function joinStudent() {
  roomId = (params.get("room") || $("roomInput").value).trim().toUpperCase();
  userName = $("studentName").value.trim() || "学生";
  if (!roomId) { setStatus("请输入房间号"); return; }
  $("joinPanel").classList.add("hidden");
  $("workspace").classList.remove("hidden");
  $("canvasWrap").classList.remove("hidden");
  $("roomLabel").textContent = roomId;
  connect();
}

if (isTeacher) {
  $("createRoom").addEventListener("click", createRoom);
} else {
  if (params.get("room")) $("roomInput").value = params.get("room");
  $("joinRoom").addEventListener("click", joinStudent);
  if (params.get("room")) $("joinRoom").click();
}
