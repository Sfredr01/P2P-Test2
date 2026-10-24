import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, TABLES_IN_DROP_ORDER } from './schema';
import { seed } from './seed';

export type Db = DatabaseSync;

/** Open (and create schema on) a SQLite database. Use ':memory:' for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  return db;
}

/** Drop everything, recreate the schema and load seed data. */
export function resetDb(db: Db): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const table of TABLES_IN_DROP_ORDER) db.exec(`DROP TABLE IF EXISTS ${table};`);
  db.exec(SCHEMA_SQL);
  seed(db);
}

/**
 * Run fn atomically. Reentrant: if a transaction is already open (e.g. the idempotency
 * middleware wraps the whole request in BEGIN IMMEDIATE) it nests via a SAVEPOINT, so a
 * throw inside fn rolls back only fn's writes and rethrows.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const savepoint = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
