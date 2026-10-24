import { Router } from 'express';
import type { Db } from '../db/connection';
import { createInvoiceSchema, emptyActionSchema } from '../domain/schemas';
import { parseBody } from '../middleware/validate';
import { approveInvoice, createInvoice, getInvoice, matchInvoice } from '../services/invoices';
import { invoiceEnvelope } from './presenters';

export function invoicesRouter(db: Db): Router {
  const router = Router();
  router.post('/invoices', (req, res) => {
    const input = parseBody(createInvoiceSchema, req.body);
    res.status(201).json(invoiceEnvelope(createInvoice(db, input)));
  });
  router.get('/invoices/:id', (req, res) => {
    res.json(invoiceEnvelope(getInvoice(db, req.params.id)));
  });
  router.post('/invoices/:id/match', (req, res) => {
    parseBody(emptyActionSchema, req.body);
    const { view, warnings } = matchInvoice(db, req.params.id);
    res.json(invoiceEnvelope(view, warnings));
  });
  router.post('/invoices/:id/approve', (req, res) => {
    parseBody(emptyActionSchema, req.body);
    res.json(invoiceEnvelope(approveInvoice(db, req.params.id)));
  });
  return router;
}
