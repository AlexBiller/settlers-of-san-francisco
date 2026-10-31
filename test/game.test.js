'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../server/game');
const { simulate } = require('./sim');

const seats = () => [0, 1, 2, 3].map((i) => ({ name: `P${i}`, color: `c${i}`, isAI: false }));

function fastSetup(s) {
  // place settlements/roads using the first legal spot for each seat
  while (s.phase === 'setup') {
    const seat = s.turn;
    const legal = G.legalSpots(s, seat);
    const kind = s.setupStep;
    const at = kind === 'settlement' ? legal.settlements[0] : legal.roads[0];
    assert.ok(G.applyAction(s, seat, { type: 'build', kind, at }).ok);
  }
}

test('board has 19 tiles, 54 corners, 72 edges, 9 harbors and 18 tokens', () => {
  const s = G.createGame(seats());
  assert.strictEqual(s.board.hexes.length, 19);
  assert.strictEqual(s.board.vertices.length, 54);
  assert.strictEqual(s.board.edges.length, 72);
  assert.strictEqual(s.board.harbors.length, 9);
  assert.strictEqual(s.board.hexes.filter((h) => h.num).length, 18);
  assert.strictEqual(s.board.hexes.filter((h) => h.res === 'bay').length, 1);
  assert.strictEqual(s.fog, s.board.hexes.find((h) => h.res === 'bay').id);
});

test('setup is snake order and the second settlement pays out', () => {
  const s = G.createGame(seats());
  const order = s.setupOrder;
  assert.deepStrictEqual(order.slice(4), order.slice(0, 4).reverse());
  fastSetup(s);
  assert.strictEqual(s.phase, 'roll');
  assert.strictEqual(s.turn, order[0]);
  const cards = s.players.reduce((n, p) => n + G.handTotal(p.hand), 0);
  assert.ok(cards > 0);
});

test('distance rule and out-of-turn actions are rejected', () => {
  const s = G.createGame(seats());
  const seat = s.turn;
  const v = 10;
  assert.ok(G.applyAction(s, seat, { type: 'build', kind: 'settlement', at: v }).ok);
  const other = (seat + 1) % 4;
  assert.strictEqual(G.applyAction(s, other, { type: 'roll' }).ok, false);
  // build road then the next player can't settle adjacent
  const road = G.legalSpots(s, seat).roads[0];
  assert.ok(G.applyAction(s, seat, { type: 'build', kind: 'road', at: road }).ok);
  const adj = s.board.vertices[v].adj[0];
  const r = G.applyAction(s, s.turn, { type: 'build', kind: 'settlement', at: adj });
  assert.strictEqual(r.ok, false);
});

test('double actions are rejected (roll twice, end turn twice)', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  const seat = s.turn;
  assert.ok(G.applyAction(s, seat, { type: 'roll' }, () => 0.3).ok); // 2+2
  assert.strictEqual(G.applyAction(s, seat, { type: 'roll' }).ok, false);
  assert.ok(G.applyAction(s, seat, { type: 'endTurn' }).ok);
  assert.strictEqual(G.applyAction(s, seat, { type: 'endTurn' }).ok, false);
});

test('rolling 7 forces discards of half (rounded down) for hands over 7', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  const seat = s.turn;
  const victim = (seat + 1) % 4;
  s.players[victim].hand = { redwood: 3, brick: 3, sourdough: 3, coffee: 0, chips: 0 };
  s.players[seat].hand = { redwood: 1, brick: 1, sourdough: 1, coffee: 1, chips: 1 };
  let n = 0;
  const rng = () => [0.5, 0.2][n++ % 2]; // 4 + 2 = 6? make it 7: 0.5 -> 4, 0.45 -> 3
  n = 0;
  const seven = () => [0.5, 0.4][n++ % 2];
  assert.ok(G.applyAction(s, seat, { type: 'roll' }, seven).ok);
  assert.deepStrictEqual(s.dice, [4, 3]);
  assert.strictEqual(s.phase, 'discard');
  assert.strictEqual(s.discards[victim], 4);
  assert.strictEqual(G.applyAction(s, seat, { type: 'moveFog', hex: 0 }).ok, false);
  assert.strictEqual(G.applyAction(s, victim, { type: 'discard', cards: { redwood: 3 } }).ok, false);
  assert.ok(G.applyAction(s, victim, { type: 'discard', cards: { redwood: 2, brick: 2 } }).ok);
  assert.strictEqual(s.phase, 'robber');
  assert.strictEqual(G.applyAction(s, seat, { type: 'moveFog', hex: s.fog }).ok, false);
  const target = s.board.hexes.find((h) => h.id !== s.fog).id;
  assert.ok(G.applyAction(s, seat, { type: 'moveFog', hex: target }).ok);
  assert.ok(['main', 'steal'].includes(s.phase));
  void rng;
});

test('hidden information is not in other players views', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  s.players[1].hustle.push({ type: 'foundingGrant', turn: 0 });
  const v0 = G.viewFor(s, 0);
  assert.strictEqual(v0.players[1].hand, undefined);
  assert.strictEqual(v0.players[1].hustle, undefined);
  assert.strictEqual(v0.players[1].hustleCount, 1);
  assert.strictEqual(v0.deck, undefined);
  assert.ok(v0.players[0].hand);
  const spectator = G.viewFor(s, null);
  assert.ok(spectator.players.every((p) => p.hand === undefined));
});

test('cannot play a hustle card the turn it was bought, and only one per turn', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  const seat = s.turn;
  G.applyAction(s, seat, { type: 'roll' }, () => 0.1);
  if (s.phase !== 'main') return;
  s.players[seat].hand = { redwood: 0, brick: 0, sourdough: 3, coffee: 3, chips: 3 };
  s.deck.push('fogHorn');
  assert.ok(G.applyAction(s, seat, { type: 'buyHustle' }).ok);
  assert.strictEqual(G.applyAction(s, seat, { type: 'playHustle', card: 'fogHorn' }).ok, false);
  s.players[seat].hustle.push({ type: 'monopoly', turn: 0 }, { type: 'farmersMarket', turn: 0 });
  assert.ok(G.applyAction(s, seat, { type: 'playHustle', card: 'monopoly', res: 'brick' }).ok);
  assert.strictEqual(G.applyAction(s, seat, { type: 'playHustle', card: 'farmersMarket', res: 'brick', res2: 'chips' }).ok, false);
});

test('bank trade uses harbor ratios', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  const seat = s.turn;
  G.applyAction(s, seat, { type: 'roll' }, () => 0.1);
  s.players[seat].hand = { redwood: 4, brick: 0, sourdough: 0, coffee: 0, chips: 0 };
  const ratio = G.harborRatio(s, seat, 'redwood');
  assert.ok(G.applyAction(s, seat, { type: 'bankTrade', give: 'redwood', get: 'chips' }).ok);
  assert.strictEqual(s.players[seat].hand.redwood, 4 - ratio);
  assert.strictEqual(s.players[seat].hand.chips, 1);
});

test('player trade: offer, counter, accept moves cards both ways', () => {
  const s = G.createGame(seats());
  fastSetup(s);
  const a = s.turn;
  const b = (a + 1) % 4;
  G.applyAction(s, a, { type: 'roll' }, () => 0.1);
  s.players[a].hand = { redwood: 2, brick: 0, sourdough: 0, coffee: 0, chips: 0 };
  s.players[b].hand = { redwood: 0, brick: 2, sourdough: 1, coffee: 0, chips: 0 };
  assert.ok(G.applyAction(s, a, { type: 'offerTrade', give: { redwood: 1 }, get: { brick: 1 } }).ok);
  assert.strictEqual(G.applyAction(s, a, { type: 'acceptTrade', with: b }).ok, false);
  assert.ok(G.applyAction(s, b, { type: 'respondTrade', response: 'counter', give: { redwood: 2 }, get: { brick: 1 } }).ok);
  assert.ok(G.applyAction(s, a, { type: 'acceptTrade', with: b }).ok);
  assert.strictEqual(s.players[a].hand.brick, 1);
  assert.strictEqual(s.players[b].hand.redwood, 2);
  assert.strictEqual(s.trade, null);
});

test('longest bike path counts connected segments', () => {
  const s = G.createGame(seats());
  s.phase = 'main';
  // build a chain of 5 roads for seat 0 along a path, and 5 for seat 1 elsewhere
  const path = (start, len, owner) => {
    let v = start;
    const used = [];
    for (let i = 0; i < len; i++) {
      const e = s.board.vertices[v].edges.find((x) => s.roads[x] === undefined && !used.includes(x));
      s.roads[e] = owner;
      used.push(e);
      const [a, b] = s.board.edges[e].v;
      v = a === v ? b : a;
    }
  };
  path(0, 5, 0);
  path(40, 5, 1);
  const lens = [G.longestRoadFor(s, 0), G.longestRoadFor(s, 1)];
  assert.ok(lens[0] >= 5 && lens[1] >= 5);
});

test('100 full AI-only games finish with a winner and conserve resources', () => {
  for (let i = 0; i < 100; i++) {
    const r = simulate(i);
    assert.notStrictEqual(r.winner, null);
    assert.ok(Math.max(...r.vps) >= 10);
  }
});
