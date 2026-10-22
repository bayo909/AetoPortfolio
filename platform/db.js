// Thin wrapper over node:sqlite: cached statements, transactions with savepoints, id/time helpers.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const SCHEMA = require('./schema');

const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function openDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA);
  const cache = new Map();
  const stmt = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  const db = {
    raw,
    get: (sql, ...p) => stmt(sql).get(...p.map(norm)),
    all: (sql, ...p) => stmt(sql).all(...p.map(norm)),
    run: (sql, ...p) => stmt(sql).run(...p.map(norm)),
    /** Runs fn atomically; nested calls become savepoints so a failure rolls back only the inner unit. */
    tx(fn) {
      const name = `sp${depth}`;
      raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
    insert(table, row) {
      const cols = Object.keys(row);
      db.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(c => row[c]));
      return row;
    },
    close: () => raw.close(),
  };
  return db;
}

const uid = () => crypto.randomUUID();
const iso = (d = new Date()) => d.toISOString();

module.exports = { openDb, uid, iso };
