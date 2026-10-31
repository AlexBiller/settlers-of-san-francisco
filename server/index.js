'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createStore } = require('./store');
const { RoomManager, newToken } = require('./rooms');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

async function main() {
  const store = await createStore();
  const rooms = new RoomManager(store);
  console.log(`Storage: ${store.kind}`);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const created = await rooms.create();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(created));
      }
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      if (url.pathname === '/' || url.pathname.startsWith('/r/')) return serveFile(res, path.join(PUBLIC, 'index.html'));
      const file = path.normalize(path.join(PUBLIC, url.pathname));
      if (!file.startsWith(PUBLIC + path.sep)) {
        res.writeHead(403);
        return res.end();
      }
      return serveFile(res, file);
    } catch (err) {
      console.error(err);
      res.writeHead(500);
      res.end('Server error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });
  wss.on('connection', (ws) => {
    let client = null;
    let room = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let chain = Promise.resolve();
    ws.on('message', (raw) => {
      chain = chain.then(async () => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'hello') {
          if (room) return;
          const r = await rooms.get(msg.room);
          if (!r) return ws.send(JSON.stringify({ type: 'fatal', message: 'That game was not found. Check the link or create a new game.' }));
          const token = typeof msg.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(msg.token) ? msg.token : newToken();
          room = r;
          client = { ws, token };
          ws.send(JSON.stringify({ type: 'welcome', token, room: r.code }));
          r.attach(client);
          return;
        }
        if (!room) return;
        room.handle(client, msg);
      }).catch((err) => console.error('message error', err));
    });
    ws.on('close', () => {
      if (room && client) room.detach(client);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    rooms.sweep();
  }, 20000);

  server.listen(PORT, () => console.log(`Settlers of San Francisco listening on http://localhost:${PORT}`));

  const shutdown = async () => {
    clearInterval(heartbeat);
    console.log('Shutting down, saving rooms...');
    await rooms.flushAll();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
