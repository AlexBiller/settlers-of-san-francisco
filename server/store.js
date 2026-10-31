'use strict';

const fs = require('fs');
const path = require('path');

// Durable room storage. Uses Postgres when DATABASE_URL is set, otherwise a local SQLite file.
async function createStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    return {
      kind: 'postgres',
      async load(code) {
        const r = await pool.query('SELECT data FROM rooms WHERE code = $1', [code]);
        return r.rows[0] ? r.rows[0].data : null;
      },
      async save(code, data) {
        await pool.query(
          `INSERT INTO rooms (code, data, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [code, JSON.stringify(data)],
        );
      },
      async exists(code) {
        const r = await pool.query('SELECT 1 FROM rooms WHERE code = $1', [code]);
        return r.rowCount > 0;
      },
      async prune(days) {
        await pool.query(`DELETE FROM rooms WHERE updated_at < now() - ($1 || ' days')::interval`, [String(days)]);
      },
      async close() { await pool.end(); },
    };
  }
  const Database = require('better-sqlite3');
  const file = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'rooms.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const get = db.prepare('SELECT data FROM rooms WHERE code = ?');
  const put = db.prepare(`INSERT INTO rooms (code, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM rooms WHERE updated_at < ?');
  return {
    kind: 'sqlite',
    async load(code) {
      const row = get.get(code);
      return row ? JSON.parse(row.data) : null;
    },
    async save(code, data) { put.run(code, JSON.stringify(data), Date.now()); },
    async exists(code) { return !!get.get(code); },
    async prune(days) { del.run(Date.now() - days * 86400000); },
    async close() { db.close(); },
  };
}

module.exports = { createStore };
