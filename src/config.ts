// Single place that reads process.env. Everything else imports `config`.

export interface Config {
  port: number;
  dbPath: string;
  seedOnStart: boolean;
  debugRoutes: boolean;
  logLevel: string;
}

function parsePort(raw: string | undefined): number {
  const value = raw ?? '3000';
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid PORT "${value}": expected an integer, e.g. PORT=3000`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": must be between 1 and 65535`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: parsePort(env.PORT),
    dbPath: env.DB_PATH ?? './data/p2p.db',
    // Seeding is on unless explicitly disabled.
    seedOnStart: env.SEED_ON_START !== 'false',
    // Debug routes (e.g. POST /debug/reset) are never exposed in production.
    debugRoutes: env.NODE_ENV !== 'production',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

export const config: Config = loadConfig(process.env);
