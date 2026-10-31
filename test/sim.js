'use strict';
const G = require('../server/game');
const AI = require('../server/ai');

function simulate(seed, verbose) {
  const seats = [0, 1, 2, 3].map((i) => ({ name: `Bot${i}`, color: 'c' + i, isAI: true }));
  const s = G.createGame(seats);
  let now = 0;
  let steps = 0;
  while (s.phase !== 'gameover' && steps < 20000) {
    steps++;
    now += 1000;
    const actors = G.pendingActors(s);
    let acted = false;
    for (const seat of actors) {
      const a = AI.chooseAction(s, seat, now);
      if (!a) continue;
      const r = G.applyActionAt(s, seat, a, now);
      if (!r.ok) throw new Error(`seed ${seed} step ${steps} seat ${seat} ${JSON.stringify(a)} -> ${r.error} phase=${s.phase}`);
      acted = true;
      break;
    }
    if (!acted && !s.trade) throw new Error(`stuck at phase ${s.phase}`);
  }
  // invariants
  for (const r of G.RESOURCES) {
    const total = s.bank[r] + s.players.reduce((n, p) => n + p.hand[r], 0);
    if (total !== 19) throw new Error(`resource ${r} not conserved: ${total}`);
  }
  return { steps, turns: s.turnNumber, winner: s.winner, vps: s.players.map((p) => G.totalVP(s, p.seat)) };
}
module.exports = { simulate };
if (require.main === module) {
  const n = +process.argv[2] || 50;
  let turns = 0; const wins = [0, 0, 0, 0]; let unfinished = 0;
  for (let i = 0; i < n; i++) {
    const r = simulate(i);
    if (r.winner === null) unfinished++; else wins[r.winner]++;
    turns += r.turns;
  }
  console.log({ games: n, avgTurns: turns / n, wins, unfinished });
}
