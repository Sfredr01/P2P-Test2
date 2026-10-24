import { Router } from 'express';
import { resetDb, type Db } from '../db/connection';
import { getDebugState } from '../services/debug';
import { presentDebugState } from './presenters';

export function debugRouter(db: Db): Router {
  const router = Router();
  router.get('/debug/state', (_req, res) => {
    res.json({ data: presentDebugState(getDebugState(db)) });
  });
  router.post('/debug/reset', (_req, res) => {
    resetDb(db);
    res.json({ data: { reset: true } });
  });
  return router;
}
