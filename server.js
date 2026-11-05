const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 5 * 60 * 1000;
const MAX_PLAYERS = 10;

app.use(express.static("public"));

const rooms = new Map();

const PROPS = [
  "chair", "table", "plant",
  "box", "lamp", "barrel",
  "bin", "crate"
];

const BOT_NAMES = [
  "Bot Alpha", "Bot Beta", "Pixel", 
  "Glitch", "Shadow", "Cyber", 
  "Matrix", "Nexus", "Echo"
];

function createCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanName(name) {
  return String(name || "Oyuncu")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "Oyuncu";
}

function getRoom(socket) {
  return rooms.get(socket.data.room);
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    timeLeft: room.phase === "playing"
      ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000))
      : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      character: p.character,
      role: p.role,
      alive: p.alive,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      disguised: p.disguised,
      prop: p.prop,
      invisible: p.invisible
    }))
  };
}

function updateRoom(room) {
  io.to(room.code).emit("roomUpdate", publicRoom(room));
}

function notify(socket, message) {
  socket.emit("errorMessage", message);
}

function createPlayer(id, name, isBot = false) {
  return {
    id: id,
    name: cleanName(name),
    character: "random",
    role: "",
    alive: true,
    x: 0,
    z: 0,
    yaw: 0,
    disguised: false,
    prop: null,
    invisible: false,
    doctorUsed: false,
    isBot: isBot,
    lastMove: 0,
    lastScan: 0,
    lastTag: 0,
    lastInvisible: 0
  };
}

function leaveRoom(socket) {
  const room = getRoom(socket);
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.room = null;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.phase === "playing") {
    checkWin(room);
  }

  updateRoom(room);
}

function checkWin(room) {
  const alive = [...room.players.values()]
    .filter(p => p.role !== "seeker" && p.alive);

  if (alive.length === 0) {
    endRound(room, "Ebe herkesi yakaladı!");
  }
}

function endRound(room, reason) {
  if (room.phase !== "playing") return;

  room.phase = "ended";

  io.to(room.code).emit("roundEnded", {
    winner: room.winner || "seeker",
    message: reason,
    state: publicRoom(room)
  });

  updateRoom(room);
}

function startRound(room) {
  const players = [...room.players.values()];

  if (players.length < 2) return false;

  // Eğer gerçek oyuncu sayısı 2'den azsa veya oda boş kalmasın diye bot ekleyelim (en az 4 oyuncuya tamamla)
  while (room.players.size < 4 && room.players.size < MAX_PLAYERS) {
    const botId = "bot_" + crypto.randomBytes(2).toString("hex");
    const randomBotName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + " 🤖";
    room.players.set(botId, createPlayer(botId, randomBotName, true));
  }

  const updatedPlayers = [...room.players.values()];
  const seeker = updatedPlayers[Math.floor(Math.random() * updatedPlayers.length)];

  room.phase = "playing";
  room.endsAt = Date.now() + ROUND_TIME;

  updatedPlayers.forEach((p, index) => {
    p.role = p.id === seeker.id ? "seeker" : "hider";
    p.alive = true;
    p.disguised = false;
    p.prop = null;
    p.invisible = false;
    p.doctorUsed = false;

    p.character = p.id === seeker.id
      ? "argus"
      : (index % 2 === 0 ? "nana" : "gojo");

    p.x = (Math.random() - 0.5) * 20;
    p.z = (Math.random() - 0.5) * 20;
  });

  io.to(room.code).emit("roundStarted", {
    duration: ROUND_TIME / 1000,
    role: room.players.get(room.hostId)?.role || "hider", // Güvenli rol ataması
    character: room.players.get(room.hostId)?.character || "nana",
    seekerId: seeker.id
  });

  updateRoom(room);
  return true;
}

io.on("connection", socket => {

  socket.on("createRoom", ({ name } = {}) => {
    if (socket.data.room) leaveRoom(socket);

    let code = createCode();
    while (rooms.has(code)) code = createCode();

    const room = {
      code,
      phase: "lobby",
      hostId: socket.id,
      players: new Map(),
      endsAt: 0
    };

    room.players.set(
      socket.id,
      createPlayer(socket.id, name, false)
    );

    rooms.set(code, room);

    socket.join(code);
    socket.data.room = code;

    socket.emit("roomCreated", { code, isHost: true });
    updateRoom(room);
  });

  socket.on("joinRoom", ({ name, code } = {}) => {
    code = String(code || "").toUpperCase().trim();

    const room = rooms.get(code);

    if (!room) return notify(socket, "Oda bulunamadı!");
    if (room.phase === "playing")
      return notify(socket, "Maç başlamış!");
    if (room.players.size >= MAX_PLAYERS)
      return notify(socket, "Oda dolu!");

    if (socket.data.room) leaveRoom(socket);

    room.players.set(
      socket.id,
      createPlayer(socket.id, name, false)
    );

    socket.join(code);
    socket.data.room = code;

    socket.emit("roomJoined", { code, isHost: room.hostId === socket.id });
    updateRoom(room);
  });

  socket.on("startRound", () => {
    const room = getRoom(socket);
    if (!room) return;

    if (room.hostId !== socket.id)
      return notify(socket, "Sadece oda sahibi başlatabilir!");

    if (room.phase === "ended")
      room.phase = "lobby";

    if (!startRound(room))
      notify(socket, "En az 2 oyuncu gerekli!");
  });

  socket.on("move", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || room.phase !== "playing" || !data) return;

    p.x = Math.max(-29, Math.min(29, Number(data.x) || 0));
    p.z = Math.max(-29, Math.min(29, Number(data.z) || 0));
    p.yaw = Number(data.yaw) || 0;

    socket.to(room.code).emit("playerMoved", {
      id: p.id,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      disguised: p.disguised,
      prop: p.prop,
      invisible: p.invisible
    });
  });

  socket.on("disguise", data => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || room.phase !== "playing") return;
    if (p.role !== "hider" || !p.alive) return;

    p.disguised = data?.disguised ?? !p.disguised;
    p.prop = p.disguised && PROPS.includes(data?.prop) ? data.prop : null;

    io.to(room.code).emit("playerDisguise", {
      id: p.id,
      disguised: p.disguised,
      prop: p.prop
    });
  });

  socket.on("scan", () => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || room.phase !== "playing") return;
    if (p.role !== "seeker") return;

    const found = [...room.players.values()]
      .filter(q =>
        q.role === "hider" &&
        q.alive &&
        Math.hypot(q.x - p.x, q.z - p.z) < 12
      )
      .map(q => q.id);

    socket.emit("scanResult", { ids: found });
  });

  socket.on("tag", () => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || room.phase !== "playing" || p.role !== "seeker") return;

    for (const target of room.players.values()) {
      if (target.role === "hider" && target.alive) {
        if (Math.hypot(target.x - p.x, target.z - p.z) <= 3.5) {
          target.alive = false;
          target.disguised = false;
          target.prop = null;

          io.to(room.code).emit("playerCaught", { id: target.id });
          checkWin(room);
          updateRoom(room);
          break;
        }
      }
    }
  });

  socket.on("doctorRescue", () => {
    const room = getRoom(socket);
    const doctor = room?.players.get(socket.id);

    if (!doctor || room.phase !== "playing") return;
    if (doctor.character !== "nana" || doctor.doctorUsed || !doctor.alive) return;

    for (const target of room.players.values()) {
      if (target.role === "hider" && !target.alive) {
        if (Math.hypot(target.x - doctor.x, target.z - doctor.z) <= 5) {
          doctor.doctorUsed = true;
          target.alive = true;
          target.x = doctor.x + 1;
          target.z = doctor.z + 1;

          io.to(room.code).emit("playerRescued", { id: target.id });
          updateRoom(room);
          break;
        }
      }
    }
  });

  socket.on("invisibility", () => {
    const room = getRoom(socket);
    const p = room?.players.get(socket.id);

    if (!p || room.phase !== "playing") return;
    if (p.character !== "gojo" || !p.alive) return;

    p.invisible = true;
    io.to(room.code).emit("playerInvisible", { id: p.id, invisible: true });

    setTimeout(() => {
      const current = room.players.get(p.id);
      if (!current) return;
      current.invisible = false;
      io.to(room.code).emit("playerInvisible", { id: p.id, invisible: false });
    }, 4000);
  });

  socket.on("returnLobby", () => {
    const room = getRoom(socket);
    if (!room) return;

    room.phase = "lobby";
    for (const p of room.players.values()) {
      p.role = "";
      p.alive = true;
      p.disguised = false;
      p.prop = null;
      p.invisible = false;
    }
    updateRoom(room);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

// Botların basit yapay zeka hareket döngüsü
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== "playing") continue;

    for (const p of room.players.values()) {
      if (!p.isBot || !p.alive) continue;

      // Botlar rastgele etrafta yürür
      p.x += (Math.random() - 0.5) * 1.5;
      p.z += (Math.random() - 0.5) * 1.5;
      p.x = Math.max(-28, Math.min(28, p.x));
      p.z = Math.max(-28, Math.min(28, p.z));

      io.to(room.code).emit("playerMoved", {
        id: p.id,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        disguised: p.disguised,
        prop: p.prop,
        invisible: p.invisible
      });
    }

    // Süre kontrolü
    if (Date.now() >= room.endsAt) {
      room.winner = "hiders";
      endRound(room, "Süre doldu! Saklananlar kazandı!");
    }
  }
}, 300);

server.listen(PORT, () => {
  console.log(`HIDEOUT server running on port ${PORT}`);
});