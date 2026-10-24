// Reset the database to a known state: drop all tables, recreate the schema and load seed data.
// Usage: npm run db:seed   (honours DB_PATH)

import { resolve } from 'node:path';
import { config } from '../src/config';
import { openDb, resetDb } from '../src/db/connection';

const db = openDb(config.dbPath);
try {
  resetDb(db);
  const vendors = db.prepare('SELECT COUNT(*) AS n FROM vendors').get() as { n: number };
  const skus = db.prepare('SELECT COUNT(*) AS n FROM skus').get() as { n: number };
  console.log(`Seeded ${resolve(config.dbPath)}: ${vendors.n} vendors, ${skus.n} skus`);
} finally {
  db.close();
}
