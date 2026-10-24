import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/connection';
import { logger } from '../context';
import { AppError } from '../errors';
import { serverErrorBody } from './errorHandler';

const KEY_HEADER = 'Idempotency-Key';
const MAX_KEY_LENGTH = 255;
const EXEMPT_PATH = '/debug/reset';

interface StoredRecord {
  request_hash: string;
  response_status: number;
  response_body: string;
}

function isStoredRecord(row: unknown): row is StoredRecord {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.request_hash === 'string' && typeof r.response_status === 'number' && typeof r.response_body === 'string';
}

/** Recursively sorts object keys so equal JSON values always serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hashBody(body: unknown): string {
  const canonical = JSON.stringify(canonicalize(body ?? {}));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Wraps each POST in one BEGIN IMMEDIATE transaction. A stored response is replayed without running
 * the handler. Responses with status < 500 are stored and committed together with the handler's writes;
 * 5xx responses roll everything back so the client can retry with the same key.
 *
 * Requires the handler chain to be synchronous between BEGIN and res.json: the connection is shared,
 * so an await in between would let another request run inside this transaction.
 */
export function idempotencyMiddleware(db: Db): RequestHandler {
  const rollbackIfOpen = () => {
    if (db.isTransaction) db.exec('ROLLBACK');
  };
  const commitIfOpen = () => {
    if (db.isTransaction) db.exec('COMMIT');
  };

  return (req, res, next) => {
    if (req.method !== 'POST' || req.path === EXEMPT_PATH) return next();

    const key = req.get(KEY_HEADER);
    if (!key) {
      return next(
        new AppError('IDEMPOTENCY_KEY_REQUIRED', `POST ${req.path} requires an ${KEY_HEADER} header.`),
      );
    }
    // Over-length is a malformed header value rather than a missing one, so it reports as a validation issue.
    if (key.length > MAX_KEY_LENGTH) {
      return next(
        new AppError('VALIDATION_ERROR', `${KEY_HEADER} must be at most ${MAX_KEY_LENGTH} characters.`, {
          details: { issues: [{ path: KEY_HEADER, message: `must be at most ${MAX_KEY_LENGTH} characters` }] },
        }),
      );
    }

    let requestHash: string;
    try {
      requestHash = hashBody(req.body);
    } catch (err) {
      return next(err);
    }

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      return next(err);
    }

    let stored: StoredRecord | undefined;
    try {
      const row = db
        .prepare('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ? AND method = ? AND path = ?')
        .get(key, req.method, req.path);
      stored = isStoredRecord(row) ? row : undefined;
    } catch (err) {
      rollbackIfOpen();
      return next(err);
    }

    if (stored) {
      rollbackIfOpen();
      if (stored.request_hash !== requestHash) {
        return next(
          new AppError('IDEMPOTENCY_KEY_REUSED', `${KEY_HEADER} "${key}" was already used with a different request body.`),
        );
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(stored.response_status).json(JSON.parse(stored.response_body));
      return;
    }

    attachRecorder(db, req, res, key, requestHash, { rollbackIfOpen, commitIfOpen });
    next();
  };
}

interface TransactionControl {
  rollbackIfOpen: () => void;
  commitIfOpen: () => void;
}

/**
 * Replaces res.json for this request so the response that finally leaves the server (success,
 * AppError envelope from the error handler, or 5xx) decides whether the transaction commits.
 * A connection that closes without a JSON reply rolls back.
 */
function attachRecorder(
  db: Db,
  req: Request,
  res: Response,
  key: string,
  requestHash: string,
  control: TransactionControl,
): void {
  const sendJson = res.json.bind(res);
  let settled = false;

  res.json = ((body?: unknown) => {
    if (settled) return sendJson(body);
    settled = true;

    if (res.statusCode >= 500) {
      control.rollbackIfOpen();
      return sendJson(body);
    }

    try {
      db.prepare(
        'INSERT INTO idempotency_keys (key, method, path, request_hash, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(key, req.method, req.path, requestHash, res.statusCode, JSON.stringify(body ?? null), new Date().toISOString());
      control.commitIfOpen();
      return sendJson(body);
    } catch (err) {
      // Nothing from this request may persist if the record cannot be stored.
      control.rollbackIfOpen();
      logger().error({ err }, 'failed to store idempotency record');
      res.status(500);
      return sendJson(serverErrorBody(String(res.getHeader('Correlation-ID') ?? '')));
    }
  }) as Response['json'];

  res.on('close', () => {
    if (settled) return;
    settled = true;
    control.rollbackIfOpen();
  });
}
