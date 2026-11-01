// The subset of the D1 binding API the app uses (prepare/bind/first/all/run, batch), backed by
// Node's built-in SQLite, so the same queries run in Docker and on Cloudflare.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const plain = (row) => (row ? { ...row } : null); // node:sqlite rows have a null prototype

export function openD1(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    exec() {
      const s = db.prepare(this.sql);
      if (/^\s*(select|with)\b/i.test(this.sql)) return { results: s.all(...this.params).map(plain), success: true, meta: {} };
      const r = s.run(...this.params);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(column) {
      const row = plain(db.prepare(this.sql).get(...this.params));
      return column && row ? row[column] : row;
    }
    async all() { return { results: db.prepare(this.sql).all(...this.params).map(plain), success: true, meta: {} }; }
    async run() { return this.exec(); }
  }

  return {
    prepare: (sql) => new Statement(sql),
    // D1 runs a batch as one transaction.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    raw: db,
  };
}

// Apply migrations/*.sql in order, recording them like `wrangler d1 migrations apply` does.
export function migrate(d1, dir) {
  const db = d1.raw;
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, name), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
      console.log(`migration applied: ${name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
