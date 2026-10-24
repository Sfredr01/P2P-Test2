import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

// Request-scoped context. middleware/correlation.ts opens a scope per request; anything
// downstream (services, logger, GL/receipt writes) reads the correlation id from here.

interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'p2p-api' },
});

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}

/** Logger bound to the current correlation id (or the base logger outside a request). */
export function logger(): pino.Logger {
  const correlationId = getCorrelationId();
  return correlationId ? baseLogger.child({ correlation_id: correlationId }) : baseLogger;
}
