import { Router } from 'express';
import type { Db } from '../db/connection';
import { getVendor, listSkus, listVendors } from '../services/vendors';
import { list, presentSku, presentVendor, single } from './presenters';

export function vendorsRouter(db: Db): Router {
  const router = Router();
  router.get('/vendors', (_req, res) => {
    res.json(list(listVendors(db).map(presentVendor)));
  });
  router.get('/vendors/:id', (req, res) => {
    res.json(single(presentVendor(getVendor(db, req.params.id)), []));
  });
  router.get('/skus', (_req, res) => {
    res.json(list(listSkus(db).map(presentSku)));
  });
  return router;
}
