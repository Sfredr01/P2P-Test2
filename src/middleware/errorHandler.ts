import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { getCorrelationId, logger } from '../context';
import { AppError, ERROR_CATALOG } from '../errors';

// Documented routes, shown to callers on unknown-route 404s. Mirrors docs/api-contract.md.
const ROUTES = [
  'GET /health',
  'GET /vendors',
  'GET /vendors/:id',
  'GET /skus',
  'POST /purchase-orders',
  'POST /purchase-orders/:id/submit',
  'GET /purchase-orders/:id',
  'POST /purchase-orders/:id/receive',
  'POST /invoices',
  'POST /invoices/:id/match',
  'GET /invoices/:id',
  'POST /invoices/:id/approve',
  ...(process.env.NODE_ENV !== 'production' ? ['GET /debug/state', 'POST /debug/reset'] : []),
];

const UNEXPECTED_DESCRIPTION = 'An unexpected error occurred on the server. No changes were stored.';

export interface ErrorBody {
  error: {
    code: string;
    status: number;
    description: string;
    next_steps: string;
    details?: Record<string, unknown>;
    correlation_id: string;
  };
}

/** Builds the documented error envelope. Shared with the idempotency middleware for 5xx replies. */
export function buildErrorBody(err: AppError, correlationId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      status: err.status,
      description: err.message,
      next_steps: err.nextSteps,
      ...(err.details === undefined ? {} : { details: err.details }),
      correlation_id: correlationId,
    },
  };
}

export function serverErrorBody(correlationId: string): ErrorBody {
  return buildErrorBody(
    new AppError('SERVER_ERROR', UNEXPECTED_DESCRIPTION, { nextSteps: ERROR_CATALOG.SERVER_ERROR.next_steps }),
    correlationId,
  );
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    new AppError('NOT_FOUND', `No route matches ${req.method} ${req.path}.`, {
      nextSteps: `Use one of the available routes: ${ROUTES.join(', ')}.`,
      details: { method: req.method, path: req.path },
    }),
  );
};

/**
 * Client-side body failures from body-parser (bad JSON, oversize body, unsupported charset...).
 * They carry expose=true, a 4xx status and a stable `type`. Their messages can echo request bytes,
 * so only `type` is used.
 */
function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { expose?: unknown; status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  const isClientStatus = typeof status === 'number' && status >= 400 && status < 500;
  return e.expose === true && isClientStatus && typeof e.type === 'string' ? e.type : undefined;
}

function describeBodyError(type: string): { description: string; issue: string } {
  switch (type) {
    case 'entity.parse.failed':
      return { description: 'Request body is not valid JSON.', issue: 'Malformed JSON body.' };
    case 'entity.too.large':
      return { description: 'Request body exceeds the 100kb limit.', issue: 'Body is larger than 100kb.' };
    default:
      return { description: `Request body could not be read: ${type}.`, issue: 'Body could not be read.' };
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Express's default handler closes the connection itself once headers are out.
  if (res.headersSent) return next(err);

  const correlationId = getCorrelationId() ?? String(res.getHeader('Correlation-ID') ?? '');

  if (err instanceof AppError) {
    return send(res, err.status, buildErrorBody(err, correlationId));
  }

  const bodyErrorType = bodyParserErrorType(err);
  if (bodyErrorType !== undefined) {
    const { description, issue } = describeBodyError(bodyErrorType);
    const bodyError = new AppError('VALIDATION_ERROR', description, {
      details: { issues: [{ path: '(root)', message: issue }] },
    });
    return send(res, bodyError.status, buildErrorBody(bodyError, correlationId));
  }

  logger().error({ err }, 'unhandled error');
  return send(res, ERROR_CATALOG.SERVER_ERROR.status, serverErrorBody(correlationId));
};

function send(res: Response, status: number, body: ErrorBody): void {
  res.status(status).json(body);
}
