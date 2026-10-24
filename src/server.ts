import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { baseLogger } from './context';
import { openDb, resetDb, type Db } from './db/connection';

// Entry point for `npm run dev` / `npm start`. Each start gets a fresh, seeded database
// unless SEED_ON_START=false, so the API always begins from a known state.

const db: Db = openDb(config.dbPath);
if (config.seedOnStart) resetDb(db);

const server: Server = createApp(db).listen(config.port);

server.on('listening', () => {
  const url = `http://localhost:${config.port}`;
  baseLogger.info(
    { url, dbPath: config.dbPath, seeded: config.seedOnStart },
    `P2P API listening on ${url}. Try: BASE=${url} scripts/smoke.sh`,
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  baseLogger.error({ err: error, port: config.port }, `Cannot listen on port ${config.port}: ${error.message}`);
  db.close();
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  baseLogger.info({ signal }, 'Shutting down');
  // Keep-alive sockets would otherwise hold server.close() open indefinitely.
  server.close((error) => {
    if (error) baseLogger.error({ err: error }, 'Error while closing HTTP server');
    db.close();
    process.exit(error ? 1 : 0);
  });
  server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
