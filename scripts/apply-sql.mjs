// Run a .sql file against the Docker edition's SQLite database (e.g. data/seed.sql from the
// local import pipeline). Applies pending migrations first so the tables exist.
// Usage: node scripts/apply-sql.mjs <db path> <file.sql>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openD1 } from '../src/node/d1.js';

const [dbPath, file] = process.argv.slice(2);
if (!dbPath || !file) { console.log('Usage: node scripts/apply-sql.mjs <db path> <file.sql>'); process.exit(1); }
const d1 = openD1(dbPath);
migrate(d1, join(import.meta.dirname, '..', 'migrations'));
d1.raw.exec('BEGIN');
d1.raw.exec(readFileSync(file, 'utf8'));
d1.raw.exec('COMMIT');
console.log(`applied ${file} -> ${dbPath}`);
