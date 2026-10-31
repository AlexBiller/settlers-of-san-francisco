'use strict';

const G = require('./game');

const { RESOURCES, COSTS, LIMITS, pips } = G;
const TRADE_WAIT_MS = 15000;

function memo(s, seat) {
  if (!s.ai[seat] || s.ai[seat].turn !== s.turnNumber) s.ai[seat] = { turn: s.turnNumber, actions: 0, offered: 0, banked: 0 };
  return s.ai[seat];
}

function production(s, seat) {
  const prod = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  for (const [v, b] of Object.entries(s.buildings)) {
    if (b.owner !== seat) continue;
    for (const h of s.board.vertices[+v].hexes) {
      const hex = s.board.hexes[h];
      if (hex.res !== 'bay') prod[hex.res] += pips(hex.num) * (b.type === 'city' ? 2 : 1);
    }
  }
  return prod;
}

function vertexScore(s, seat, v, prod) {
  const vert = s.board.vertices[v];
  let score = 0;
  const kinds = new Set();
  for (const h of vert.hexes) {
    const hex = s.board.hexes[h];
    if (hex.res === 'bay') continue;
    const p = pips(hex.num) * (h === s.fog ? 0.4 : 1);
    score += p;
    if (!prod[hex.res]) kinds.add(hex.res);
    if (prod[hex.res] === 0 && (hex.res === 'brick' || hex.res === 'redwood' || hex.res === 'chips')) score += 0.6;
  }
  score += kinds.size * 1.8;
  if (vert.harbor) {
    if (vert.harbor === 'any') score += 1;
    else if (prod[vert.harbor] >= 5) score += 2;
    else score += 0.4;
  }
  return score;
}

function missingFor(hand, cost) {
  const miss = {};
  let n = 0;
  for (const r of RESOURCES) {
    const m = Math.max(0, (cost[r] || 0) - hand[r]);
    if (m) { miss[r] = m; n += m; }
  }
  return { miss, n };
}

function bestSettlementSpot(s, seat, spots) {
  const prod = production(s, seat);
  let best = null;
  for (const v of spots) {
    const sc = vertexScore(s, seat, v, prod);
    if (!best || sc > best.score) best = { v, score: sc };
  }
  return best;
}

function bestCitySpot(s, seat, spots) {
  let best = null;
  for (const v of spots) {
    let sc = 0;
    for (const h of s.board.vertices[v].hexes) {
      const hex = s.board.hexes[h];
      if (hex.res !== 'bay' && h !== s.fog) sc += pips(hex.num);
    }
    if (!best || sc > best.score) best = { v, score: sc };
  }
  return best;
}

// BFS from our network over empty edges to find the best future settlement spot.
function bestRoadTowardSpot(s, seat) {
  const prod = production(s, seat);
  const start = new Set();
  for (const [e, o] of Object.entries(s.roads)) {
    if (o !== seat) continue;
    for (const v of s.board.edges[+e].v) {
      const b = s.buildings[v];
      if (!b || b.owner === seat) start.add(v);
    }
  }
  for (const [v, b] of Object.entries(s.buildings)) if (b.owner === seat) start.add(+v);
  const firstEdge = new Map();
  const dist = new Map();
  let frontier = [...start];
  frontier.forEach((v) => dist.set(v, 0));
  let best = null;
  for (let d = 1; d <= 3 && frontier.length; d++) {
    const next = [];
    for (const v of frontier) {
      for (const e of s.board.vertices[v].edges) {
        if (s.roads[e] !== undefined) continue;
        const [a, b] = s.board.edges[e].v;
        const o = a === v ? b : a;
        if (dist.has(o)) continue;
        const bld = s.buildings[o];
        if (bld && bld.owner !== seat) continue;
        dist.set(o, d);
        firstEdge.set(o, d === 1 ? e : firstEdge.get(v));
        next.push(o);
        if (!bld && s.board.vertices[o].adj.every((x) => !s.buildings[x])) {
          const sc = vertexScore(s, seat, o, prod) / (0.6 + d * 0.5);
          if (!best || sc > best.score) best = { edge: firstEdge.get(o), score: sc, v: o };
        }
      }
    }
    frontier = next;
  }
  if (best && G.canPlaceRoad(s, seat, best.edge, false)) return best;
  return null;
}

function goalFor(s, seat) {
  const p = s.players[seat];
  const legal = G.legalSpots(s, seat);
  const pieces = G.countPieces(s, seat);
  const goals = [];
  if (legal.cities.length && pieces.city < LIMITS.city) goals.push({ kind: 'city', cost: COSTS.city, at: bestCitySpot(s, seat, legal.cities).v });
  if (legal.settlements.length && pieces.settlement < LIMITS.settlement) goals.push({ kind: 'settlement', cost: COSTS.settlement, at: bestSettlementSpot(s, seat, legal.settlements).v });
  if (!legal.settlements.length && pieces.road < LIMITS.road) {
    const r = bestRoadTowardSpot(s, seat);
    if (r) goals.push({ kind: 'road', cost: COSTS.road, at: r.edge });
  }
  if (s.deck.length) goals.push({ kind: 'hustle', cost: COSTS.hustle });
  goals.forEach((g) => { g.missing = missingFor(p.hand, g.cost); });
  // prefer the closest build; settlements and cities slightly favored
  const weight = { settlement: -0.6, city: -0.4, road: 0.3, hustle: 0.8 };
  goals.sort((a, b) => a.missing.n + weight[a.kind] - (b.missing.n + weight[b.kind]));
  return goals;
}

function resourceValue(s, seat, goal, r, hand) {
  let v = 1;
  if (goal && goal.missing.miss[r]) v += 1.2;
  const need = goal ? goal.cost[r] || 0 : 0;
  if (hand[r] - need >= 3) v -= 0.5;
  if (hand[r] === 0) v += 0.2;
  return v;
}

function evaluateTrade(s, seat, receive, give) {
  const p = s.players[seat];
  if (!G.hasCards(p.hand, give)) return -99;
  const goal = goalFor(s, seat)[0];
  let delta = 0;
  for (const r of RESOURCES) {
    delta += (receive[r] || 0) * resourceValue(s, seat, goal, r, p.hand);
    delta -= (give[r] || 0) * resourceValue(s, seat, goal, r, p.hand);
  }
  return delta;
}

function leader(s, exclude) {
  let best = null;
  for (const p of s.players) {
    if (p.seat === exclude) continue;
    const vp = G.publicVP(s, p.seat) + p.hustle.length * 0.3;
    if (!best || vp > best.vp) best = { seat: p.seat, vp };
  }
  return best;
}

function chooseFogHex(s, seat) {
  let best = null;
  for (const h of s.board.hexes) {
    if (h.id === s.fog) continue;
    let mine = false;
    let sc = 0;
    let victims = 0;
    for (const v of h.vertices) {
      const b = s.buildings[v];
      if (!b) continue;
      if (b.owner === seat) { mine = true; continue; }
      const vp = G.publicVP(s, b.owner);
      sc += pips(h.num) * (b.type === 'city' ? 2 : 1) * (1 + vp / 4);
      if (G.handTotal(s.players[b.owner].hand) > 0) victims++;
    }
    if (mine) sc -= 50;
    if (victims) sc += 1.5;
    if (!best || sc > best.score) best = { hex: h.id, score: sc };
  }
  return best.hex;
}

function chooseVictim(s, seat, cands) {
  let best = null;
  for (const c of cands) {
    const sc = G.publicVP(s, c) * 2 + G.handTotal(s.players[c].hand) * 0.5;
    if (!best || sc > best.score) best = { seat: c, score: sc };
  }
  return best ? best.seat : cands[0];
}

function chooseDiscard(s, seat, n) {
  const hand = { ...s.players[seat].hand };
  const goal = goalFor(s, seat)[0];
  const out = G.emptyHand();
  for (let i = 0; i < n; i++) {
    let pick = null;
    for (const r of RESOURCES) {
      if (hand[r] <= 0) continue;
      const keep = goal ? goal.cost[r] || 0 : 0;
      const sc = hand[r] - keep * 1.5;
      if (!pick || sc > pick.score) pick = { r, score: sc };
    }
    hand[pick.r] -= 1;
    out[pick.r] += 1;
  }
  return out;
}

function setupAction(s, seat) {
  if (s.setupStep === 'settlement') {
    const legal = G.legalSpots(s, seat).settlements;
    return { type: 'build', kind: 'settlement', at: bestSettlementSpot(s, seat, legal).v };
  }
  const prod = production(s, seat);
  const from = s.lastSettlement;
  let best = null;
  for (const e of s.board.vertices[from].edges) {
    if (!G.canPlaceRoad(s, seat, e, true)) continue;
    const [a, b] = s.board.edges[e].v;
    const o = a === from ? b : a;
    let sc = 0;
    for (const n of s.board.vertices[o].adj) {
      if (n === from) continue;
      if (G.canPlaceSettlement(s, seat, n, true)) sc = Math.max(sc, vertexScore(s, seat, n, prod));
    }
    sc += Math.random() * 0.1;
    if (!best || sc > best.score) best = { e, score: sc };
  }
  return { type: 'build', kind: 'road', at: best.e };
}

function playable(s, seat, type) {
  return !s.hustlePlayed && s.players[seat].hustle.some((c) => c.type === type && c.turn < s.turnNumber);
}

function fogOnMe(s, seat) {
  return s.board.hexes[s.fog].vertices.some((v) => s.buildings[v] && s.buildings[v].owner === seat);
}

function wantsFogHorn(s, seat) {
  if (!playable(s, seat, 'fogHorn')) return false;
  const p = s.players[seat];
  if (fogOnMe(s, seat)) return true;
  const holder = s.loudestHorn;
  if (p.knights + 1 >= 3 && holder !== seat && (holder === null || s.players[holder].knights < p.knights + 1)) return true;
  return false;
}

function mainAction(s, seat, now) {
  const p = s.players[seat];
  const m = memo(s, seat);
  m.actions += 1;
  if (m.actions > 40) return { type: 'endTurn' };

  // An offer of ours is on the table.
  if (s.trade && s.trade.from === seat) {
    const t = s.trade;
    let best = null;
    for (const [st, r] of Object.entries(t.responses)) {
      if (r.status !== 'accept' && r.status !== 'counter') continue;
      const give = r.status === 'counter' ? r.give : t.give;
      const get = r.status === 'counter' ? r.get : t.get;
      const sc = evaluateTrade(s, seat, get, give);
      if (sc > 0 && (!best || sc > best.score)) best = { with: +st, score: sc };
    }
    if (best) return { type: 'acceptTrade', with: best.with };
    const waiting = Object.values(t.responses).some((r) => r.status === 'pending');
    if (waiting && now - t.createdAt < TRADE_WAIT_MS) return null;
    return { type: 'cancelTrade' };
  }

  // Hustle cards
  if (wantsFogHorn(s, seat)) return { type: 'playHustle', card: 'fogHorn' };
  const goals = goalFor(s, seat);
  const goal = goals[0];
  if (playable(s, seat, 'roadTrip') && G.countPieces(s, seat).road <= LIMITS.road - 2 && bestRoadTowardSpot(s, seat)) {
    return { type: 'playHustle', card: 'roadTrip' };
  }
  if (playable(s, seat, 'farmersMarket') && goal && goal.missing.n > 0 && goal.missing.n <= 2) {
    const want = [];
    for (const r of RESOURCES) for (let i = 0; i < (goal.missing.miss[r] || 0); i++) want.push(r);
    while (want.length < 2) want.push(goal.kind === 'city' ? 'chips' : 'sourdough');
    if (want.every((r) => s.bank[r] > 0)) return { type: 'playHustle', card: 'farmersMarket', res: want[0], res2: want[1] };
  }
  if (playable(s, seat, 'monopoly')) {
    const opp = s.players.filter((o) => o.seat !== seat).reduce((n, o) => n + G.handTotal(o.hand), 0);
    if (opp >= 6) {
      // guess using public info: the resource rivals produce most
      let best = null;
      for (const r of RESOURCES) {
        let sc = 0;
        for (const o of s.players) if (o.seat !== seat) sc += production(s, o.seat)[r];
        if (goal && goal.missing.miss[r]) sc *= 1.5;
        if (!best || sc > best.score) best = { r, score: sc };
      }
      return { type: 'playHustle', card: 'monopoly', res: best.r };
    }
  }

  // Build what we can afford, best first.
  for (const g of goals) {
    if (g.missing.n !== 0) continue;
    if (g.kind === 'hustle') {
      // don't burn cards on hustle when a settlement/city is one card away
      const close = goals.find((x) => (x.kind === 'city' || x.kind === 'settlement') && x.missing.n === 1);
      if (close && close.cost.sourdough && p.hand.sourdough <= close.cost.sourdough) continue;
      return { type: 'buyHustle' };
    }
    return { type: 'build', kind: g.kind, at: g.at };
  }
  // Extra roads when rich in road materials and there is somewhere to go.
  if (p.hand.redwood >= 2 && p.hand.brick >= 2 && G.countPieces(s, seat).road < LIMITS.road) {
    const r = bestRoadTowardSpot(s, seat);
    if (r) return { type: 'build', kind: 'road', at: r.edge };
  }

  // Bank trade toward the top goal(s).
  for (const g of goals.slice(0, 2)) {
    if (g.missing.n === 0 || g.missing.n > 2 || m.banked > 4) continue;
    for (const need of Object.keys(g.missing.miss)) {
      if (s.bank[need] < 1) continue;
      for (const r of RESOURCES) {
        if (r === need) continue;
        const ratio = G.harborRatio(s, seat, r);
        if (p.hand[r] - (g.cost[r] || 0) >= ratio) {
          m.banked += 1;
          return { type: 'bankTrade', give: r, get: need };
        }
      }
    }
  }

  // Ask the table for the last missing card.
  if (goal && goal.missing.n === 1 && m.offered < 1) {
    const need = Object.keys(goal.missing.miss)[0];
    let spare = null;
    for (const r of RESOURCES) {
      if (r === need) continue;
      const extra = p.hand[r] - (goal.cost[r] || 0);
      if (extra >= 1 && (!spare || extra > spare.extra)) spare = { r, extra };
    }
    const othersHaveCards = s.players.some((o) => o.seat !== seat && G.handTotal(o.hand) > 0);
    if (spare && othersHaveCards) {
      m.offered += 1;
      const give = G.emptyHand();
      const get = G.emptyHand();
      give[spare.r] = 1;
      get[need] = 1;
      return { type: 'offerTrade', give, get };
    }
  }
  return { type: 'endTurn' };
}

function respondToTrade(s, seat) {
  const t = s.trade;
  const offerer = t.from;
  const p = s.players[seat];
  if (G.publicVP(s, offerer) >= 8) return { type: 'respondTrade', tradeId: t.id, response: 'decline' };
  // I receive t.give, I pay t.get
  const sc = G.hasCards(p.hand, t.get) ? evaluateTrade(s, seat, t.give, t.get) : -99;
  if (sc >= 0.5) return { type: 'respondTrade', tradeId: t.id, response: 'accept' };
  // counter: keep what they offer that I need, but pay with my surplus instead
  const goal = goalFor(s, seat)[0];
  if (goal) {
    const wanted = RESOURCES.find((r) => t.give[r] > 0 && goal.missing.miss[r]);
    if (wanted) {
      let spare = null;
      for (const r of RESOURCES) {
        if (r === wanted || t.give[r]) continue;
        const extra = p.hand[r] - (goal.cost[r] || 0);
        if (extra >= 2 && (!spare || extra > spare.extra)) spare = { r, extra };
      }
      if (spare) {
        const give = G.emptyHand();
        const get = G.emptyHand();
        give[wanted] = 1;
        get[spare.r] = 1;
        return { type: 'respondTrade', tradeId: t.id, response: 'counter', give, get };
      }
    }
  }
  return { type: 'respondTrade', tradeId: t.id, response: 'decline' };
}

// Returns the next action for `seat`, or null if it should wait.
function chooseAction(s, seat, now = Date.now()) {
  if (s.phase === 'gameover') return null;
  if (s.phase === 'discard') {
    const n = s.discards[seat];
    return n ? { type: 'discard', cards: chooseDiscard(s, seat, n) } : null;
  }
  if (s.trade && s.trade.responses[seat] && s.trade.responses[seat].status === 'pending') return respondToTrade(s, seat);
  if (s.turn !== seat) return null;
  switch (s.phase) {
    case 'setup': return setupAction(s, seat);
    case 'roll': return wantsFogHorn(s, seat) && fogOnMe(s, seat) ? { type: 'playHustle', card: 'fogHorn' } : { type: 'roll' };
    case 'robber': {
      const hex = chooseFogHex(s, seat);
      const cands = G.stealCandidates(s, seat, hex);
      return { type: 'moveFog', hex, victim: cands.length ? chooseVictim(s, seat, cands) : undefined };
    }
    case 'steal': return { type: 'steal', victim: chooseVictim(s, seat, s.stealFrom) };
    case 'roadTrip': {
      const r = bestRoadTowardSpot(s, seat);
      const legal = G.legalSpots(s, seat).roads;
      return { type: 'build', kind: 'road', at: r ? r.edge : legal[0] };
    }
    case 'main': return mainAction(s, seat, now);
    default: return null;
  }
}

module.exports = { chooseAction, TRADE_WAIT_MS };
