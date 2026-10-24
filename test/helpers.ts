import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { openDb } from '../src/db/connection';
import { seed } from '../src/db/seed';

export interface RequestOptions {
  idempotencyKey?: string;
  /** Send the POST without an Idempotency-Key header. */
  omitIdempotencyKey?: boolean;
  correlationId?: string;
}

/** Fresh in-memory DB (schema + seed) and app per call. Use one per test for isolation. */
export function createTestContext() {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db);

  function post(path: string, body?: unknown, options: RequestOptions = {}) {
    let req = request(app).post(path);
    if (!options.omitIdempotencyKey) req = req.set('Idempotency-Key', options.idempotencyKey ?? randomUUID());
    if (options.correlationId) req = req.set('Correlation-ID', options.correlationId);
    return body === undefined ? req : req.send(body as object);
  }

  function get(path: string, options: Pick<RequestOptions, 'correlationId'> = {}) {
    let req = request(app).get(path);
    if (options.correlationId) req = req.set('Correlation-ID', options.correlationId);
    return req;
  }

  return { db, app, post, get };
}

export type TestContext = ReturnType<typeof createTestContext>;

export interface LineInput {
  sku: string;
  qty: number;
  unit_cost: string;
  description?: string;
}

/** Scenario builders. They return supertest responses; they do not assert. */
export const scenario = {
  createPo: (ctx: TestContext, line_items: LineInput[], vendor_id = 'ven_acme') =>
    ctx.post('/purchase-orders', { vendor_id, line_items }),

  submitPo: (ctx: TestContext, poId: string) => ctx.post(`/purchase-orders/${poId}/submit`, {}),

  receive: (ctx: TestContext, poId: string, line_items: { line_item_id: string; qty: number }[], received_by = 'dock-1') =>
    ctx.post(`/purchase-orders/${poId}/receive`, { received_by, line_items }),

  createInvoice: (ctx: TestContext, po_id: string, amount: string, invoice_number = `INV-${randomUUID().slice(0, 8)}`, vendor_id = 'ven_acme') =>
    ctx.post('/invoices', { vendor_id, po_id, invoice_number, amount }),

  match: (ctx: TestContext, invoiceId: string) => ctx.post(`/invoices/${invoiceId}/match`, {}),

  approve: (ctx: TestContext, invoiceId: string) => ctx.post(`/invoices/${invoiceId}/approve`, {}),

  /** Create + submit a PO and return its detail body (throws if either step fails). */
  async submittedPo(ctx: TestContext, line_items: LineInput[], vendor_id = 'ven_acme') {
    const created = await scenario.createPo(ctx, line_items, vendor_id);
    if (created.status !== 201) throw new Error(`createPo failed: ${created.status} ${JSON.stringify(created.body)}`);
    const submitted = await scenario.submitPo(ctx, created.body.data.id);
    if (submitted.status !== 200) throw new Error(`submitPo failed: ${submitted.status} ${JSON.stringify(submitted.body)}`);
    return submitted.body.data;
  },
};
