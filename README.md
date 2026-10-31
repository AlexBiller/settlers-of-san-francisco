# Settlers of San Francisco

An original, Bay Area–themed strategy board game for the web, inspired by classic Catan-style mechanics. It always seats exactly 4 players who play together online in real time. One person creates a game and shares the link, and up to 3 friends join on their own devices. AI players take any seat nobody claims.

**Play:** _see the live URL in the repo description_  ·  No accounts. A display name is all you need.

## Rules summary

| Tile | Resource | Count |
|---|---|---|
| The Presidio | 🌲 Redwood | 4 |
| Fisherman's Wharf | 🍞 Sourdough | 4 |
| North Beach | ☕ Coffee | 4 |
| The Painted Ladies | 🧱 Bricks | 3 |
| SoMa | 💾 Microchips | 3 |
| Open bay | Karl the Fog's home (produces nothing) | 1 |

- **Board:** 19 hexes in a 3‑4‑5‑4‑3 layout. Every land hex has a 2–12 number token with probability dots. No two red numbers (6 and 8) are placed next to each other. The coast has nine harbors: four are 3:1 (any resource) and five are 2:1, one for each resource.
- **Setup:** players place in snake order (1,2,3,4,4,3,2,1). Each placement is one settlement plus one adjacent bike path. Your second settlement pays out one of each resource around it.
- **Turn:** roll two dice. Every hex showing that number pays 1 card per adjacent settlement and 2 per city, unless Karl the Fog is sitting on it. Then trade and build in any order, and end your turn.
- **Costs:**
  - Bike path: 🌲🧱
  - Settlement: 🌲🧱🍞☕
  - City upgrade: 🍞🍞💾💾💾
  - Hustle card: 🍞☕💾
- **Placement:** settlements must be at least two edges from every other building.
- **Piece limits:** 15 bike paths, 5 settlements, 4 cities.
- **Rolling a 7:** anyone holding more than 7 cards discards half, rounded down. The roller then moves Karl the Fog to another hex, which stops it producing, and steals a random card from a player whose building touches that hex.
- **Trading:**
  - With the bank: 4:1 by default, 3:1 or 2:1 through a harbor you've built on.
  - With players, on your turn: offer cards to the table. Each opponent can accept, decline, or counter, and you choose which deal to take.
- **Hustle cards (25):**
  - 14× Fog Horn: move Karl and steal.
  - 5× Founding Grant: +1 VP, hidden until the end.
  - 2× Road Trip: 2 free bike paths.
  - 2× Farmers Market: take any 2 resources.
  - 2× Monopoly: everyone gives you all of one resource.

  You can't play a card the turn you buy it, and you can play at most one per turn. Fog Horn can be played before you roll.
- **Victory points:**
  - Settlement 1, city 2, Founding Grant 1.
  - **Longest Bike Path** (5+ connected segments) 2.
  - **Loudest Fog Horn** (3+ Fog Horns played) 2.

  First to **10** on their own turn wins.
- **Ties for awards:** the current holder keeps an award when someone ties them. If the holder's path is broken and several players tie for longest, nobody holds it. To take Loudest Fog Horn, you must strictly exceed the holder.

All names, flavor text and visuals are original. The tile art in `public/tiles/` is cut from an illustration supplied by the repo owner: redwoods, Painted Ladies, sourdough, a North Beach latte, a cable car for SoMa, and the Golden Gate in fog for the open bay. Pieces, tokens and icons are drawn with SVG, CSS and emoji. No third-party game assets are used.

## Architecture

```
public/            static client (vanilla JS, SVG board, no build step)
  index.html  app.js  style.css
server/
  index.js         HTTP (static files + POST /api/rooms) and WebSocket endpoint /ws
  rooms.js         rooms, lobby seats, session tokens, reconnect, AI scheduling, persistence
  game.js          pure rules engine: state, action validation, per-player views
  ai.js            heuristic AI
  board.js         hex geometry and random board generation
  store.js         durable storage: Postgres (DATABASE_URL) or SQLite file
test/              node:test unit tests + AI-only simulation
```

### Server authority
The server holds the only real copy of each game. Clients send *intents*, for example `{type:"action", action:{type:"build", kind:"road", at:17}, version:42}`. `game.applyAction` checks turn, phase, cost, placement, piece limits and so on, and either mutates the state or returns an error. Only the server rolls dice, shuffles the Hustle deck, and picks the card taken in a steal.

Every accepted change bumps the room `version`. Each action carries the version the client last saw, and stale actions are rejected. Together with phase checks and the client disabling its controls until the next update, this makes double-clicks and out-of-turn actions harmless.

### Message protocol (JSON over WebSocket `/ws`)
Client → server:

| type | payload | notes |
|---|---|---|
| `hello` | `room`, `token?` | first message; server answers `welcome {token}` and the current state |
| `takeSeat` | `seat`, `name`, `color` | lobby only |
| `leaveSeat` | – | lobby only |
| `fillAI` / `removeAI` | `seat` (remove) | host only |
| `start` | – | host only, all 4 seats filled |
| `action` | `action`, `version` | game intents (below) |
| `ping` | – | keep-alive |

Game intents:
- `roll`
- `build {kind: road|settlement|city, at}`
- `buyHustle`
- `playHustle {card, res?, res2?}`
- `discard {cards}`
- `moveFog {hex, victim?}`
- `steal {victim}`
- `bankTrade {give, get}`
- `offerTrade {give, get}`
- `respondTrade {tradeId, response: accept|decline|counter, give?, get?}`
- `acceptTrade {with}`
- `cancelTrade`
- `endTurn`

Server → client:
- `state {version, room, you, game}`
- `error {message}`
- `fatal {message}` (room not found)

### Hidden information
`game.viewFor(state, seat)` builds a separate view for every connection.

What a view includes:
- the public board, buildings and roads;
- each opponent's resource-card count and Hustle-card count, but never which cards;
- the full hand and Hustle cards only for the seat that owns them;
- the size of the Hustle deck, never its order;
- the log, with private entries filtered: only the thief and the victim see which resource was stolen, and only the buyer sees which Hustle card they drew.

Founding Grants stay hidden until the game ends, when every hand is revealed.

Session tokens exist only in each player's `localStorage` and in server-side room storage. They are never sent to other clients: lobby seats are broadcast with name, color and status only.

### Reconnects and AI cover
When you join, your browser stores a random session token per room. On a refresh or dropped connection, the client reconnects with exponential backoff, sends the token, and lands back in its seat.

While you're away, everyone sees a **Disconnected** badge on your seat. If the game waits on you (your turn, a discard, or a trade response) for more than 10 seconds, the AI acts for you and the seat shows **AI covering**. You get control back as soon as you reconnect.

### AI players
The AI is heuristic, competent and beatable:
- **Setup:** scores corners by pip count, resource diversity, scarce resources and useful harbors.
- **Building:** works toward the closest affordable build. Priority is city > settlement > road toward the best reachable new spot > Hustle card.
- **Trading:** trades with the bank when that unlocks a build, and asks the table for its last missing card. It judges other players' offers by how much they help its own goal, and refuses to feed a player at 8+ points.
- **Karl the Fog:** moves him to hurt the leader, never itself, and steals from the strongest rival.
- **Hustle cards:** plays Fog Horns to clear Karl off its own tiles or to take Loudest Fog Horn. Plays Road Trip, Farmers Market and Monopoly when they help.

AI moves happen one at a time, about 1.1 seconds apart, so humans can follow along. Each move is broadcast and written to the City News log.

### Persistence
After every change, the room (including full game state and tokens) is written to durable storage, debounced and serialized per room.
- With `DATABASE_URL` set, rooms go to a Postgres `rooms` table (JSONB). This is used in production.
- Without it, rooms go to a local SQLite file at `data/rooms.db`.

Rooms load on demand, so games survive restarts and redeploys, and any number of rooms can run at once.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
npm test             # rules + 100 simulated AI games
```

Environment variables:

| var | default | |
|---|---|---|
| `PORT` | 3000 | |
| `DATABASE_URL` | – | Postgres connection string. If unset, SQLite is used |
| `SQLITE_PATH` | `data/rooms.db` | |
| `AI_DELAY_MS` | 1100 | pause between AI moves |
| `DISCONNECT_GRACE_MS` | 10000 | how long before AI covers a disconnected player |

To try multiplayer on one machine, open the room link in a second browser profile or a private window. Each one gets its own session token.

## Deployment

Production runs on **Render** (free web service) with **Neon** (free serverless Postgres) for storage. Configuration lives in `render.yaml`: `npm ci --omit=dev` to build, `npm start` to run, health check at `/healthz`, and `DATABASE_URL` set to the Neon connection string. Pushes to `main` redeploy automatically.

The free Render service goes to sleep after 15 minutes without traffic. The first visit after that takes up to a minute to wake it, and the client shows a "connecting" message meanwhile. Saved games live in Neon and are unaffected.
