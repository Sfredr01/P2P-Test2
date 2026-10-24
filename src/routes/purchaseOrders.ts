import { Router } from 'express';
import type { Db } from '../db/connection';
import { createPurchaseOrderSchema, emptyActionSchema, receiveGoodsSchema } from '../domain/schemas';
import { parseBody } from '../middleware/validate';
import { createPurchaseOrder, getPurchaseOrder, receiveGoods, submitPurchaseOrder } from '../services/purchaseOrders';
import { poEnvelope } from './presenters';

export function purchaseOrdersRouter(db: Db): Router {
  const router = Router();
  router.post('/purchase-orders', (req, res) => {
    const input = parseBody(createPurchaseOrderSchema, req.body);
    res.status(201).json(poEnvelope(createPurchaseOrder(db, input)));
  });
  router.get('/purchase-orders/:id', (req, res) => {
    res.json(poEnvelope(getPurchaseOrder(db, req.params.id)));
  });
  router.post('/purchase-orders/:id/submit', (req, res) => {
    parseBody(emptyActionSchema, req.body);
    res.json(poEnvelope(submitPurchaseOrder(db, req.params.id)));
  });
  router.post('/purchase-orders/:id/receive', (req, res) => {
    const input = parseBody(receiveGoodsSchema, req.body);
    res.status(201).json(poEnvelope(receiveGoods(db, req.params.id, input)));
  });
  return router;
}
