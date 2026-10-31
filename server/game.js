'use strict';

const { RESOURCES, TILE_INFO, pips, shuffle, generateBoard } = require('./board');

const COSTS = {
  road: { redwood: 1, brick: 1 },
  settlement: { redwood: 1, brick: 1, sourdough: 1, coffee: 1 },
  city: { sourdough: 2, chips: 3 },
  hustle: { sourdough: 1, coffee: 1, chips: 1 },
};
const LIMITS = { road: 15, settlement: 5, city: 4 };
const HUSTLE = {
  fogHorn: { name: 'Fog Horn', count: 14, text: 'Sound the horn: move Karl the Fog and pinch a card from a neighbor.' },
  foundingGrant: { name: 'Founding Grant', count: 5, text: 'A dusty city charter in your name. Worth 1 victory point.' },
  roadTrip: { name: 'Road Trip', count: 2, text: 'Pack the van: lay down 2 bike paths for free.' },
  farmersMarket: { name: 'Farmers Market', count: 2, text: 'Saturday at the Ferry Building: take any 2 resources from the bank.' },
  monopoly: { name: 'Monopoly', count: 2, text: 'Corner the market: every rival hands you all of one resource.' },
};
const WIN_VP = 10;
const BANK_START = 19;

const emptyHand = () => Object.fromEntries(RESOURCES.map((r) => [r, 0]));
const handTotal = (h) => RESOURCES.reduce((s, r) => s + (h[r] || 0), 0);
const resName = (r) => TILE_INFO[r].name;
const describeCards = (c) => RESOURCES.filter((r) => c[r] > 0).map((r) => `${c[r]} ${resName(r)}`).join(', ') || 'nothing';

function hasCards(hand, cards) {
  return RESOURCES.every((r) => (hand[r] || 0) >= (cards[r] || 0));
}
function moveCards(from, to, cards) {
  for (const r of RESOURCES) {
    const n = cards[r] || 0;
    from[r] -= n;
    to[r] += n;
  }
}
function cleanCards(obj) {
  const out = emptyHand();
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (!RESOURCES.includes(k)) return null;
    if (!Number.isInteger(v) || v < 0 || v > 30) return null;
    out[k] = v;
  }
  return out;
}

function createGame(seats, rng = Math.random) {
  const board = generateBoard(rng);
  const deck = [];
  for (const [k, v] of Object.entries(HUSTLE)) for (let i = 0; i < v.count; i++) deck.push(k);
  const first = Math.floor(rng() * 4);
  const order = [0, 1, 2, 3].map((i) => (first + i) % 4);
  const state = {
    board,
    fog: board.fogHex,
    buildings: {},
    roads: {},
    players: seats.map((s, i) => ({
      seat: i,
      name: s.name,
      color: s.color,
      isAI: !!s.isAI,
      hand: emptyHand(),
      hustle: [],
      knights: 0,
      roadLength: 0,
    })),
    bank: Object.fromEntries(RESOURCES.map((r) => [r, BANK_START])),
    deck: shuffle(deck, rng),
    setupOrder: [...order, ...order.slice().reverse()],
    setupIndex: 0,
    setupStep: 'settlement',
    lastSettlement: null,
    turn: order[0],
    turnNumber: 0,
    phase: 'setup',
    dice: null,
    hustlePlayed: false,
    freeRoads: 0,
    robberReturn: 'main',
    stealFrom: [],
    discards: {},
    trade: null,
    tradeSeq: 0,
    longestRoad: null,
    loudestHorn: null,
    winner: null,
    log: [],
    logSeq: 0,
    ai: {},
  };
  log(state, `Welcome to Settlers of San Francisco! ${state.players[state.turn].name} claims first pick of the city.`);
  return state;
}

function log(state, msg, to) {
  state.logSeq += 1;
  const entry = { id: state.logSeq, msg };
  if (to) entry.to = to;
  state.log.push(entry);
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
}

// ---------- geometry helpers ----------
const V = (s, v) => s.board.vertices[v];
const E = (s, e) => s.board.edges[e];

function vertexFree(s, v) {
  if (s.buildings[v]) return false;
  return V(s, v).adj.every((a) => !s.buildings[a]);
}
function playerTouchesVertexByRoad(s, seat, v) {
  return V(s, v).edges.some((e) => s.roads[e] === seat);
}
function canPlaceSettlement(s, seat, v, setup) {
  if (!Number.isInteger(v) || !s.board.vertices[v]) return false;
  if (!vertexFree(s, v)) return false;
  return setup || playerTouchesVertexByRoad(s, seat, v);
}
function canPlaceRoad(s, seat, e, setup) {
  if (!Number.isInteger(e) || !s.board.edges[e]) return false;
  if (s.roads[e] !== undefined) return false;
  const [a, b] = E(s, e).v;
  if (setup) return a === s.lastSettlement || b === s.lastSettlement;
  for (const v of [a, b]) {
    const bld = s.buildings[v];
    if (bld && bld.owner === seat) return true;
    if (bld && bld.owner !== seat) continue;
    if (V(s, v).edges.some((x) => x !== e && s.roads[x] === seat)) return true;
  }
  return false;
}
function canPlaceCity(s, seat, v) {
  const b = s.buildings[v];
  return !!b && b.owner === seat && b.type === 'settlement';
}
function countPieces(s, seat) {
  let settlement = 0;
  let city = 0;
  for (const b of Object.values(s.buildings)) {
    if (b.owner !== seat) continue;
    if (b.type === 'city') city++;
    else settlement++;
  }
  const road = Object.values(s.roads).filter((o) => o === seat).length;
  return { settlement, city, road };
}
function legalSpots(s, seat) {
  const setup = s.phase === 'setup';
  const out = { settlements: [], roads: [], cities: [] };
  const pieces = countPieces(s, seat);
  if (setup || pieces.settlement < LIMITS.settlement) {
    for (const v of s.board.vertices) if (canPlaceSettlement(s, seat, v.id, setup)) out.settlements.push(v.id);
  }
  if (setup || pieces.road < LIMITS.road) {
    for (const e of s.board.edges) if (canPlaceRoad(s, seat, e.id, setup)) out.roads.push(e.id);
  }
  if (pieces.city < LIMITS.city) {
    for (const [v, b] of Object.entries(s.buildings)) if (b.owner === seat && b.type === 'settlement') out.cities.push(+v);
  }
  return out;
}

function harborRatio(s, seat, res) {
  let ratio = 4;
  for (const [v, b] of Object.entries(s.buildings)) {
    if (b.owner !== seat) continue;
    const h = V(s, +v).harbor;
    if (h === res) return 2;
    if (h === 'any') ratio = 3;
  }
  return ratio;
}

function longestRoadFor(s, seat) {
  const mine = new Set();
  for (const [e, o] of Object.entries(s.roads)) if (o === seat) mine.add(+e);
  if (mine.size === 0) return 0;
  let best = 0;
  const used = new Set();
  const dfs = (v, len) => {
    if (len > best) best = len;
    for (const e of V(s, v).edges) {
      if (!mine.has(e) || used.has(e)) continue;
      const [a, b] = E(s, e).v;
      const other = a === v ? b : a;
      used.add(e);
      const bld = s.buildings[other];
      if (bld && bld.owner !== seat) {
        if (len + 1 > best) best = len + 1;
      } else {
        dfs(other, len + 1);
      }
      used.delete(e);
    }
  };
  const starts = new Set();
  for (const e of mine) for (const v of E(s, e).v) starts.add(v);
  for (const v of starts) dfs(v, 0);
  return best;
}

function updateLongestRoad(s) {
  const lens = s.players.map((p) => {
    p.roadLength = longestRoadFor(s, p.seat);
    return p.roadLength;
  });
  const holder = s.longestRoad;
  const max = Math.max(...lens);
  let next;
  if (holder !== null && lens[holder] >= 5 && lens[holder] === max) next = holder;
  else if (max < 5) next = null;
  else {
    const top = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
    next = top.length === 1 ? top[0] : null;
  }
  if (next !== holder) {
    if (next === null) log(s, `The Longest Bike Path award is up for grabs again.`);
    else log(s, `${s.players[next].name} now has the Longest Bike Path (${lens[next]} segments)!`);
    s.longestRoad = next;
  }
}

function publicVP(s, seat) {
  let vp = 0;
  for (const b of Object.values(s.buildings)) if (b.owner === seat) vp += b.type === 'city' ? 2 : 1;
  if (s.longestRoad === seat) vp += 2;
  if (s.loudestHorn === seat) vp += 2;
  return vp;
}
function totalVP(s, seat) {
  return publicVP(s, seat) + s.players[seat].hustle.filter((c) => c.type === 'foundingGrant').length;
}

function checkWin(s) {
  if (s.phase === 'gameover' || s.phase === 'setup') return;
  const seat = s.turn;
  if (totalVP(s, seat) >= WIN_VP) {
    s.phase = 'gameover';
    s.winner = seat;
    s.trade = null;
    log(s, `🏆 ${s.players[seat].name} wins with ${totalVP(s, seat)} victory points! The city is theirs.`);
  }
}

// ---------- production ----------
function produce(s, roll) {
  const owed = s.players.map(() => emptyHand());
  for (const h of s.board.hexes) {
    if (h.num !== roll || h.id === s.fog || h.res === 'bay') continue;
    for (const v of h.vertices) {
      const b = s.buildings[v];
      if (b) owed[b.owner][h.res] += b.type === 'city' ? 2 : 1;
    }
  }
  for (const r of RESOURCES) {
    const total = owed.reduce((sum, o) => sum + o[r], 0);
    if (total === 0) continue;
    const takers = owed.filter((o) => o[r] > 0).length;
    if (total > s.bank[r]) {
      if (takers === 1) {
        const o = owed.find((x) => x[r] > 0);
        o[r] = s.bank[r];
      } else {
        owed.forEach((o) => { o[r] = 0; });
        log(s, `The bank ran short on ${resName(r)} - nobody collects it this roll.`);
      }
    }
  }
  let any = false;
  owed.forEach((o, seat) => {
    if (handTotal(o) === 0) return;
    any = true;
    moveCards(s.bank, s.players[seat].hand, o);
    log(s, `${s.players[seat].name} collects ${describeCards(o)}.`);
  });
  if (!any) log(s, 'Nobody collects anything this roll.');
}

// ---------- actions ----------
class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

function requireTurn(s, seat) {
  if (s.turn !== seat) fail("It's not your turn.");
}
function requirePhase(s, ...phases) {
  if (!phases.includes(s.phase)) fail(`You can't do that right now.`);
}
function pay(s, seat, cost) {
  const hand = s.players[seat].hand;
  if (!hasCards(hand, cost)) fail(`Not enough resources (needs ${describeCards({ ...emptyHand(), ...cost })}).`);
  moveCards(hand, s.bank, { ...emptyHand(), ...cost });
}

function stealCandidates(s, seat, hex) {
  const set = new Set();
  for (const v of s.board.hexes[hex].vertices) {
    const b = s.buildings[v];
    if (b && b.owner !== seat && handTotal(s.players[b.owner].hand) > 0) set.add(b.owner);
  }
  return [...set];
}
function doSteal(s, thief, victim, rng) {
  const hand = s.players[victim].hand;
  const pool = [];
  for (const r of RESOURCES) for (let i = 0; i < hand[r]; i++) pool.push(r);
  if (!pool.length) return;
  const r = pool[Math.floor(rng() * pool.length)];
  hand[r] -= 1;
  s.players[thief].hand[r] += 1;
  const T = s.players[thief].name;
  const Vn = s.players[victim].name;
  log(s, `${T} pinched a card from ${Vn}.`, null);
  s.log[s.log.length - 1].except = [thief, victim];
  log(s, `${T} pinched 1 ${resName(r)} from ${Vn}.`, [thief, victim]);
}

function finishRoadTripIfDone(s, seat) {
  if (s.phase !== 'roadTrip') return;
  if (s.freeRoads <= 0 || legalSpots(s, seat).roads.length === 0) {
    s.phase = 'main';
    s.freeRoads = 0;
  }
}

function applyAction(s, seat, action, rng = Math.random) {
  try {
    if (s.phase === 'gameover') fail('The game is over.');
    if (!action || typeof action.type !== 'string') fail('Bad action.');
    const handler = HANDLERS[action.type];
    if (!handler) fail('Unknown action.');
    handler(s, seat, action, rng);
    checkWin(s);
    return { ok: true };
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.message };
    throw err;
  }
}

const HANDLERS = {
  build(s, seat, a) {
    requireTurn(s, seat);
    const p = s.players[seat];
    const at = a.at;
    if (s.phase === 'setup') {
      if (a.kind !== s.setupStep) fail(`Place a ${s.setupStep === 'road' ? 'bike path' : 'settlement'}.`);
      if (a.kind === 'settlement') {
        if (!canPlaceSettlement(s, seat, at, true)) fail('Settlements need two edges of space from every other building.');
        s.buildings[at] = { owner: seat, type: 'settlement' };
        s.lastSettlement = at;
        s.setupStep = 'road';
        log(s, `${p.name} founded a settlement.`);
        if (s.setupIndex >= 4) {
          const gain = emptyHand();
          for (const h of V(s, at).hexes) {
            const hex = s.board.hexes[h];
            if (hex.res !== 'bay' && s.bank[hex.res] > 0) gain[hex.res] += 1;
          }
          moveCards(s.bank, p.hand, gain);
          log(s, `${p.name} starts with ${describeCards(gain)}.`);
        }
      } else {
        if (!canPlaceRoad(s, seat, at, true)) fail('Your bike path must touch the settlement you just placed.');
        s.roads[at] = seat;
        s.setupIndex += 1;
        s.lastSettlement = null;
        updateLongestRoad(s);
        if (s.setupIndex >= s.setupOrder.length) {
          s.phase = 'roll';
          s.turn = s.setupOrder[0];
          s.turnNumber = 1;
          log(s, `Setup complete. ${s.players[s.turn].name} rolls first.`);
        } else {
          s.turn = s.setupOrder[s.setupIndex];
          s.setupStep = 'settlement';
        }
      }
      return;
    }
    const pieces = countPieces(s, seat);
    if (a.kind === 'road') {
      if (s.phase === 'roadTrip') {
        if (!canPlaceRoad(s, seat, at, false)) fail("You can't build a bike path there.");
        s.roads[at] = seat;
        s.freeRoads -= 1;
        log(s, `${p.name} laid a free bike path.`);
        updateLongestRoad(s);
        finishRoadTripIfDone(s, seat);
        return;
      }
      requirePhase(s, 'main');
      if (pieces.road >= LIMITS.road) fail('You have no bike paths left.');
      if (!canPlaceRoad(s, seat, at, false)) fail('Bike paths must connect to your network.');
      pay(s, seat, COSTS.road);
      s.roads[at] = seat;
      log(s, `${p.name} built a bike path.`);
      updateLongestRoad(s);
    } else if (a.kind === 'settlement') {
      requirePhase(s, 'main');
      if (pieces.settlement >= LIMITS.settlement) fail('You have no settlements left - upgrade one to a city.');
      if (!canPlaceSettlement(s, seat, at, false)) fail('Settlements must sit on your bike path, two edges from any building.');
      pay(s, seat, COSTS.settlement);
      s.buildings[at] = { owner: seat, type: 'settlement' };
      log(s, `${p.name} built a settlement.`);
      updateLongestRoad(s);
    } else if (a.kind === 'city') {
      requirePhase(s, 'main');
      if (pieces.city >= LIMITS.city) fail('You have no cities left.');
      if (!canPlaceCity(s, seat, at)) fail('Cities upgrade one of your own settlements.');
      pay(s, seat, COSTS.city);
      s.buildings[at] = { owner: seat, type: 'city' };
      log(s, `${p.name} upgraded a settlement to a city.`);
    } else fail('Unknown building.');
  },

  roll(s, seat, a, rng) {
    requireTurn(s, seat);
    requirePhase(s, 'roll');
    const d1 = 1 + Math.floor(rng() * 6);
    const d2 = 1 + Math.floor(rng() * 6);
    s.dice = [d1, d2];
    const sum = d1 + d2;
    log(s, `${s.players[seat].name} rolled ${sum} (${d1} + ${d2}).`);
    if (sum === 7) {
      log(s, 'Seven! Karl the Fog rolls in.');
      s.discards = {};
      for (const p of s.players) {
        const t = handTotal(p.hand);
        if (t > 7) s.discards[p.seat] = Math.floor(t / 2);
      }
      s.robberReturn = 'main';
      if (Object.keys(s.discards).length) {
        s.phase = 'discard';
        for (const [st, n] of Object.entries(s.discards)) log(s, `${s.players[st].name} must discard ${n} cards.`);
      } else s.phase = 'robber';
    } else {
      produce(s, sum);
      s.phase = 'main';
    }
  },

  discard(s, seat, a) {
    requirePhase(s, 'discard');
    const need = s.discards[seat];
    if (!need) fail("You don't need to discard.");
    const cards = cleanCards(a.cards);
    if (!cards) fail('Bad cards.');
    if (handTotal(cards) !== need) fail(`Choose exactly ${need} cards.`);
    if (!hasCards(s.players[seat].hand, cards)) fail("You don't have those cards.");
    moveCards(s.players[seat].hand, s.bank, cards);
    delete s.discards[seat];
    log(s, `${s.players[seat].name} discarded ${need} cards.`);
    if (Object.keys(s.discards).length === 0) s.phase = 'robber';
  },

  moveFog(s, seat, a, rng) {
    requireTurn(s, seat);
    requirePhase(s, 'robber');
    const hex = a.hex;
    if (!Number.isInteger(hex) || !s.board.hexes[hex]) fail('Pick a tile.');
    if (hex === s.fog) fail('Karl has to move to a different tile.');
    s.fog = hex;
    const h = s.board.hexes[hex];
    log(s, `${s.players[seat].name} sent Karl the Fog to ${TILE_INFO[h.res].place}${h.num ? ` (${h.num})` : ''}.`);
    const cands = stealCandidates(s, seat, hex);
    if (cands.length === 0) {
      s.phase = s.robberReturn;
    } else if (cands.length === 1 || cands.includes(a.victim)) {
      doSteal(s, seat, cands.includes(a.victim) ? a.victim : cands[0], rng);
      s.phase = s.robberReturn;
    } else {
      s.stealFrom = cands;
      s.phase = 'steal';
    }
  },

  steal(s, seat, a, rng) {
    requireTurn(s, seat);
    requirePhase(s, 'steal');
    if (!s.stealFrom.includes(a.victim)) fail('Pick a player next to Karl.');
    doSteal(s, seat, a.victim, rng);
    s.stealFrom = [];
    s.phase = s.robberReturn;
  },

  buyHustle(s, seat) {
    requireTurn(s, seat);
    requirePhase(s, 'main');
    if (!s.deck.length) fail('The Hustle deck is empty.');
    pay(s, seat, COSTS.hustle);
    const type = s.deck.pop();
    s.players[seat].hustle.push({ type, turn: s.turnNumber });
    log(s, `${s.players[seat].name} bought a Hustle card.`);
    log(s, `You drew ${HUSTLE[type].name}.`, [seat]);
  },

  playHustle(s, seat, a) {
    requireTurn(s, seat);
    const p = s.players[seat];
    const type = a.card;
    if (!HUSTLE[type] || type === 'foundingGrant') fail("That card can't be played.");
    if (type === 'fogHorn') requirePhase(s, 'roll', 'main');
    else requirePhase(s, 'main');
    if (s.hustlePlayed) fail('Only one Hustle card per turn.');
    const idx = p.hustle.findIndex((c) => c.type === type && c.turn < s.turnNumber);
    if (idx < 0) {
      if (p.hustle.some((c) => c.type === type)) fail("You can't play a Hustle card on the turn you bought it.");
      fail("You don't have that card.");
    }
    if (type === 'farmersMarket') {
      const picks = [a.res, a.res2];
      if (!picks.every((r) => RESOURCES.includes(r))) fail('Pick two resources.');
      const want = emptyHand();
      picks.forEach((r) => { want[r] += 1; });
      if (!hasCards(s.bank, want)) fail("The bank doesn't have those.");
      p.hustle.splice(idx, 1);
      moveCards(s.bank, p.hand, want);
      log(s, `${p.name} hit the Farmers Market for ${describeCards(want)}.`);
    } else if (type === 'monopoly') {
      if (!RESOURCES.includes(a.res)) fail('Name a resource.');
      p.hustle.splice(idx, 1);
      let got = 0;
      for (const o of s.players) {
        if (o.seat === seat) continue;
        got += o.hand[a.res];
        p.hand[a.res] += o.hand[a.res];
        o.hand[a.res] = 0;
      }
      log(s, `${p.name} played Monopoly on ${resName(a.res)} and collected ${got}.`);
    } else if (type === 'roadTrip') {
      p.hustle.splice(idx, 1);
      const left = LIMITS.road - countPieces(s, seat).road;
      s.freeRoads = Math.min(2, left);
      s.phase = 'roadTrip';
      log(s, `${p.name} is going on a Road Trip!`);
      finishRoadTripIfDone(s, seat);
    } else if (type === 'fogHorn') {
      p.hustle.splice(idx, 1);
      p.knights += 1;
      log(s, `${p.name} sounded a Fog Horn! (${p.knights} total)`);
      if (p.knights >= 3 && (s.loudestHorn === null || p.knights > s.players[s.loudestHorn].knights) && s.loudestHorn !== seat) {
        s.loudestHorn = seat;
        log(s, `${p.name} now has the Loudest Fog Horn!`);
      }
      s.robberReturn = s.phase;
      s.phase = 'robber';
    }
    s.hustlePlayed = true;
  },

  bankTrade(s, seat, a) {
    requireTurn(s, seat);
    requirePhase(s, 'main');
    const { give, get } = a;
    if (!RESOURCES.includes(give) || !RESOURCES.includes(get) || give === get) fail('Pick two different resources.');
    const ratio = harborRatio(s, seat, give);
    const p = s.players[seat];
    if (p.hand[give] < ratio) fail(`You need ${ratio} ${resName(give)}.`);
    if (s.bank[get] < 1) fail(`The bank is out of ${resName(get)}.`);
    p.hand[give] -= ratio;
    s.bank[give] += ratio;
    p.hand[get] += 1;
    s.bank[get] -= 1;
    log(s, `${p.name} traded ${ratio} ${resName(give)} to the bank for 1 ${resName(get)}.`);
  },

  offerTrade(s, seat, a, rng, now = Date.now()) {
    requireTurn(s, seat);
    requirePhase(s, 'main');
    const give = cleanCards(a.give);
    const get = cleanCards(a.get);
    if (!give || !get) fail('Bad trade.');
    if (handTotal(give) === 0 || handTotal(get) === 0) fail('Both sides of a trade need at least one card.');
    if (RESOURCES.some((r) => give[r] && get[r])) fail("Don't ask for the same resource you're offering.");
    if (!hasCards(s.players[seat].hand, give)) fail("You don't have those cards.");
    s.tradeSeq += 1;
    const responses = {};
    for (const p of s.players) if (p.seat !== seat) responses[p.seat] = { status: 'pending' };
    s.trade = { id: s.tradeSeq, from: seat, give, get, responses, createdAt: now };
    log(s, `${s.players[seat].name} offers ${describeCards(give)} for ${describeCards(get)}.`);
  },

  respondTrade(s, seat, a) {
    const t = s.trade;
    if (!t || s.phase !== 'main') fail('There is no trade on the table.');
    if (a.tradeId !== undefined && a.tradeId !== t.id) fail('That offer has changed.');
    if (seat === t.from || !t.responses[seat]) fail("You can't respond to your own offer.");
    const p = s.players[seat];
    if (a.response === 'accept') {
      if (!hasCards(p.hand, t.get)) fail("You don't have the cards they want.");
      t.responses[seat] = { status: 'accept' };
      log(s, `${p.name} accepts the offer.`);
    } else if (a.response === 'decline') {
      t.responses[seat] = { status: 'decline' };
      log(s, `${p.name} declines.`);
    } else if (a.response === 'counter') {
      // terms from the offerer's perspective
      const give = cleanCards(a.give);
      const get = cleanCards(a.get);
      if (!give || !get || handTotal(give) === 0 || handTotal(get) === 0) fail('A counter needs cards on both sides.');
      if (RESOURCES.some((r) => give[r] && get[r])) fail('Pick different resources for each side.');
      if (!hasCards(p.hand, get)) fail("You don't have those cards.");
      t.responses[seat] = { status: 'counter', give, get };
      log(s, `${p.name} counters: ${describeCards(get)} for ${describeCards(give)}.`);
    } else fail('Bad response.');
  },

  acceptTrade(s, seat, a) {
    requireTurn(s, seat);
    requirePhase(s, 'main');
    const t = s.trade;
    if (!t) fail('There is no trade on the table.');
    const r = t.responses[a.with];
    if (!r || (r.status !== 'accept' && r.status !== 'counter')) fail("That player hasn't agreed.");
    const give = r.status === 'counter' ? r.give : t.give;
    const get = r.status === 'counter' ? r.get : t.get;
    const me = s.players[seat];
    const them = s.players[a.with];
    if (!hasCards(me.hand, give)) fail("You don't have those cards any more.");
    if (!hasCards(them.hand, get)) {
      t.responses[a.with] = { status: 'decline' };
      fail(`${them.name} no longer has those cards.`);
    }
    moveCards(me.hand, them.hand, give);
    moveCards(them.hand, me.hand, get);
    s.trade = null;
    log(s, `${me.name} traded ${describeCards(give)} to ${them.name} for ${describeCards(get)}.`);
  },

  cancelTrade(s, seat) {
    requireTurn(s, seat);
    if (!s.trade) fail('There is no trade on the table.');
    s.trade = null;
    log(s, `${s.players[seat].name} withdrew the offer.`);
  },

  endTurn(s, seat) {
    requireTurn(s, seat);
    requirePhase(s, 'main');
    s.trade = null;
    s.turn = (s.turn + 1) % 4;
    s.turnNumber += 1;
    s.phase = 'roll';
    s.dice = null;
    s.hustlePlayed = false;
    log(s, `It's ${s.players[s.turn].name}'s turn.`);
  },
};

// The offer handler needs "now" for timeouts; wrap so callers can pass it.
function applyActionAt(s, seat, action, now, rng = Math.random) {
  if (action && action.type === 'offerTrade') {
    try {
      if (s.phase === 'gameover') fail('The game is over.');
      HANDLERS.offerTrade(s, seat, action, rng, now);
      return { ok: true };
    } catch (err) {
      if (err instanceof RuleError) return { ok: false, error: err.message };
      throw err;
    }
  }
  return applyAction(s, seat, action, rng);
}

// ---------- who needs to act ----------
function pendingActors(s) {
  if (s.phase === 'gameover') return [];
  if (s.phase === 'discard') return Object.keys(s.discards).map(Number);
  const out = [];
  if (s.trade) {
    for (const [st, r] of Object.entries(s.trade.responses)) if (r.status === 'pending') out.push(+st);
  }
  out.push(s.turn);
  return out;
}

// ---------- per-player view (hidden info stays here) ----------
function viewFor(s, seat) {
  const isPlayer = Number.isInteger(seat) && seat >= 0 && seat < 4;
  const over = s.phase === 'gameover';
  const players = s.players.map((p) => {
    const pub = {
      seat: p.seat,
      name: p.name,
      color: p.color,
      isAI: p.isAI,
      cardCount: handTotal(p.hand),
      hustleCount: p.hustle.length,
      knights: p.knights,
      roadLength: p.roadLength,
      vp: publicVP(s, p.seat),
      pieces: countPieces(s, p.seat),
    };
    if (p.seat === seat || over) {
      pub.hand = { ...p.hand };
      pub.hustle = p.hustle.map((c) => ({ type: c.type, fresh: c.turn >= s.turnNumber }));
      pub.totalVP = totalVP(s, p.seat);
    }
    return pub;
  });
  const view = {
    board: s.board,
    fog: s.fog,
    buildings: s.buildings,
    roads: s.roads,
    players,
    bank: { ...s.bank },
    deckCount: s.deck.length,
    turn: s.turn,
    turnNumber: s.turnNumber,
    phase: s.phase,
    setupStep: s.phase === 'setup' ? s.setupStep : null,
    dice: s.dice,
    hustlePlayed: s.hustlePlayed,
    freeRoads: s.freeRoads,
    stealFrom: s.phase === 'steal' ? s.stealFrom : [],
    discards: { ...s.discards },
    trade: s.trade,
    longestRoad: s.longestRoad,
    loudestHorn: s.loudestHorn,
    winner: s.winner,
    log: s.log.filter((e) => (!e.to || e.to.includes(seat)) && !(e.except && e.except.includes(seat))).slice(-60).map((e) => ({ id: e.id, msg: e.msg })),
    you: isPlayer ? seat : null,
  };
  if (isPlayer && s.turn === seat && ['setup', 'main', 'roadTrip'].includes(s.phase)) {
    view.legal = legalSpots(s, seat);
    view.ratios = Object.fromEntries(RESOURCES.map((r) => [r, harborRatio(s, seat, r)]));
  } else if (isPlayer) {
    view.ratios = Object.fromEntries(RESOURCES.map((r) => [r, harborRatio(s, seat, r)]));
  }
  return view;
}

module.exports = {
  RESOURCES, COSTS, LIMITS, HUSTLE, WIN_VP, TILE_INFO,
  createGame, applyAction, applyActionAt, viewFor, pendingActors,
  legalSpots, canPlaceSettlement, canPlaceRoad, harborRatio, longestRoadFor,
  publicVP, totalVP, handTotal, hasCards, countPieces, stealCandidates, emptyHand, pips,
};
