import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger, runWithContext } from '../context';

const PRIMARY_HEADER = 'Correlation-ID';
const FALLBACK_HEADER = 'X-Correlation-ID';
const MAX_LENGTH = 200;
// Visible ASCII only. The id is echoed back and written to logs, so it must not carry arbitrary text.
const VALID_ID = /^[\x21-\x7E]+$/;

function acceptable(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= MAX_LENGTH && VALID_ID.test(value);
}

export const correlationMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.get(PRIMARY_HEADER) ?? req.get(FALLBACK_HEADER);
  const correlationId = acceptable(incoming) ? incoming : randomUUID();
  res.setHeader(PRIMARY_HEADER, correlationId);

  runWithContext({ correlationId }, () => {
    // Capture the bound logger now: the 'finish' event fires outside the AsyncLocalStorage scope.
    const log = logger();
    const startedAt = performance.now();
    res.on('finish', () => {
      log.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Math.round(performance.now() - startedAt),
        },
        'request completed',
      );
    });
    next();
  });
};
