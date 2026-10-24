import express from 'express';
import { config } from './config';
import type { Db } from './db/connection';
import { correlationMiddleware } from './middleware/correlation';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { idempotencyMiddleware } from './middleware/idempotency';
import { debugRouter } from './routes/debug';
import { invoicesRouter } from './routes/invoices';
import { purchaseOrdersRouter } from './routes/purchaseOrders';
import { vendorsRouter } from './routes/vendors';

// Order matters: correlation first (so every response, even parse errors, carries the id),
// then JSON parsing, then idempotency (wraps each POST in one transaction), routes, 404, errors.
export function createApp(db: Db): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(correlationMiddleware);
  app.use(express.json());
  app.use(idempotencyMiddleware(db));

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });
  app.use(vendorsRouter(db));
  app.use(purchaseOrdersRouter(db));
  app.use(invoicesRouter(db));
  if (config.debugRoutes) app.use(debugRouter(db));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
