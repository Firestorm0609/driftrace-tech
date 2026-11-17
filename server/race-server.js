'use strict';

/* Authoritative two-player race rooms.
 *
 * The browser still predicts its own car for smooth input, but this process
 * owns the seed, clock, both car states, contacts and the result. Clients send
 * only four control bits; they receive 20 Hz snapshots and a final result.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 50;
const COUNTDOWN_MS = 3000;
const REMATCH_MS = 7000;
const RUNTIME = Math.max(1, Number(process.env.RACE_SECONDS || 60));
const MAXSPD = 1500;
const GEARS = [0.147, 0.32, 0.52, 0.74, 1.00];
const GEARACC = [150, 115, 95, 82, 70];
const REVSPD = 120;
const RUNLEN = 48000;
const FOC = 260;
const CARD = 480;
const CARW = 66;
const ROADH = 216;
const ONG = 0.63;
const START_Z = CARD;
const FINISH_Z = START_Z + RUNLEN;
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const CAR_HALF_W = (CARW * CARD / FOC) * 0.60;
const CAR_HALF_L = 108.3;
const DT = 1 / 60;

const rooms = new Map();
let nextClientId = 1;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function roadX(s) {
  return Math.sin(s * 0.00062) * 760 + Math.sin(s * 0.00151 + 1.7) * 210 +
    Math.sin(s * 0.0031 + 4.1) * 64;
}
function carTilt(car) {
  return car.drift * 0.13 + car.steer * 0.05 + car.driftV * 0.06;
}
function gearAcc(k) {
  for (let i = 0; i < GEARS.length; i++) if (k <= GEARS[i]) return GEARACC[i];
  return GEARACC[GEARACC.length - 1];
}

/* Keep this OBB test aligned with the browser's collision geometry. */
function boxSupport(cx, cz, hw, hl, th, dx, dz) {
  const c = Math.cos(th), s = Math.sin(th);
  const du = dx * c + dz * s, dv = -dx * s + dz * c;
  const su = du >= 0 ? 1 : -1, sv = dv >= 0 ? 1 : -1;
  return { x: cx + c * hw * su - s * hl * sv, z: cz + s * hw * su + c * hl * sv };
}
function boxContact(ax, az, ahw, ahl, ath, bx, bz, bhw, bhl, bth) {
  const ac = Math.cos(ath), as = Math.sin(ath), bc = Math.cos(bth), bs = Math.sin(bth);
  const dx = ax - bx, dz = az - bz;
  let best = 1e9, bnx = 1, bnz = 0;
  const axes = [[ac, as], [-as, ac], [bc, bs], [-bs, bc]];
  for (let i = 0; i < 4; i++) {
    const nx = axes[i][0], nz = axes[i][1];
    const ra = ahw * Math.abs(nx * ac + nz * as) + ahl * Math.abs(-nx * as + nz * ac);
    const rb = bhw * Math.abs(nx * bc + nz * bs) + bhl * Math.abs(-nx * bs + nz * bc);
    const ov = ra + rb - Math.abs(dx * nx + dz * nz);
    if (ov <= 0) return { hit: false };
    if (ov < best) {
      best = ov; bnx = nx; bnz = nz;
      if (dx * nx + dz * nz < 0) { bnx = -bnx; bnz = -bnz; }
    }
  }
  const pa = boxSupport(ax, az, ahw, ahl, ath, -bnx, -bnz);
  const pb = boxSupport(bx, bz, bhw, bhl, bth, bnx, bnz);
  return {
    hit: true, pen: best, nx: bnx, nz: bnz,
    x: (pa.x + pb.x) * 0.5, z: (pa.z + pb.z) * 0.5
  };
}

function makeCar(id, slot, drift) {
  return {
    id, slot, z: START_Z, x: roadX(START_Z) + drift * ROADH,
    spd: 0, drift, driftV: 0, steer: 0, brake: false,
    done: false, finishT: 0, damage: 0, bumpCd: 0,
    input: { l: 0, r: 0, u: 0, d: 0 }
  };
}
function resetCar(car, drift) {
  car.z = START_Z;
  car.x = roadX(car.z) + drift * ROADH;
  car.spd = 0; car.drift = drift; car.driftV = 0; car.steer = 0;
  car.brake = false; car.done = false; car.finishT = 0;
  car.damage = 0; car.bumpCd = 0;
  car.input = { l: 0, r: 0, u: 0, d: 0 };
}

function sanitizeInput(input) {
  return {
    l: input && input.l ? 1 : 0,
    r: input && input.r ? 1 : 0,
    u: input && input.u ? 1 : 0,
    d: input && input.d ? 1 : 0
  };
}

function stepCar(car, dt, raceT) {
  if (car.done) return;
  const input = car.input;
  const dmgRatio = Math.min(1, car.damage / 14);
  const sCar = car.z;
  const bendN = clamp((roadX(sCar + 170) - roadX(sCar - 170)) / 620, -1, 1);
  const offRoad = Math.abs(car.drift) > ONG;
  const steerIn = (input.l ? -1 : 0) + (input.r ? 1 : 0);
  car.steer += (steerIn - car.steer) * (1 - Math.exp(-dt * 14));
  const dmgSteer = (offRoad ? 0.45 : 1) * (1 - 0.26 * dmgRatio);
  car.drift += (-bendN * 1.40 * (car.spd / MAXSPD) * (1 + 0.08 * dmgRatio) +
    car.steer * 1.15 * dmgSteer) * dt;
  car.drift += car.driftV * dt;
  car.driftV *= Math.exp(-dt * (4.8 - 1.2 * dmgRatio));
  car.drift = clamp(car.drift, -1.05, 1.05);

  if (input.u) {
    const acc = gearAcc(Math.abs(car.spd) / MAXSPD) * (1 - 0.18 * dmgRatio);
    car.spd = Math.min(MAXSPD * (1 - 0.075 * dmgRatio), car.spd + acc * dt);
  } else if (input.d) {
    if (car.spd > 0) car.spd = Math.max(0, car.spd - 1400 * dt);
    else car.spd = Math.max(-REVSPD, car.spd - 300 * dt);
  } else {
    if (car.spd > 0) car.spd = Math.max(0, car.spd - 100 * dt);
    else car.spd = Math.min(0, car.spd + 220 * dt);
  }
  car.brake = !!input.d && car.spd >= -0.5;

  const capF = offRoad ? Math.min(MAXSPD * 0.45, MAXSPD * (1 - 0.075 * dmgRatio)) : MAXSPD * (1 - 0.075 * dmgRatio);
  const capR = offRoad ? REVSPD * 0.45 : REVSPD;
  if (car.spd > capF) car.spd = Math.max(capF, car.spd - 620 * dt);
  if (car.spd < -capR) car.spd = Math.min(-capR, car.spd + 620 * dt);

  car.z += car.spd * dt;
  if (car.z < 0) { car.z = 0; car.spd = Math.max(0, car.spd); }
  car.x = roadX(car.z) + car.drift * ROADH;
  if (car.z >= FINISH_Z && !car.done) {
    car.done = true;
    car.finishT = raceT;
  }
}

function stepContact(a, b, dt) {
  if (a.done || b.done) return;
  const hit = boxContact(
    a.x, a.z, CAR_HALF_W, CAR_HALF_L, -carTilt(a),
    b.x, b.z, CAR_HALF_W, CAR_HALF_L, -carTilt(b)
  );
  if (!hit.hit) return;

  const nx = hit.nx, nz = hit.nz;
  let corr = Math.max(0, hit.pen - 0.02) * 0.85;
  a.drift = clamp(a.drift + nx * corr / ROADH, -1.05, 1.05);
  b.drift = clamp(b.drift - nx * corr / ROADH, -1.05, 1.05);
  a.z = Math.max(0, a.z + nz * corr);
  b.z = Math.max(0, b.z - nz * corr);
  a.x = roadX(a.z) + a.drift * ROADH;
  b.x = roadX(b.z) + b.drift * ROADH;

  for (let pass = 0; pass < 4; pass++) {
    const post = boxContact(
      a.x, a.z, CAR_HALF_W, CAR_HALF_L, -carTilt(a),
      b.x, b.z, CAR_HALF_W, CAR_HALF_L, -carTilt(b)
    );
    if (!post.hit || post.pen <= 0.03) break;
    corr = Math.max(0, post.pen - 0.01) * 0.75;
    a.drift = clamp(a.drift + post.nx * corr / ROADH, -1.05, 1.05);
    b.drift = clamp(b.drift - post.nx * corr / ROADH, -1.05, 1.05);
    a.z = Math.max(0, a.z + post.nz * corr);
    b.z = Math.max(0, b.z - post.nz * corr);
    a.x = roadX(a.z) + a.drift * ROADH;
    b.x = roadX(b.z) + b.drift * ROADH;
  }

  let avx = a.driftV * ROADH, avz = a.spd;
  let bvx = b.driftV * ROADH, bvz = b.spd;
  const rvx = avx - bvx, rvz = avz - bvz;
  const vn = rvx * nx + rvz * nz;
  const impact = Math.max(0, -vn);
  if (vn < 0) {
    const jn = -1.12 * vn * 0.5;
    avx += nx * jn; avz += nz * jn;
    bvx -= nx * jn; bvz -= nz * jn;
    const tx = -nz, tz = nx;
    const vt = rvx * tx + rvz * tz;
    const jt = clamp(-vt * 0.5 * 0.55, -jn * 0.35, jn * 0.35);
    avx += tx * jt; avz += tz * jt;
    bvx -= tx * jt; bvz -= tz * jt;
  }
  a.spd = clamp(avz, -REVSPD, MAXSPD);
  b.spd = clamp(bvz, -REVSPD, MAXSPD);
  a.driftV = clamp(avx / ROADH, -1.8, 1.8);
  b.driftV = clamp(bvx / ROADH, -1.8, 1.8);
  a.z = Math.max(0, a.z); b.z = Math.max(0, b.z);
  a.x = roadX(a.z) + a.drift * ROADH;
  b.x = roadX(b.z) + b.drift * ROADH;

  if (impact > 5) {
    if (a.bumpCd <= 0) { a.damage = Math.min(14, a.damage + (impact > 450 ? 2 : 1)); a.bumpCd = 0.35; }
    if (b.bumpCd <= 0) { b.damage = Math.min(14, b.damage + (impact > 450 ? 2 : 1)); b.bumpCd = 0.35; }
  }
}

function carSnapshot(car) {
  return {
    id: car.id,
    z: Math.round(car.z * 100) / 100,
    x: Math.round(car.x * 100) / 100,
    spd: Math.round(car.spd * 100) / 100,
    drift: Math.round(car.drift * 10000) / 10000,
    driftV: Math.round(car.driftV * 10000) / 10000,
    steer: Math.round(car.steer * 10000) / 10000,
    brake: car.brake,
    done: car.done,
    finishT: car.finishT,
    damage: car.damage
  };
}

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map();
    this.seed = crypto.randomInt(1, 0x7fffffff);
    this.phase = 'waiting';
    this.cars = [
      makeCar('p1', 'p1', -0.58),
      makeCar('p2', 'p2', 0.58)
    ];
    this.raceT = 0;
    this.startAt = 0;
    this.lastSnapshot = 0;
    this.timer = null;
    this.rematchTimer = null;
  }

  add(ws) {
    const slot = this.clients.has('p1') ? 'p2' : 'p1';
    if (this.clients.has(slot)) return null;
    ws.roomCode = this.code;
    ws.playerId = slot;
    this.clients.set(slot, ws);
    this.send(ws, {
      type: 'joined',
      room: this.code,
      playerId: slot,
      seed: this.seed,
      phase: this.phase,
      startAt: this.startAt || null,
      startZ: START_Z
    });
    if (this.clients.size === 2 && this.phase === 'waiting') this.beginRace();
    return slot;
  }

  remove(ws) {
    const slot = ws.playerId;
    if (!slot || this.clients.get(slot) !== ws) return;
    this.clients.delete(slot);
    this.broadcast({ type: 'peerLeft', playerId: slot });
    if (this.clients.size === 0) {
      clearInterval(this.timer);
      clearTimeout(this.rematchTimer);
      this.timer = null;
      rooms.delete(this.code);
    } else if (this.phase === 'countdown' || this.phase === 'run') {
      this.broadcast({ type: 'aborted', reason: 'peer-left' });
      this.phase = 'waiting';
      clearInterval(this.timer);
      this.timer = null;
    } else if (this.phase === 'finished') {
      /* A new opponent may join after the result; do not leave the room
         permanently stuck in the finished state. */
      this.phase = 'waiting';
      clearTimeout(this.rematchTimer);
      this.rematchTimer = null;
    }
  }

  send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg) {
    for (const ws of this.clients.values()) this.send(ws, msg);
  }

  beginRace() {
    clearInterval(this.timer);
    clearTimeout(this.rematchTimer);
    this.seed = crypto.randomInt(1, 0x7fffffff);
    this.phase = 'countdown';
    this.raceT = 0;
    this.startAt = Date.now() + COUNTDOWN_MS;
    this.lastSnapshot = 0;
    resetCar(this.cars[0], -0.58);
    resetCar(this.cars[1], 0.58);
    this.broadcast({
      type: 'start',
      room: this.code,
      seed: this.seed,
      startAt: this.startAt,
      startZ: START_Z,
      duration: RUNTIME,
      players: Array.from(this.clients.keys())
    });
    this.broadcast({
      type: 'state',
      tick: 0,
      phase: 'countdown',
      raceT: 0,
      cars: this.cars.map(carSnapshot)
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    const now = Date.now();
    if (this.phase === 'countdown' && now >= this.startAt) {
      this.phase = 'run';
      this.raceT = 0;
    }
    if (this.phase === 'run') {
      this.raceT += DT;
      for (const car of this.cars) {
        car.bumpCd = Math.max(0, car.bumpCd - DT);
        stepCar(car, DT, this.raceT);
      }
      stepContact(this.cars[0], this.cars[1], DT);
      const bothDone = this.cars.every(car => car.done);
      if (bothDone || this.raceT >= RUNTIME) {
        this.finish(bothDone ? 'finish' : 'timeup');
        return;
      }
    }
    if (now - this.lastSnapshot >= SNAPSHOT_MS) {
      this.lastSnapshot = now;
      this.broadcast({
        type: 'state',
        tick: Math.max(0, Math.round(this.raceT * 60)),
        phase: this.phase,
        raceT: Math.round(this.raceT * 1000) / 1000,
        cars: this.cars.map(carSnapshot)
      });
    }
  }

  finish(reason) {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    clearInterval(this.timer);
    this.timer = null;
    const p1 = this.cars[0], p2 = this.cars[1];
    let winnerId;
    if (reason === 'finish' && p1.done && p2.done) {
      winnerId = p1.finishT <= p2.finishT ? 'p1' : 'p2';
    } else {
      winnerId = p1.z >= p2.z ? 'p1' : 'p2';
    }
    this.broadcast({
      type: 'finish',
      reason,
      winnerId,
      duration: RUNTIME,
      raceT: Math.round(this.raceT * 1000) / 1000,
      cars: this.cars.map(carSnapshot)
    });
    this.rematchTimer = setTimeout(() => {
      if (this.clients.size === 2 && this.phase === 'finished') this.beginRace();
    }, REMATCH_MS);
  }
}

const server = http.createServer((req, res) => {
  let pathname = req.url || '/';
  const qmark = pathname.indexOf('?');
  if (qmark >= 0) pathname = pathname.slice(0, qmark);
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(INDEX_PATH, (err, body) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('frontend unavailable');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(body);
    });
    return;
  }
  if (pathname === '/health') {
    const body = JSON.stringify({
      ok: true,
      service: 'driftrace-race',
      rooms: rooms.size,
      clients: Array.from(rooms.values()).reduce((n, room) => n + room.clients.size, 0),
      uptime: Math.round(process.uptime())
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('driftrace-race: upgrade /ws');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.roomCode = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
    ws.clientId = nextClientId++;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (!ws.roomCode) {
    ws.send(JSON.stringify({ type: 'error', message: 'room-required' }));
    ws.close(1008, 'room-required');
    return;
  }
  let room = rooms.get(ws.roomCode);
  if (!room) {
    room = new Room(ws.roomCode);
    rooms.set(ws.roomCode, room);
  }
  if (room.clients.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'room-full' }));
    ws.close(1008, 'room-full');
    return;
  }
  room.add(ws);

  ws.on('message', data => {
    if (data.length > 1024) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type !== 'input' || !ws.playerId) return;
    const car = room.cars.find(c => c.slot === ws.playerId);
    if (car) car.input = sanitizeInput(msg.input);
  });

  ws.on('close', () => room.remove(ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`driftrace-race listening on ${HOST}:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) {
    clearInterval(room.timer);
    clearTimeout(room.rematchTimer);
  }
  for (const ws of wss.clients) ws.close(1001, 'server-shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
