import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const socket = io();
const $ = id => document.getElementById(id);

let myId = null;
let roomCode = null;
let isHost = false;
let gameStarted = false;
let myRole = "";
let myCharacter = "";
let players = [];
let timerInterval = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ac7dc);
scene.fog = new THREE.Fog(0x9ac7dc, 35, 100);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 150);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

$("gameCanvas").appendChild(renderer.domElement);

const ambient = new THREE.HemisphereLight(0xe6f7ff, 0x66705c, 2.0);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(15, 30, 10);
sun.castShadow = true;
scene.add(sun);

const world = new THREE.Group();
scene.add(world);

const playerMeshes = new Map();
const propMeshes = [];
const keys = {};
const clock = new THREE.Clock();

let yaw = 0;
let pitch = 0;
let cameraDistance = 5;
let mouseLocked = false;
let lastMoveSent = 0;
let myMesh = null;
let disguiseMode = false;
let scanCooldown = false;
let rescueCooldown = false;

const playerState = { x: 0, z: 0, y: 0, speed: 6, moving: false };
const propTypes = ["chair", "table", "plant", "box", "lamp", "barrel", "bin", "crate"];

const materials = {
  floor: new THREE.MeshStandardMaterial({ color: 0x8499a3, roughness: 0.75 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xd5e0e6, roughness: 0.8 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x5ec9d9, transparent: true, opacity: 0.35, roughness: 0.2 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x95613c, roughness: 0.8 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x526879, metalness: 0.6, roughness: 0.35 }),
  green: new THREE.MeshStandardMaterial({ color: 0x318c57, roughness: 0.9 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8edf0, roughness: 0.65 })
};

function box(parent, x, y, z, sx, sy, sz, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent, x, y, z, radius, height, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function createMall() {
  box(world, 0, -0.25, 0, 65, 0.5, 65, materials.floor);
  box(world, 0, 3, -32, 65, 6, 1, materials.wall);
  box(world, 0, 3, 32, 65, 6, 1, materials.wall);
  box(world, -32, 3, 0, 1, 6, 65, materials.wall);
  box(world, 32, 3, 0, 1, 6, 65, materials.wall);
}
createMall();

function createCharacter(color = 0x35b8c5, isSeeker = false) {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: isSeeker ? 0x202b3c : 0x263747 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.5), bodyMaterial);
  body.position.y = 1.25;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 16), new THREE.MeshStandardMaterial({ color: 0xe5b58e }));
  head.position.y = 2.1;
  group.add(head);

  const legs = [];
  for (const x of [-0.22, 0.22]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.7, 0.25), darkMaterial);
    leg.position.set(x, 0.35, 0);
    group.add(leg);
    legs.push(leg);
  }
  group.userData.legs = legs;
  return group;
}

function characterColor(character) {
  if (character === "argus") return 0x27374c;
  if (character === "nana") return 0xffa3c7;
  if (character === "gojo") return 0x6b9bff;
  return 0x35b8c5;
}

function createRemotePlayer(data) {
  const mesh = createCharacter(characterColor(data.character), data.role === "seeker");
  mesh.position.set(data.x || 0, 0, data.z || 0);
  mesh.rotation.y = data.yaw || 0;
  scene.add(mesh);
  playerMeshes.set(data.id, mesh);
  return mesh;
}

function updatePlayers(list) {
  players = list || [];
  $("playerCount").textContent = `${players.length}/10`;
  $("aliveCount").textContent = players.filter(p => p.alive).length;

  $("playerList").innerHTML = "";
  players.forEach((p, index) => {
    const item = document.createElement("div");
    item.className = "player-item";
    item.innerHTML = `<div class="player-avatar">${(p.name || "O")[0]}</div><div class="player-name">${p.name}</div>`;
    $("playerList").appendChild(item);
  });

  if (gameStarted) {
    players.forEach(p => {
      if (p.id === myId) return;
      let mesh = playerMeshes.get(p.id);
      if (!mesh) mesh = createRemotePlayer(p);

      mesh.position.set(p.x || 0, p.y || 0, p.z || 0);
      mesh.rotation.y = p.yaw || 0;
      mesh.visible = p.alive && !p.invisible && !p.disguised;
    });

    for (const [id, mesh] of playerMeshes) {
      if (!players.some(p => p.id === id)) {
        scene.remove(mesh);
        playerMeshes.delete(id);
      }
    }
  }
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
}

function message(id, text) {
  $(id).textContent = text;
  setTimeout(() => { if ($(id).textContent === text) $(id).textContent = ""; }, 3500);
}

function getNickname() {
  const name = $("nickname").value.trim();
  if (!name) { message("menuMessage", "Önce oyuncu adını yaz."); return null; }
  return name;
}

$("createRoom").addEventListener("click", () => {
  const name = getNickname();
  if (name) socket.emit("createRoom", { name });
});

$("joinRoom").addEventListener("click", () => {
  const name = getNickname();
  const code = $("roomCode").value.trim().toUpperCase();
  if (name && code) socket.emit("joinRoom", { name, code });
});

$("startGame").addEventListener("click", () => socket.emit("startRound"));
$("leaveRoom").addEventListener("click", () => { socket.emit("leaveRoom"); showScreen("menu"); });

// SOCKET DİNLEYİCİLERİ (DÜZELTİLDİ)
socket.on("connect", () => { myId = socket.id; });

socket.on("roomCreated", data => {
  roomCode = data.code;
  isHost = true;
  $("displayRoomCode").textContent = roomCode;
  $("startGame").style.display = "block";
  showScreen("lobby");
});

socket.on("roomJoined", data => {
  roomCode = data.code;
  isHost = !!data.isHost;
  $("displayRoomCode").textContent = roomCode;
  $("startGame").style.display = isHost ? "block" : "none";
  showScreen("lobby");
});

socket.on("roomUpdate", data => {
  if (data.players) updatePlayers(data.players);
});

socket.on("errorMessage", text => {
  message(gameStarted ? "gameMessage" : "menuMessage", text);
});

socket.on("roundStarted", data => {
  gameStarted = true;
  myRole = data.role || "";
  myCharacter = data.character || "";

  $("roleText").textContent = myRole === "seeker" ? "EBE (ARGUS)" : "GİZLENEN";
  $("scanBtn").style.display = myRole === "seeker" ? "block" : "none";
  $("rescueBtn").style.display = myCharacter === "nana" ? "block" : "none";
  $("invisibleBtn").style.display = myCharacter === "gojo" ? "block" : "none";
  $("disguiseBtn").style.display = myRole === "hider" ? "block" : "none";

  showScreen("game");
  if (myMesh) scene.remove(myMesh);

  myMesh = createCharacter(characterColor(myCharacter), myRole === "seeker");
  scene.add(myMesh);

  playerState.x = 0; playerState.z = 0; yaw = 0; pitch = -0.15;
  showScreen("game");
});

socket.on("playerMoved", data => {
  if (data.id === myId) return;
  const mesh = playerMeshes.get(data.id);
  if (mesh) {
    mesh.position.set(data.x, 0, data.z);
    mesh.rotation.y = data.yaw;
  }
});

socket.on("playerDisguise", data => {
  const mesh = playerMeshes.get(data.id);
  if (mesh) mesh.visible = !data.disguised;
});

socket.on("playerInvisible", data => {
  const mesh = playerMeshes.get(data.id);
  if (mesh) mesh.visible = !data.invisible;
});

socket.on("playerCaught", data => {
  const mesh = playerMeshes.get(data.id);
  if (mesh) mesh.visible = false;
  message("gameMessage", "Bir oyuncu yakalandı!");
});

socket.on("scanResult", data => {
  if (data.ids) {
    data.ids.forEach(id => {
      const mesh = playerMeshes.get(id);
      if (mesh) mesh.traverse(c => { if (c.material) c.material.emissive = new THREE.Color(0x00ffff); });
    });
  }
  message("gameMessage", "Tarama tamamlandı!");
});

socket.on("roundEnded", data => {
  gameStarted = false;
  $("resultTitle").textContent = data.winner === "hiders" ? "GİZLENENLER KAZANDI!" : "EBE KAZANDI!";
  $("resultDescription").textContent = data.message;
  showScreen("result");
});

$("backToLobby").addEventListener("click", () => socket.emit("returnLobby"));

// YETENEKLER VE HAREKET
function toggleDisguise() {
  if (!gameStarted || myRole !== "hider") return;
  disguiseMode = !disguiseMode;
  socket.emit("disguise", { disguised: disguiseMode, prop: propTypes[0] });
}
$("disguiseBtn").addEventListener("click", toggleDisguise);

function scan() {
  if (!gameStarted || myRole !== "seeker" || scanCooldown) return;
  scanCooldown = true;
  socket.emit("scan");
  setTimeout(() => scanCooldown = false, 12000);
}
$("scanBtn").addEventListener("click", scan);

function rescue() {
  if (!gameStarted || rescueCooldown) return;
  rescueCooldown = true;
  socket.emit("doctorRescue");
  setTimeout(() => rescueCooldown = false, 20000);
}
$("rescueBtn").addEventListener("click", rescue);

function invisibility() {
  if (!gameStarted) return;
  socket.emit("invisibility");
}
$("invisibleBtn").addEventListener("click", invisibility);

document.addEventListener("mousedown", event => {
  if (event.button === 0 && mouseLocked && myRole === "seeker") {
    socket.emit("tag");
  }
});

window.addEventListener("keydown", e => { keys[e.code] = true; });
window.addEventListener("keyup", e => { keys[e.code] = false; });

renderer.domElement.addEventListener("click", () => {
  if (gameStarted) renderer.domElement.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => {
  mouseLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener("mousemove", e => {
  if (!mouseLocked || !gameStarted) return;
  yaw -= e.movementX * 0.002;
  pitch = Math.max(-0.8, Math.min(0.45, pitch - e.movementY * 0.002));
});

function updateMovement(delta) {
  if (!gameStarted || !myMesh) return;
  let f = 0, s = 0;
  if (keys["KeyW"]) f += 1;
  if (keys["KeyS"]) f -= 1;
  if (keys["KeyA"]) s -= 1;
  if (keys["KeyD"]) s += 1;

  if (f !== 0 || s !== 0) {
    const speed = 6;
    playerState.x += (-Math.sin(yaw) * f + Math.cos(yaw) * s) * speed * delta;
    playerState.z += (-Math.cos(yaw) * f - Math.sin(yaw) * s) * speed * delta;
    myMesh.rotation.y = yaw;
  }

  myMesh.position.set(playerState.x, 0, playerState.z);

  const target = new THREE.Vector3(playerState.x, 1.8, playerState.z);
  const offset = new THREE.Vector3(Math.sin(yaw) * cameraDistance, 2.2, Math.cos(yaw) * cameraDistance);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);

  const now = performance.now();
  if (now - lastMoveSent > 50) {
    lastMoveSent = now;
    socket.emit("move", { x: playerState.x, z: playerState.z, yaw });
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (gameStarted) updateMovement(delta);
  renderer.render(scene, camera);
}
animate();