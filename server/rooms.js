'use strict';

const crypto = require('crypto');
const G = require('./game');
const AI = require('./ai');

const COLORS = ['#ff4f00', '#1f6fb2', '#d4a017', '#2e8b57', '#8e44ad', '#e84393'];
const COLOR_NAMES = {
  '#ff4f00': 'International Orange', '#1f6fb2': 'Bay Blue', '#d4a017': 'Cable Car Gold',
  '#2e8b57': 'Muni Green', '#8e44ad': 'Painted Lady Purple', '#e84393': 'Sunset Pink',
};
const AI_NAMES = ['Sutro Bot', 'Dolores Droid', 'Nob Hill Nora', 'Haight Hal', 'Embarcadero Ed', 'Twin Peaks Tess', 'Bernal Bot', 'Muni Max'];
const GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 10000);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS || 1100);
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const newToken = () => crypto.randomBytes(18).toString('base64url');
const newCode = () => Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);

class Room {
  constructor(data, mgr) {
    this.data = data; // persisted: { code, hostToken, seats, status, game, version, createdAt }
    this.mgr = mgr;
    this.clients = new Set(); // { ws, token }
    this.disconnectedAt = {}; // seat -> ms
    this.timer = null;
    this.saving = Promise.resolve();
    this.saveTimer = null;
    const now = Date.now();
    data.seats.forEach((s, i) => { if (s && s.kind === 'human') this.disconnectedAt[i] = now; });
  }

  get code() { return this.data.code; }

  seatOf(token) {
    if (!token) return null;
    const i = this.data.seats.findIndex((s) => s && s.kind === 'human' && s.token === token);
    return i >= 0 ? i : null;
  }

  isConnected(seat) {
    const s = this.data.seats[seat];
    if (!s || s.kind !== 'human') return false;
    for (const c of this.clients) if (c.token === s.token) return true;
    return false;
  }

  aiControls(seat, now = Date.now()) {
    const s = this.data.seats[seat];
    if (!s) return false;
    if (s.kind === 'ai') return true;
    if (this.isConnected(seat)) return false;
    const since = this.disconnectedAt[seat];
    return since !== undefined && now - since >= GRACE_MS;
  }

  publicRoom() {
    const now = Date.now();
    return {
      code: this.code,
      status: this.data.status,
      seats: this.data.seats.map((s, i) => (s ? {
        kind: s.kind,
        name: s.name,
        color: s.color,
        isHost: s.kind === 'human' && s.token === this.data.hostToken,
        connected: s.kind === 'ai' ? true : this.isConnected(i),
        covered: this.data.status === 'playing' && s.kind === 'human' && this.aiControls(i, now),
      } : null)),
      colors: COLORS,
      colorNames: COLOR_NAMES,
    };
  }

  broadcast() {
    for (const c of this.clients) this.sendState(c);
  }

  sendState(c) {
    const seat = this.seatOf(c.token);
    const msg = {
      type: 'state',
      version: this.data.version,
      room: this.publicRoom(),
      you: { seat, isHost: c.token === this.data.hostToken },
      game: this.data.game ? G.viewFor(this.data.game, seat) : null,
    };
    send(c.ws, msg);
  }

  changed() {
    this.data.version += 1;
    this.data.updatedAt = Date.now();
    this.scheduleSave();
    this.broadcast();
    this.schedule();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const snapshot = JSON.parse(JSON.stringify(this.data));
      this.saving = this.saving
        .then(() => this.mgr.store.save(this.code, snapshot))
        .catch((err) => console.error(`[room ${this.code}] save failed`, err));
    }, 150);
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const snapshot = JSON.parse(JSON.stringify(this.data));
      this.saving = this.saving.then(() => this.mgr.store.save(this.code, snapshot));
    }
    await this.saving;
  }

  // ---- AI / turn-cover scheduling ----
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const g = this.data.game;
    if (this.data.status !== 'playing' || !g || g.phase === 'gameover') return;
    const now = Date.now();
    const actors = G.pendingActors(g);
    let wakeAt = Infinity;
    let ready = false;
    for (const seat of actors) {
      if (this.aiControls(seat, now)) { ready = true; break; }
      const s = this.data.seats[seat];
      if (s && s.kind === 'human' && !this.isConnected(seat) && this.disconnectedAt[seat] !== undefined) {
        wakeAt = Math.min(wakeAt, this.disconnectedAt[seat] + GRACE_MS);
      }
    }
    if (g.trade && this.aiControls(g.trade.from, now)) {
      wakeAt = Math.min(wakeAt, g.trade.createdAt + AI.TRADE_WAIT_MS + 50);
    }
    if (ready) {
      const quick = g.phase === 'discard' || (g.trade && actors[0] !== g.turn);
      this.timer = setTimeout(() => this.runAI(), quick ? Math.round(AI_DELAY_MS * 0.6) : AI_DELAY_MS);
    } else if (wakeAt !== Infinity) {
      this.timer = setTimeout(() => this.schedule(), Math.max(50, wakeAt - now));
    }
  }

  runAI() {
    const g = this.data.game;
    if (!g || g.phase === 'gameover') return;
    const now = Date.now();
    for (const seat of G.pendingActors(g)) {
      if (!this.aiControls(seat, now)) continue;
      let action = AI.chooseAction(g, seat, now);
      if (!action) continue;
      let res = G.applyActionAt(g, seat, action, now);
      if (!res.ok) {
        console.error(`[room ${this.code}] AI seat ${seat} illegal action`, action, res.error);
        action = g.turn === seat && g.phase === 'main' ? { type: 'endTurn' } : null;
        res = action ? G.applyActionAt(g, seat, action, now) : res;
        if (!res.ok) continue;
      }
      if (g.phase === 'gameover') this.data.status = 'over';
      this.changed();
      return;
    }
    this.schedule();
  }

  // ---- client messages ----
  handle(c, msg) {
    const d = this.data;
    const seat = this.seatOf(c.token);
    const isHost = c.token === d.hostToken;
    switch (msg.type) {
      case 'takeSeat': {
        if (d.status !== 'lobby') return this.error(c, 'The game has already started.');
        const i = msg.seat;
        const name = cleanName(msg.name);
        if (!Number.isInteger(i) || i < 0 || i > 3) return this.error(c, 'Pick a seat.');
        if (!name) return this.error(c, 'Enter a display name.');
        if (!COLORS.includes(msg.color)) return this.error(c, 'Pick a color.');
        if (d.seats.some((s, j) => s && j !== seat && s.color === msg.color)) return this.error(c, 'That color is taken.');
        if (d.seats[i] && i !== seat) return this.error(c, 'That seat is taken.');
        if (seat !== null && seat !== i) d.seats[seat] = null;
        d.seats[i] = { kind: 'human', token: c.token, name, color: msg.color };
        delete this.disconnectedAt[i];
        return this.changed();
      }
      case 'leaveSeat': {
        if (d.status !== 'lobby' || seat === null) return;
        d.seats[seat] = null;
        return this.changed();
      }
      case 'fillAI': {
        if (d.status !== 'lobby') return;
        if (!isHost) return this.error(c, 'Only the host can add AI players.');
        const usedNames = new Set(d.seats.filter(Boolean).map((s) => s.name));
        for (let i = 0; i < 4; i++) {
          if (d.seats[i]) continue;
          const color = COLORS.find((col) => !d.seats.some((s) => s && s.color === col));
          const name = AI_NAMES.find((n) => !usedNames.has(n));
          usedNames.add(name);
          d.seats[i] = { kind: 'ai', name, color };
        }
        return this.changed();
      }
      case 'removeAI': {
        if (d.status !== 'lobby') return;
        if (!isHost) return this.error(c, 'Only the host can remove AI players.');
        const s = d.seats[msg.seat];
        if (!s || s.kind !== 'ai') return;
        d.seats[msg.seat] = null;
        return this.changed();
      }
      case 'start': {
        if (d.status !== 'lobby') return;
        if (!isHost) return this.error(c, 'Only the host can start the game.');
        if (d.seats.some((s) => !s)) return this.error(c, 'All 4 seats must be filled to start.');
        d.game = G.createGame(d.seats.map((s) => ({ name: s.name, color: s.color, isAI: s.kind === 'ai' })));
        d.status = 'playing';
        return this.changed();
      }
      case 'action': {
        if (d.status !== 'playing' || !d.game) return this.error(c, 'The game is not running.');
        if (seat === null) return this.error(c, "You're watching this game.");
        if (msg.version !== undefined && msg.version !== d.version) {
          this.sendState(c);
          return this.error(c, 'The board just changed - try that again.');
        }
        const res = G.applyActionAt(d.game, seat, msg.action, Date.now());
        if (!res.ok) return this.error(c, res.error);
        if (d.game.phase === 'gameover') d.status = 'over';
        return this.changed();
      }
      default:
        return this.error(c, 'Unknown message.');
    }
  }

  error(c, message) { send(c.ws, { type: 'error', message }); }

  attach(c) {
    this.clients.add(c);
    const seat = this.seatOf(c.token);
    if (seat !== null) delete this.disconnectedAt[seat];
    this.broadcast();
    this.schedule();
  }

  detach(c) {
    this.clients.delete(c);
    const seat = this.seatOf(c.token);
    if (seat !== null && !this.isConnected(seat)) this.disconnectedAt[seat] = Date.now();
    this.broadcast();
    this.schedule();
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

class RoomManager {
  constructor(store) {
    this.store = store;
    this.rooms = new Map();
    this.loading = new Map();
  }

  async create() {
    let code;
    for (let i = 0; i < 20; i++) {
      code = newCode();
      if (!this.rooms.has(code) && !(await this.store.exists(code))) break;
    }
    const hostToken = newToken();
    const data = { code, hostToken, seats: [null, null, null, null], status: 'lobby', game: null, version: 1, createdAt: Date.now(), updatedAt: Date.now() };
    const room = new Room(data, this);
    this.rooms.set(code, room);
    await this.store.save(code, data);
    return { code, token: hostToken };
  }

  async get(code) {
    code = String(code || '').toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return null;
    if (this.rooms.has(code)) return this.rooms.get(code);
    if (!this.loading.has(code)) {
      this.loading.set(code, (async () => {
        const data = await this.store.load(code);
        if (!data) return null;
        const room = new Room(data, this);
        this.rooms.set(code, room);
        room.schedule();
        return room;
      })().finally(() => this.loading.delete(code)));
    }
    return this.loading.get(code);
  }

  async flushAll() {
    await Promise.all([...this.rooms.values()].map((r) => r.flush().catch(() => {})));
  }

  // free memory for rooms nobody is connected to
  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.clients.size === 0 && now - room.data.updatedAt > 30 * 60 * 1000) {
        room.flush().then(() => {
          if (room.clients.size === 0) {
            clearTimeout(room.timer);
            this.rooms.delete(code);
          }
        });
      }
    }
  }
}

module.exports = { RoomManager, newToken, COLORS };
