'use strict';
/* Settlers of San Francisco - browser client. The server is authoritative; this file only renders and sends intents. */

const RES = ['redwood', 'brick', 'sourdough', 'coffee', 'chips'];
const META = {
  redwood: { name: 'Redwood', icon: '🌲', color: '#2f6b3a', place: 'The Presidio' },
  brick: { name: 'Bricks', icon: '🧱', color: '#b5523b', place: 'The Painted Ladies' },
  sourdough: { name: 'Sourdough', icon: '🍞', color: '#d9a441', place: "Fisherman's Wharf" },
  coffee: { name: 'Coffee', icon: '☕', color: '#7b4f33', place: 'North Beach' },
  chips: { name: 'Microchips', icon: '💾', color: '#56658a', place: 'SoMa' },
  bay: { name: 'Open Bay', icon: '🌊', color: '#8fb3c9', place: "Karl the Fog's home" },
};
const HUSTLE = {
  fogHorn: { name: 'Fog Horn', icon: '📯', text: 'Move Karl the Fog and pinch a card.' },
  foundingGrant: { name: 'Founding Grant', icon: '📜', text: '+1 victory point (kept secret).' },
  roadTrip: { name: 'Road Trip', icon: '🚐', text: 'Build 2 free bike paths.' },
  farmersMarket: { name: 'Farmers Market', icon: '🥕', text: 'Take any 2 resources.' },
  monopoly: { name: 'Monopoly', icon: '🎩', text: 'Everyone hands you one resource.' },
};
const COSTS = {
  road: { redwood: 1, brick: 1 },
  settlement: { redwood: 1, brick: 1, sourdough: 1, coffee: 1 },
  city: { sourdough: 2, chips: 3 },
  hustle: { sourdough: 1, coffee: 1, chips: 1 },
};
const S = 58; // svg scale

const app = document.getElementById('app');
const ui = {
  ws: null, code: null, token: null, msg: null, busy: false, build: null, modal: null,
  lastLogId: 0, lastDice: null, retry: 0, fatal: null, connected: false,
  name: localStorage.getItem('sosf:name') || '', color: localStorage.getItem('sosf:color') || null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const total = (h) => RES.reduce((n, r) => n + (h?.[r] || 0), 0);
const empty = () => Object.fromEntries(RES.map((r) => [r, 0]));
const canAfford = (hand, cost) => hand && RES.every((r) => (hand[r] || 0) >= (cost[r] || 0));
const costStr = (c) => RES.filter((r) => c[r]).map((r) => META[r].icon.repeat(c[r])).join('');
const cardsStr = (c) => RES.filter((r) => c[r]).map((r) => `${c[r]} ${META[r].icon}`).join(' + ') || 'nothing';

function toast(text, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 3500 : 2500);
}

// ---------------- routing ----------------
function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/);
  if (m) {
    ui.code = m[1].toUpperCase();
    ui.token = localStorage.getItem(`sosf:token:${ui.code}`);
    connect();
  } else {
    renderLanding();
  }
}

async function createGame() {
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('Server error');
    const { code, token } = await res.json();
    localStorage.setItem(`sosf:token:${code}`, token);
    location.href = `/r/${code}`;
  } catch (e) {
    toast('Could not create a game. Is the server awake? Try again in a moment.', true);
  }
}

function renderLanding() {
  app.innerHTML = `
  <div class="landing">
    <div class="bridge">🌉</div>
    <h1>Settlers of <span>San Francisco</span></h1>
    <p class="tagline">Claim the hills, brew the coffee, dodge Karl the Fog. First to 10 points runs the city.</p>
    <div class="cta"><button class="primary" id="create">Create game</button></div>
    <form class="join" id="joinForm"><input type="text" id="joinCode" placeholder="CODE" maxlength="8" aria-label="Room code"><button class="ghost">Join</button></form>
    <div class="howto">
      <h3>How it works</h3>
      <p>Create a game and share the link. Up to 3 friends join from their own devices - AI players take every seat nobody claims. No accounts, just pick a name.</p>
      <div class="tiles-legend">${RES.map((r) => `<span>${META[r].icon} ${META[r].name} - ${META[r].place}</span>`).join('')}<span>🌫️ Karl the Fog - lives in the open bay</span></div>
      <p><b>Each turn:</b> roll the dice; every tile showing that number pays its neighbors. Then trade and build:
      bike path ${costStr(COSTS.road)}, settlement ${costStr(COSTS.settlement)}, city ${costStr(COSTS.city)}, Hustle card ${costStr(COSTS.hustle)}.</p>
      <p><b>Roll a 7</b> and Karl rolls in: big hands lose half, and you move the fog to smother a tile and pinch a card.</p>
      <p><b>Points:</b> settlement 1, city 2, Founding Grant 1, Longest Bike Path 2, Loudest Fog Horn 2. First to 10 wins.</p>
    </div>
  </div>`;
  document.getElementById('create').onclick = (e) => { e.target.disabled = true; createGame(); };
  document.getElementById('joinForm').onsubmit = (e) => {
    e.preventDefault();
    const c = document.getElementById('joinCode').value.trim().toUpperCase();
    if (c) location.href = `/r/${c}`;
  };
}

// ---------------- connection ----------------
function connect() {
  if (ui.fatal) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ui.ws = ws;
  ws.onopen = () => {
    ui.retry = 0;
    ws.send(JSON.stringify({ type: 'hello', room: ui.code, token: ui.token }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') {
      ui.token = msg.token;
      localStorage.setItem(`sosf:token:${ui.code}`, msg.token);
      ui.connected = true;
    } else if (msg.type === 'state') {
      ui.msg = msg;
      ui.busy = false;
      render();
    } else if (msg.type === 'error') {
      ui.busy = false;
      toast(msg.message, true);
      render();
    } else if (msg.type === 'fatal') {
      ui.fatal = msg.message;
      renderFatal();
    }
  };
  ws.onclose = () => {
    ui.connected = false;
    if (ui.fatal) return;
    render();
    const delay = Math.min(5000, 500 * 2 ** ui.retry++);
    setTimeout(connect, delay);
  };
}
setInterval(() => { if (ui.ws && ui.ws.readyState === 1) ui.ws.send('{"type":"ping"}'); }, 25000);

function send(msg) {
  if (!ui.ws || ui.ws.readyState !== 1) return toast('Reconnecting... try again in a second.', true);
  ui.ws.send(JSON.stringify(msg));
}
function act(action) {
  if (ui.busy) return;
  ui.busy = true;
  ui.build = null;
  send({ type: 'action', action, version: ui.msg.version });
  render();
}

function renderFatal() {
  app.innerHTML = `<div class="landing"><div class="bridge">🌫️</div><h1>Lost in the fog</h1><p class="tagline">${esc(ui.fatal)}</p><div class="cta"><button class="primary" onclick="location.href='/'">Go home</button></div></div>`;
}

// ---------------- render root ----------------
function render() {
  if (ui.fatal) return renderFatal();
  if (!ui.msg) {
    app.innerHTML = `<div class="loading">${ui.connected ? 'Loading...' : 'Connecting to the server... (a sleeping server can take up to a minute to wake)'}</div>`;
    return;
  }
  const { room } = ui.msg;
  const top = topbar();
  const log0 = document.querySelector('.log');
  const stick = !log0 || log0.scrollHeight - log0.scrollTop - log0.clientHeight < 40;
  const tpl = document.createElement('div');
  tpl.innerHTML = top + (room.status === 'lobby' ? renderLobby() : renderGame());
  morphChildren(app, tpl);
  bind();
  const log = document.querySelector('.log');
  if (log && stick) log.scrollTop = log.scrollHeight;
}

// Patch the live DOM in place so unchanged elements (and in-progress clicks/focus) survive frequent server updates.
function morphChildren(from, to) {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  b.forEach((nb, i) => {
    const na = a[i];
    if (!na) from.appendChild(nb);
    else if (na.nodeType !== nb.nodeType || na.nodeName !== nb.nodeName) from.replaceChild(nb, na);
    else if (na.nodeType === 1) morphNode(na, nb);
    else if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue;
  });
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

function morphNode(na, nb) {
  for (const { name } of [...na.attributes]) if (!nb.hasAttribute(name)) na.removeAttribute(name);
  for (const { name, value } of [...nb.attributes]) if (na.getAttribute(name) !== value) na.setAttribute(name, value);
  if ('disabled' in na) na.disabled = nb.hasAttribute('disabled');
  if (na.tagName === 'OPTION') na.selected = nb.hasAttribute('selected');
  morphChildren(na, nb);
}

function topbar() {
  return `${ui.ws && ui.ws.readyState === 1 ? '' : '<div class="banner">Connection lost - reconnecting...</div>'}
  <div class="topbar"><div class="brand" data-go-home>🌉 Settlers of <span>San Francisco</span></div>
  <div class="room">Room <span class="code">${esc(ui.msg.room.code)}</span><button class="small" data-copy>Copy invite link</button></div></div>`;
}

// ---------------- lobby ----------------
function renderLobby() {
  const { room, you } = ui.msg;
  const mySeat = you.seat;
  const takenColors = room.seats.filter((s, i) => s && i !== mySeat).map((s) => s.color);
  if (!ui.color || takenColors.includes(ui.color)) ui.color = room.colors.find((c) => !takenColors.includes(c));
  const full = room.seats.every(Boolean);
  const link = `${location.origin}/r/${room.code}`;
  const seats = room.seats.map((s, i) => {
    if (!s) {
      return `<div class="seat"><div class="hint">Seat ${i + 1} - open</div>
        <button data-take="${i}" ${ui.name.trim() ? '' : 'disabled'}>${mySeat === null ? 'Take this seat' : 'Move here'}</button></div>`;
    }
    const me = i === mySeat;
    return `<div class="seat filled" style="border-color:${s.color}">
      <div class="who"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</div>
      <div>${me ? '<span class="badge you">You</span> ' : ''}${s.isHost ? '<span class="badge host">Host</span> ' : ''}${s.kind === 'ai' ? '<span class="badge ai">AI</span> ' : ''}${s.kind === 'human' && !s.connected ? '<span class="badge off">Disconnected</span>' : ''}</div>
      ${s.kind === 'ai' && you.isHost ? `<button class="small ghost" data-remove="${i}">Remove AI</button>` : ''}
      ${me ? '<button class="small ghost" data-leave>Leave seat</button>' : ''}
    </div>`;
  }).join('');
  return `<div class="lobby">
    <div class="panel"><h3 style="margin-top:0">Invite friends</h3>
      <div class="share"><input type="text" readonly value="${esc(link)}" id="shareLink"><button data-copy>Copy link</button></div>
      <p class="hint">Anyone with this link can take an open seat from their own phone or computer.</p></div>
    <div class="panel"><h3 style="margin-top:0">You</h3>
      <div class="me-row"><input type="text" id="nameInput" placeholder="Display name" maxlength="20" value="${esc(ui.name)}">
      <div class="swatches">${room.colors.map((c) => `<button class="swatch ${c === ui.color ? 'sel' : ''} ${takenColors.includes(c) ? 'taken' : ''}" style="background:${c}" title="${esc(room.colorNames[c])}" data-color="${c}" ${takenColors.includes(c) ? 'disabled' : ''}></button>`).join('')}</div>
      ${mySeat !== null ? '<button class="small" data-update>Update</button>' : ''}</div>
      ${mySeat === null ? '<p class="hint">Enter a name, pick a color, then take a seat below.</p>' : ''}</div>
    <div class="panel"><h3 style="margin-top:0">Seats</h3><div class="seats">${seats}</div>
      <div class="lobby-actions">
        ${you.isHost ? `<button data-fill ${full ? 'disabled' : ''}>🤖 Fill seats with AI</button>
        <button class="primary" data-start ${full ? '' : 'disabled'}>Start game</button>
        <span class="hint">${full ? 'All seats filled - ready when you are.' : 'All 4 seats must be filled (friends or AI) to start.'}</span>`
        : `<span class="hint">Waiting for the host to start the game...</span>`}
      </div></div>
  </div>`;
}

// ---------------- game ----------------
function me() {
  const g = ui.msg.game;
  return g && g.you !== null ? g.players[g.you] : null;
}

function promptText() {
  const g = ui.msg.game;
  const you = g.you;
  const cur = g.players[g.turn];
  const mine = g.turn === you;
  const nm = esc(cur.name);
  switch (g.phase) {
    case 'setup': {
      const mineCount = Object.values(g.buildings).filter((b) => b.owner === g.turn).length;
      const round = g.setupStep === 'settlement' ? mineCount + 1 : mineCount;
      if (mine) return [g.setupStep === 'settlement' ? `Setup round ${round}: tap a glowing corner to found a settlement.` : 'Now tap a glowing edge to add a bike path next to it.', true];
      return [`${nm} is placing a ${g.setupStep === 'road' ? 'bike path' : 'settlement'}...`, false];
    }
    case 'roll': return mine ? ['Your turn! Roll the dice.', true] : [`Waiting for ${nm} to roll...`, false];
    case 'discard': {
      const n = g.discards[you];
      if (n) return [`Karl rolled in! Discard ${n} cards.`, true];
      return ['Waiting for players to discard...', false];
    }
    case 'robber': return mine ? ['Move Karl the Fog: tap any other tile.', true] : [`${nm} is moving Karl the Fog...`, false];
    case 'steal': return mine ? ['Pick who to pinch a card from.', true] : [`${nm} is choosing who to rob...`, false];
    case 'roadTrip': return mine ? [`Road Trip: place ${g.freeRoads} free bike path${g.freeRoads === 1 ? '' : 's'}.`, true] : [`${nm} is on a Road Trip...`, false];
    case 'main':
      if (mine) return [ui.build ? `Tap a glowing spot to build a ${ui.build === 'road' ? 'bike path' : ui.build}. (Esc to cancel)` : 'Trade and build, then end your turn.', true];
      return [`${nm} is trading and building...`, false];
    case 'gameover': return [`${esc(g.players[g.winner].name)} wins!`, true];
    default: return ['', false];
  }
}

function renderGame() {
  const g = ui.msg.game;
  const [text, mine] = promptText();
  const diceChanged = JSON.stringify(g.dice) !== JSON.stringify(ui.lastDice);
  ui.lastDice = g.dice;
  const dice = g.dice ? `<div class="dice">${g.dice.map((d) => `<div class="die ${diceChanged ? 'roll' : ''}">${d}</div>`).join('')}</div>` : '';
  return `<div class="game">
    <div class="board-wrap">${renderBoard()}<div class="status"><div class="prompt ${mine ? 'mine' : ''}">${text}</div>${dice}</div></div>
    <div class="side">${renderTrade()}${renderActions()}${renderHand()}${renderPlayers()}${renderLog()}</div>
  </div>${renderModal()}`;
}

function hexPoints(g, h) {
  return h.vertices.map((v) => `${(g.board.vertices[v].x * S).toFixed(1)},${(g.board.vertices[v].y * S).toFixed(1)}`).join(' ');
}

function renderBoard() {
  const g = ui.msg.game;
  const b = g.board;
  const you = g.you;
  const myTurn = g.turn === you && !ui.busy;
  const sum = g.dice ? g.dice[0] + g.dice[1] : null;
  const legal = g.legal || { settlements: [], roads: [], cities: [] };
  let showV = [];
  let showE = [];
  let showC = [];
  if (myTurn && g.phase === 'setup') {
    if (g.setupStep === 'settlement') showV = legal.settlements; else showE = legal.roads;
  } else if (myTurn && g.phase === 'roadTrip') showE = legal.roads;
  else if (myTurn && g.phase === 'main') {
    if (ui.build === 'road') showE = legal.roads;
    if (ui.build === 'settlement') showV = legal.settlements;
    if (ui.build === 'city') showC = legal.cities;
  }
  const pickHex = myTurn && g.phase === 'robber';
  const parts = [];
  // harbors
  for (const hb of b.harbors) {
    for (const v of hb.vertices) parts.push(`<line class="harbor-line" x1="${hb.x * S}" y1="${hb.y * S}" x2="${b.vertices[v].x * S}" y2="${b.vertices[v].y * S}"/>`);
  }
  for (const hb of b.harbors) {
    const label = hb.type === 'any' ? '3:1' : `2:1`;
    parts.push(`<g><title>${hb.type === 'any' ? 'Harbor: trade any 3 identical cards for 1' : `Harbor: trade 2 ${META[hb.type].name} for 1`}</title><circle class="harbor" cx="${hb.x * S}" cy="${hb.y * S}" r="17"/>
      <text class="harbor-txt" x="${hb.x * S}" y="${hb.y * S + (hb.type === 'any' ? 0 : -5)}">${label}</text>
      ${hb.type !== 'any' ? `<text x="${hb.x * S}" y="${hb.y * S + 8}" text-anchor="middle" dominant-baseline="central" font-size="11">${META[hb.type].icon}</text>` : ''}</g>`);
  }
  // tiles
  for (const h of b.hexes) {
    const m = META[h.res];
    const hot = sum && h.num === sum && h.id !== g.fog;
    const cx = h.x * S;
    const cy = h.y * S;
    parts.push(`<g><title>${m.place} - ${m.name}${h.num ? ` (${h.num})` : ''}</title><polygon class="hex ${hot ? 'hot' : ''}" points="${hexPoints(g, h)}" fill="${m.color}"/>
      <text x="${cx}" y="${cy - 22}" text-anchor="middle" dominant-baseline="central" font-size="22">${m.icon}</text>`);
    if (h.num) {
      const red = h.num === 6 || h.num === 8;
      const dots = 6 - Math.abs(7 - h.num);
      parts.push(`<circle class="token" cx="${cx}" cy="${cy + 8}" r="16"/><text class="token-num ${red ? 'hot' : ''}" x="${cx}" y="${cy + 5}" font-size="${red ? 16 : 14}">${h.num}</text>`);
      for (let i = 0; i < dots; i++) parts.push(`<circle class="pip ${red ? 'hot' : ''}" cx="${cx + (i - (dots - 1) / 2) * 4.5}" cy="${cy + 17}" r="1.6"/>`);
    } else {
      parts.push(`<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="10" fill="#fff" font-weight="700">OPEN BAY</text>`);
    }
    parts.push('</g>');
  }
  // fog
  const fh = b.hexes[g.fog];
  parts.push(`<g class="fog-cloud"><polygon points="${hexPoints(g, fh)}" fill="rgba(220,226,232,.55)"/><text x="${fh.x * S}" y="${fh.y * S + 6}" text-anchor="middle" dominant-baseline="central" font-size="38">🌫️</text></g>`);
  // roads
  for (const [e, owner] of Object.entries(g.roads)) {
    const [a, c] = b.edges[e].v;
    const A = b.vertices[a];
    const C = b.vertices[c];
    const x1 = A.x * S + (C.x - A.x) * S * 0.12; const y1 = A.y * S + (C.y - A.y) * S * 0.12;
    const x2 = C.x * S - (C.x - A.x) * S * 0.12; const y2 = C.y * S - (C.y - A.y) * S * 0.12;
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d2a36" stroke-width="10" stroke-linecap="round"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${g.players[owner].color}" stroke-width="6.5" stroke-linecap="round"/>`);
  }
  // buildings
  for (const [v, bd] of Object.entries(g.buildings)) {
    const p = b.vertices[v];
    const x = p.x * S; const y = p.y * S;
    const col = g.players[bd.owner].color;
    if (bd.type === 'city') {
      parts.push(`<path d="M${x - 13} ${y + 10} V${y - 4} L${x - 6} ${y - 11} L${x + 1} ${y - 4} V${y - 7} H${x + 13} V${y + 10} Z" fill="${col}" stroke="#1d2a36" stroke-width="2.2" stroke-linejoin="round"/><rect x="${x + 4}" y="${y - 2}" width="4" height="4" fill="#fff8"/>`);
    } else {
      parts.push(`<path d="M${x - 9} ${y + 8} V${y - 2} L${x} ${y - 10} L${x + 9} ${y - 2} V${y + 8} Z" fill="${col}" stroke="#1d2a36" stroke-width="2.2" stroke-linejoin="round"/>`);
    }
  }
  // hex targets for fog
  if (pickHex) for (const h of b.hexes) if (h.id !== g.fog) parts.push(`<polygon class="hex-target" points="${hexPoints(g, h)}" data-hex="${h.id}"/>`);
  for (const e of showE) {
    const [a, c] = b.edges[e].v;
    parts.push(`<line class="spot-e" x1="${b.vertices[a].x * S}" y1="${b.vertices[a].y * S}" x2="${b.vertices[c].x * S}" y2="${b.vertices[c].y * S}" data-edge="${e}"/>`);
  }
  for (const v of showV) parts.push(`<circle class="spot-v" cx="${b.vertices[v].x * S}" cy="${b.vertices[v].y * S}" r="9" data-vertex="${v}"/>`);
  for (const v of showC) parts.push(`<circle class="spot-c" cx="${b.vertices[v].x * S}" cy="${b.vertices[v].y * S}" r="16" data-city="${v}"/><circle cx="${b.vertices[v].x * S}" cy="${b.vertices[v].y * S}" r="16" fill="transparent" data-city="${v}" style="cursor:pointer"/>`);
  const xs = b.vertices.map((v) => v.x * S).concat(b.harbors.map((h) => h.x * S));
  const ys = b.vertices.map((v) => v.y * S).concat(b.harbors.map((h) => h.y * S));
  const pad = 26;
  const minX = Math.min(...xs) - pad; const minY = Math.min(...ys) - pad - 40;
  const w = Math.max(...xs) - minX + pad; const h = Math.max(...ys) - minY + pad;
  return `<svg viewBox="${minX} ${minY} ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-label="Game board">${parts.join('')}</svg>`;
}

function renderActions() {
  const g = ui.msg.game;
  const p = me();
  if (!p) return `<div class="panel"><h4>Spectating</h4><p class="hint">You're watching this game. Hands stay hidden.</p></div>`;
  if (g.phase === 'gameover') return `<div class="panel"><h4>Game over</h4><div class="actions"><button class="primary" data-newgame>New game</button><button class="ghost" data-show-final>Final scores</button></div></div>`;
  const mine = g.turn === g.you;
  const b = ui.busy;
  const playableFog = mine && !g.hustlePlayed && (p.hustle || []).some((c) => c.type === 'fogHorn' && !c.fresh);
  let body = '';
  if (g.phase === 'roll' && mine) {
    body = `<div class="actions"><button class="primary" data-roll ${b ? 'disabled' : ''}>🎲 Roll dice</button>${playableFog ? `<button data-play="fogHorn" ${b ? 'disabled' : ''}>📯 Fog Horn first</button>` : ''}</div>`;
  } else if (g.phase === 'discard' && g.discards[g.you]) {
    body = `<div class="actions"><button class="primary" data-open-discard>Choose ${g.discards[g.you]} cards to discard</button></div>`;
  } else if (g.phase === 'steal' && mine) {
    body = `<div class="actions">${g.stealFrom.map((s) => `<button data-steal="${s}" style="background:${g.players[s].color}" ${b ? 'disabled' : ''}>Rob ${esc(g.players[s].name)} (${g.players[s].cardCount} 🃏)</button>`).join('')}</div>`;
  } else if (g.phase === 'main' && mine) {
    const legal = g.legal || { settlements: [], roads: [], cities: [] };
    const h = p.hand;
    const pieces = p.pieces;
    const btn = (kind, label, cost, ok) => `<button data-build="${kind}" class="${ui.build === kind ? 'active' : ''}" ${ok && !b ? '' : 'disabled'}><span>${label}</span><span class="cost">${costStr(cost)}</span></button>`;
    body = `<div class="actions"><button data-open-trade ${b || g.trade ? 'disabled' : ''}>🤝 Trade</button><button class="primary" data-end ${b ? 'disabled' : ''}>End turn ➡️</button></div>
      <div class="build-grid">
        ${btn('road', `🚲 Bike path (${15 - pieces.road} left)`, COSTS.road, canAfford(h, COSTS.road) && legal.roads.length)}
        ${btn('settlement', `🏠 Settlement (${5 - pieces.settlement} left)`, COSTS.settlement, canAfford(h, COSTS.settlement) && legal.settlements.length)}
        ${btn('city', `🏙️ City (${4 - pieces.city} left)`, COSTS.city, canAfford(h, COSTS.city) && legal.cities.length)}
        <button data-buy ${canAfford(h, COSTS.hustle) && g.deckCount && !b ? '' : 'disabled'}><span>🃏 Hustle card (${g.deckCount})</span><span class="cost">${costStr(COSTS.hustle)}</span></button>
      </div>`;
  } else {
    body = `<p class="hint" style="margin:0">${mine ? 'Follow the prompt on the board.' : `It's ${esc(g.players[g.turn].name)}'s turn.`}</p>`;
  }
  return `<div class="panel"><h4>Actions <span>Turn ${g.turnNumber || 'setup'}</span></h4>${body}</div>`;
}

function renderHand() {
  const g = ui.msg.game;
  const p = me();
  if (!p || !p.hand) return '';
  const cards = RES.map((r) => `<div class="rcard ${p.hand[r] ? '' : 'zero'}" style="background:${META[r].color}" title="${META[r].name}"><div class="ico">${META[r].icon}</div><div class="n">${p.hand[r]}</div><div class="lbl">${META[r].name}</div></div>`).join('');
  const mine = g.turn === g.you;
  const hus = (p.hustle || []).map((c) => {
    const info = HUSTLE[c.type];
    const canPlay = mine && !ui.busy && c.type !== 'foundingGrant' && !c.fresh && !g.hustlePlayed && (g.phase === 'main' || (c.type === 'fogHorn' && g.phase === 'roll'));
    return `<div class="hcard"><span style="font-size:22px">${info.icon}</span><div class="t"><b>${info.name}</b>${info.text}${c.fresh ? ' <i>(new - play next turn)</i>' : ''}</div>${c.type !== 'foundingGrant' ? `<button class="small" data-play="${c.type}" ${canPlay ? '' : 'disabled'}>Play</button>` : ''}</div>`;
  }).join('');
  return `<div class="panel"><h4>Your hand <span>${total(p.hand)} cards</span></h4><div class="hand">${cards}</div>
    ${hus ? `<h4 style="margin-top:12px">Hustle cards</h4><div class="hustles">${hus}</div>` : ''}</div>`;
}

function renderPlayers() {
  const g = ui.msg.game;
  const seats = ui.msg.room.seats;
  const rows = g.players.map((p) => {
    const seat = seats[p.seat];
    const isMe = p.seat === g.you;
    const badges = [
      isMe ? '<span class="badge you">You</span>' : '',
      p.isAI ? '<span class="badge ai">AI</span>' : '',
      seat && seat.kind === 'human' && !seat.connected ? '<span class="badge off">Disconnected</span>' : '',
      seat && seat.covered ? '<span class="badge ai">AI covering</span>' : '',
      g.longestRoad === p.seat ? '<span class="badge host" title="Longest Bike Path">🚲 Longest Path</span>' : '',
      g.loudestHorn === p.seat ? '<span class="badge host" title="Loudest Fog Horn">📯 Loudest Horn</span>' : '',
    ].join(' ');
    const hidden = isMe && p.totalVP > p.vp ? `<small>+${p.totalVP - p.vp} secret</small>` : '<small>points</small>';
    return `<div class="prow ${g.turn === p.seat && g.phase !== 'gameover' ? 'turn' : ''}"><div class="bar" style="background:${p.color}"></div>
      <div><div class="nm">${esc(p.name)} ${badges}</div>
      <div class="stats"><span title="Resource cards">🃏 ${p.cardCount}</span><span title="Hustle cards">🎴 ${p.hustleCount}</span><span title="Fog Horns played">📯 ${p.knights}</span><span title="Longest bike path">🚲 ${p.roadLength}</span></div></div>
      <div class="vp">${p.vp}${hidden}</div></div>`;
  }).join('');
  return `<div class="panel"><h4>Players <span>First to 10</span></h4><div class="players">${rows}</div>
    <div class="costs" style="margin-top:8px">Bank: ${RES.map((r) => `${META[r].icon}${g.bank[r]}`).join(' ')} · Hustle deck ${g.deckCount}</div></div>`;
}

function renderLog() {
  const g = ui.msg.game;
  const prev = ui.lastLogId;
  ui.lastLogId = g.log.length ? g.log[g.log.length - 1].id : 0;
  return `<div class="panel"><h4>City news</h4><div class="log">${g.log.map((e) => `<div class="${e.id > prev && prev ? 'new' : ''}">${esc(e.msg)}</div>`).join('')}</div></div>`;
}

function renderTrade() {
  const g = ui.msg.game;
  const t = g.trade;
  if (!t || g.phase !== 'main') return '';
  const from = g.players[t.from];
  const you = g.you;
  let body = '';
  if (t.from === you) {
    body = Object.entries(t.responses).map(([s, r]) => {
      const pl = g.players[s];
      let right = '<span class="hint">thinking...</span>';
      if (r.status === 'decline') right = '<span class="hint">declined</span>';
      if (r.status === 'accept') right = `<button class="small primary" data-accept-trade="${s}" ${ui.busy ? 'disabled' : ''}>Trade</button>`;
      if (r.status === 'counter') right = `<span>counter: you give ${cardsStr(r.give)}, get ${cardsStr(r.get)}</span> <button class="small primary" data-accept-trade="${s}" ${ui.busy ? 'disabled' : ''}>Accept</button>`;
      return `<div class="resp"><span><span class="dot" style="background:${pl.color}"></span> ${esc(pl.name)}</span><span>${right}</span></div>`;
    }).join('') + `<div class="actions" style="margin-top:8px"><button class="ghost small" data-cancel-trade ${ui.busy ? 'disabled' : ''}>Withdraw offer</button></div>`;
    body = `<div class="trade-line">You offer <b>${cardsStr(t.give)}</b> for <b>${cardsStr(t.get)}</b></div>` + body;
  } else {
    const r = you !== null ? t.responses[you] : null;
    const hand = me() && me().hand;
    let mineRow = '';
    if (r && r.status === 'pending') {
      mineRow = `<div class="actions"><button class="primary small" data-respond="accept" ${canAfford(hand, t.get) && !ui.busy ? '' : 'disabled'}>Accept</button><button class="small" data-open-counter ${ui.busy ? 'disabled' : ''}>Counter</button><button class="ghost small" data-respond="decline" ${ui.busy ? 'disabled' : ''}>Decline</button></div>`;
    } else if (r) mineRow = `<p class="hint">You ${r.status === 'accept' ? 'accepted' : r.status === 'counter' ? 'sent a counter' : 'declined'}. Waiting for ${esc(from.name)}.</p>`;
    body = `<div class="trade-line"><b>${esc(from.name)}</b> offers <b>${cardsStr(t.give)}</b> for <b>${cardsStr(t.get)}</b></div>${mineRow}`;
  }
  return `<div class="panel trade-box"><h4>Trade offer</h4>${body}</div>`;
}

// ---------------- modals ----------------
function stepper(key, side, max, val) {
  return RES.map((r) => `<div class="stepper"><div class="ico">${META[r].icon}</div><div class="ctl"><button class="small ghost" data-step="${side}:${r}:-1">-</button><span class="v">${val[r]}</span><button class="small ghost" data-step="${side}:${r}:1" ${max && val[r] >= max[r] ? 'disabled' : ''}>+</button></div>${max ? `<div class="have">have ${max[r]}</div>` : ''}</div>`).join('');
}

function renderModal() {
  const g = ui.msg.game;
  const p = me();
  // forced modals
  if (g.phase === 'gameover' && ui.modal?.kind !== 'closedFinal') return finalModal();
  if (g.phase === 'discard' && p && g.discards[g.you]) {
    if (!ui.modal || ui.modal.kind !== 'discard') ui.modal = { kind: 'discard', sel: empty() };
  } else if (ui.modal && ui.modal.kind === 'discard') ui.modal = null;
  if (ui.modal && (ui.modal.kind === 'counter') && (!g.trade || g.trade.id !== ui.modal.tradeId)) ui.modal = null;
  if (ui.modal && ['trade', 'farmersMarket', 'monopoly'].includes(ui.modal.kind) && (g.phase !== 'main' || g.turn !== g.you)) ui.modal = null;
  const m = ui.modal;
  if (!m || !p) return '';
  if (m.kind === 'discard') {
    const need = g.discards[g.you];
    const n = total(m.sel);
    return `<div class="modal-bg"><div class="modal"><h3>🌫️ Karl rolled in - discard ${need} cards</h3>
      <p class="hint">You're holding more than 7 cards, so half of them blow away.</p>
      <div class="steppers">${stepper('d', 'sel', p.hand, m.sel)}</div>
      <div class="row"><span class="hint" style="margin-right:auto">${n} / ${need} selected</span><button class="primary" data-confirm-discard ${n === need && !ui.busy ? '' : 'disabled'}>Discard</button></div></div></div>`;
  }
  if (m.kind === 'trade' || m.kind === 'counter') {
    const isCounter = m.kind === 'counter';
    const ratios = g.ratios || {};
    const bank = !isCounter ? `<hr><h3>🏦 Trade with the bank</h3><div class="bank-row">Give
      <select id="bankGive">${RES.map((r) => `<option value="${r}" ${m.bankGive === r ? 'selected' : ''}>${ratios[r]} ${META[r].icon} ${META[r].name}</option>`).join('')}</select> for 1
      <select id="bankGet">${RES.map((r) => `<option value="${r}" ${m.bankGet === r ? 'selected' : ''}>${META[r].icon} ${META[r].name}</option>`).join('')}</select>
      <button data-bank ${ui.busy ? 'disabled' : ''}>Trade</button></div><p class="hint">Harbors improve your rate (3:1 any, or 2:1 for one resource).</p>` : '';
    return `<div class="modal-bg"><div class="modal"><h3>${isCounter ? '↩️ Counter-offer' : '🤝 Offer a trade to the table'}</h3>
      <b>You give</b><div class="steppers">${stepper('g', 'give', p.hand, m.give)}</div>
      <b>You get</b><div class="steppers">${stepper('w', 'get', null, m.get)}</div>
      <div class="row"><button class="ghost" data-close>Close</button><button class="primary" data-send-offer ${total(m.give) && total(m.get) && !ui.busy ? '' : 'disabled'}>${isCounter ? 'Send counter' : 'Offer to everyone'}</button></div>
      ${bank}</div></div>`;
  }
  if (m.kind === 'farmersMarket' || m.kind === 'monopoly') {
    const need = m.kind === 'monopoly' ? 1 : 2;
    const picks = m.picks;
    return `<div class="modal-bg"><div class="modal"><h3>${HUSTLE[m.kind].icon} ${HUSTLE[m.kind].name}</h3>
      <p>${m.kind === 'monopoly' ? 'Name a resource. Every rival hands you all of theirs.' : 'Pick 2 resources from the bank (can be the same twice).'}</p>
      <div class="pick-res">${RES.map((r) => `<button style="background:${META[r].color}" data-pick="${r}"><span style="font-size:24px">${META[r].icon}</span>${META[r].name}${m.kind === 'farmersMarket' ? `<small>${picks.filter((x) => x === r).length ? '×' + picks.filter((x) => x === r).length : ''}</small>` : picks[0] === r ? '<small>✓</small>' : ''}</button>`).join('')}</div>
      <div class="row"><button class="ghost" data-close>Cancel</button>${m.kind === 'farmersMarket' ? '<button class="ghost" data-clear-picks>Clear</button>' : ''}<button class="primary" data-confirm-pick ${picks.length === need && !ui.busy ? '' : 'disabled'}>Play card</button></div></div></div>`;
  }
  if (m.kind === 'final') return finalModal();
  return '';
}

function finalModal() {
  const g = ui.msg.game;
  const rows = g.players.slice().sort((a, b) => (b.totalVP ?? b.vp) - (a.totalVP ?? a.vp)).map((p) => {
    const grants = (p.hustle || []).filter((c) => c.type === 'foundingGrant').length;
    return `<tr><td><span class="dot" style="background:${p.color}"></span> ${esc(p.name)}${p.seat === g.winner ? ' 🏆' : ''}</td><td><b>${p.totalVP ?? p.vp}</b></td><td>${p.pieces.settlement}🏠 ${p.pieces.city}🏙️ ${grants ? grants + '📜' : ''} ${g.longestRoad === p.seat ? '🚲' : ''} ${g.loudestHorn === p.seat ? '📯' : ''}</td></tr>`;
  }).join('');
  const winner = g.players[g.winner];
  return `<div class="modal-bg"><div class="modal"><h3>🏆 ${esc(winner.name)} runs San Francisco!</h3>
    <p class="hint">${g.winner === g.you ? 'You won - the city is yours. Enjoy a victory sourdough.' : 'The fog lifts on a new skyline. Better luck next time.'}</p>
    <table class="final"><tr><th>Player</th><th>Points</th><th>Built</th></tr>${rows}</table>
    <div class="row"><button class="ghost" data-close-final>View board</button><button class="primary" data-newgame>New game</button></div></div></div>`;
}

// ---------------- events ----------------
function bind() {
  const once = (el, key) => { el.__bound = el.__bound || new Set(); if (el.__bound.has(key)) return false; el.__bound.add(key); return true; };
  const q = (sel, fn) => document.querySelectorAll(sel).forEach((el) => { if (once(el, sel)) el.addEventListener('click', (e) => { e.preventDefault(); fn(el, e); }); });
  q('[data-go-home]', () => { location.href = '/'; });
  q('[data-copy]', () => {
    const link = `${location.origin}/r/${ui.msg.room.code}`;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied!'), () => {
      const i = document.getElementById('shareLink'); if (i) { i.select(); document.execCommand('copy'); toast('Invite link copied!'); } else prompt('Copy this link:', link);
    });
  });
  // lobby
  const nameInput = document.getElementById('nameInput');
  if (nameInput && once(nameInput, 'input')) {
    nameInput.addEventListener('input', () => {
      ui.name = nameInput.value;
      localStorage.setItem('sosf:name', ui.name);
      document.querySelectorAll('[data-take]').forEach((b) => { b.disabled = !ui.name.trim(); });
    });
  }
  q('[data-color]', (el) => { ui.color = el.dataset.color; localStorage.setItem('sosf:color', ui.color); render(); });
  q('[data-take]', (el) => send({ type: 'takeSeat', seat: +el.dataset.take, name: ui.name, color: ui.color }));
  q('[data-update]', () => send({ type: 'takeSeat', seat: ui.msg.you.seat, name: ui.name, color: ui.color }));
  q('[data-leave]', () => send({ type: 'leaveSeat' }));
  q('[data-fill]', () => send({ type: 'fillAI' }));
  q('[data-remove]', (el) => send({ type: 'removeAI', seat: +el.dataset.remove }));
  q('[data-start]', (el) => { el.disabled = true; send({ type: 'start' }); });
  // game
  q('[data-roll]', () => act({ type: 'roll' }));
  q('[data-end]', () => act({ type: 'endTurn' }));
  q('[data-buy]', () => act({ type: 'buyHustle' }));
  q('[data-build]', (el) => { ui.build = ui.build === el.dataset.build ? null : el.dataset.build; render(); });
  q('[data-vertex]', (el) => {
    const g = ui.msg.game;
    act({ type: 'build', kind: 'settlement', at: +el.dataset.vertex });
    if (g.phase === 'setup') ui.build = null;
  });
  q('[data-edge]', (el) => act({ type: 'build', kind: 'road', at: +el.dataset.edge }));
  q('[data-city]', (el) => act({ type: 'build', kind: 'city', at: +el.dataset.city }));
  q('[data-hex]', (el) => act({ type: 'moveFog', hex: +el.dataset.hex }));
  q('[data-steal]', (el) => act({ type: 'steal', victim: +el.dataset.steal }));
  q('[data-play]', (el) => {
    const card = el.dataset.play;
    if (card === 'farmersMarket' || card === 'monopoly') { ui.modal = { kind: card, picks: [] }; render(); } else act({ type: 'playHustle', card });
  });
  q('[data-pick]', (el) => {
    const m = ui.modal;
    if (m.kind === 'monopoly') m.picks = [el.dataset.pick];
    else if (m.picks.length < 2) m.picks.push(el.dataset.pick);
    render();
  });
  q('[data-clear-picks]', () => { ui.modal.picks = []; render(); });
  q('[data-confirm-pick]', () => {
    const m = ui.modal;
    ui.modal = null;
    act(m.kind === 'monopoly' ? { type: 'playHustle', card: 'monopoly', res: m.picks[0] } : { type: 'playHustle', card: 'farmersMarket', res: m.picks[0], res2: m.picks[1] });
  });
  q('[data-open-trade]', () => { ui.modal = { kind: 'trade', give: empty(), get: empty(), bankGive: 'redwood', bankGet: 'brick' }; render(); });
  q('[data-open-counter]', () => {
    const t = ui.msg.game.trade;
    // from my (responder) perspective: I give what they asked for, I get what they offered
    ui.modal = { kind: 'counter', tradeId: t.id, give: { ...t.get }, get: { ...t.give } };
    render();
  });
  q('[data-close]', () => { ui.modal = null; render(); });
  q('[data-step]', (el) => {
    const [side, r, d] = el.dataset.step.split(':');
    const obj = ui.modal[side];
    obj[r] = Math.max(0, obj[r] + Number(d));
    render();
  });
  q('[data-send-offer]', () => {
    const m = ui.modal;
    ui.modal = null;
    if (m.kind === 'trade') act({ type: 'offerTrade', give: m.give, get: m.get });
    else act({ type: 'respondTrade', tradeId: m.tradeId, response: 'counter', give: m.get, get: m.give });
  });
  q('[data-bank]', () => {
    const give = document.getElementById('bankGive').value;
    const get = document.getElementById('bankGet').value;
    ui.modal.bankGive = give;
    ui.modal.bankGet = get;
    const keep = ui.modal;
    act({ type: 'bankTrade', give, get });
    ui.modal = keep;
  });
  q('[data-respond]', (el) => act({ type: 'respondTrade', tradeId: ui.msg.game.trade.id, response: el.dataset.respond }));
  q('[data-accept-trade]', (el) => act({ type: 'acceptTrade', with: +el.dataset.acceptTrade }));
  q('[data-cancel-trade]', () => act({ type: 'cancelTrade' }));
  q('[data-open-discard]', () => { ui.modal = { kind: 'discard', sel: empty() }; render(); });
  q('[data-confirm-discard]', () => act({ type: 'discard', cards: ui.modal.sel }));
  q('[data-close-final]', () => { ui.modal = { kind: 'closedFinal' }; render(); });
  q('[data-show-final]', () => { ui.modal = { kind: 'final' }; render(); });
  q('[data-newgame]', () => createGame());
  ['bankGive', 'bankGet'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && once(el, 'change')) el.addEventListener('change', () => { ui.modal[id] = el.value; });
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (ui.build || (ui.modal && ui.modal.kind !== 'discard'))) {
    ui.build = null;
    if (ui.modal && ui.modal.kind !== 'discard') ui.modal = null;
    render();
  }
});

route();
