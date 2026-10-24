import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext, scenario, type TestContext } from './helpers';

const VALID_PO = {
  vendor_id: 'ven_acme',
  line_items: [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }],
};

function countRows(ctx: TestContext, table: string): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** Creates a PO and asserts 201 first, so a missing route fails on the assertion, not on a TypeError. */
async function createdPo(ctx: TestContext) {
  const res = await scenario.createPo(ctx, VALID_PO.line_items);
  expect(res.status).toBe(201);
  return res.body.data;
}

async function submittedPo(ctx: TestContext) {
  const po = await createdPo(ctx);
  const res = await scenario.submitPo(ctx, po.id);
  expect(res.status).toBe(200);
  return res.body.data;
}

function receiveBody(lineItemId: string, qty: number) {
  return { received_by: 'dock-1', line_items: [{ line_item_id: lineItemId, qty }] };
}

describe('Idempotency-Key requirement', () => {
  it('rejects a POST without Idempotency-Key with 400 IDEMPOTENCY_KEY_REQUIRED and writes nothing', async () => {
    const ctx = createTestContext();

    const res = await ctx.post('/purchase-orders', VALID_PO, { omitIdempotencyKey: true });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(countRows(ctx, 'purchase_orders')).toBe(0);
  });

  it('rejects an empty Idempotency-Key with 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const ctx = createTestContext();

    const res = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: '' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(countRows(ctx, 'purchase_orders')).toBe(0);
  });

  it('does not require a key on GET requests', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/vendors');

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });
});

describe('replay of create requests', () => {
  it('replays the same key and body with the stored response and writes once', async () => {
    const ctx = createTestContext();
    const key = randomUUID();

    const first = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: key });
    const second = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(countRows(ctx, 'purchase_orders')).toBe(1);
  });

  it('treats the same content with different key order as a replay', async () => {
    const ctx = createTestContext();
    const key = randomUUID();
    const reordered = {
      line_items: [{ unit_cost: '12.50', qty: 50, sku: 'SKU-9234' }],
      vendor_id: 'ven_acme',
    };

    const first = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: key });
    const second = await ctx.post('/purchase-orders', reordered, { idempotencyKey: key });

    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(countRows(ctx, 'purchase_orders')).toBe(1);
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSED when the same key is sent with a different body', async () => {
    const ctx = createTestContext();
    const key = randomUUID();
    const different = { ...VALID_PO, line_items: [{ sku: 'SKU-9234', qty: 51, unit_cost: '12.50' }] };

    const first = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: key });
    expect(first.status).toBe(201);
    const res = await ctx.post('/purchase-orders', different, { idempotencyKey: key });

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(countRows(ctx, 'purchase_orders')).toBe(1);
  });

  it('does not conflict when the same key was used on a different path', async () => {
    const ctx = createTestContext();
    const keyA = randomUUID();
    const sharedKey = randomUUID();

    const poA = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: keyA });
    expect(poA.status).toBe(201);
    const submit = await ctx.post(`/purchase-orders/${poA.body.data?.id}/submit`, {}, { idempotencyKey: sharedKey });
    const poB = await ctx.post('/purchase-orders', VALID_PO, { idempotencyKey: sharedKey });

    expect(submit.status).toBe(200);
    expect(poB.status).toBe(201);
    expect(poB.headers['idempotent-replayed']).toBeUndefined();
    expect(poB.body.data?.id).not.toBe(poA.body.data?.id);
    expect(countRows(ctx, 'purchase_orders')).toBe(2);
  });
});

describe('replay of action endpoints', () => {
  it('replays a submit with the same key instead of returning 409 INVALID_STATE_TRANSITION', async () => {
    const ctx = createTestContext();
    const po = await createdPo(ctx);
    const key = randomUUID();
    const path = `/purchase-orders/${po.id}/submit`;

    const first = await ctx.post(path, {}, { idempotencyKey: key });
    const second = await ctx.post(path, {}, { idempotencyKey: key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('returns 409 INVALID_STATE_TRANSITION when submit is repeated with a new key', async () => {
    const ctx = createTestContext();
    const po = await createdPo(ctx);
    const path = `/purchase-orders/${po.id}/submit`;

    const first = await ctx.post(path, {}, { idempotencyKey: randomUUID() });
    expect(first.status).toBe(200);
    const res = await ctx.post(path, {}, { idempotencyKey: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('does not double-write goods on a replayed receive', async () => {
    const ctx = createTestContext();
    const po = await submittedPo(ctx);
    const lineId = po.line_items[0].id;
    const key = randomUUID();
    const path = `/purchase-orders/${po.id}/receive`;

    const first = await ctx.post(path, receiveBody(lineId, 30), { idempotencyKey: key });
    const second = await ctx.post(path, receiveBody(lineId, 30), { idempotencyKey: key });
    const current = await ctx.get(`/purchase-orders/${po.id}`);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(current.body.data.line_items[0].qty_received).toBe(30);
    expect(countRows(ctx, 'goods_receipts')).toBe(1);
  });

  it('does not double-post GL entries on a replayed approve', async () => {
    const ctx = createTestContext();
    const po = await submittedPo(ctx);
    const received = await scenario.receive(ctx, po.id, [{ line_item_id: po.line_items[0].id, qty: 50 }]);
    expect(received.status).toBe(201);
    const invoice = await scenario.createInvoice(ctx, po.id, '625.00', 'INV-APPROVE-1');
    expect(invoice.status).toBe(201);
    const matched = await scenario.match(ctx, invoice.body.data.id);
    expect(matched.status).toBe(200);
    const key = randomUUID();
    const path = `/invoices/${invoice.body.data.id}/approve`;

    const first = await ctx.post(path, {}, { idempotencyKey: key });
    const second = await ctx.post(path, {}, { idempotencyKey: key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(countRows(ctx, 'gl_entries')).toBe(2);
  });

  it('replays a stored 4xx business error with the same body and the replay header', async () => {
    const ctx = createTestContext();
    const po = await submittedPo(ctx);
    const key = randomUUID();
    const path = `/purchase-orders/${po.id}/receive`;
    const overReceipt = receiveBody(po.line_items[0].id, 60);

    const first = await ctx.post(path, overReceipt, { idempotencyKey: key });
    const second = await ctx.post(path, overReceipt, { idempotencyKey: key });

    expect(first.status).toBe(422);
    expect(first.body.error?.code).toBe('OVER_RECEIPT');
    expect(second.status).toBe(422);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(countRows(ctx, 'goods_receipts')).toBe(0);
  });

  it('replays a stored 400 validation error with the same body', async () => {
    const ctx = createTestContext();
    const key = randomUUID();
    const invalid = { vendor_id: 'ven_acme', line_items: [{ sku: 'SKU-9234', qty: 0, unit_cost: '12.50' }] };

    const first = await ctx.post('/purchase-orders', invalid, { idempotencyKey: key });
    const second = await ctx.post('/purchase-orders', invalid, { idempotencyKey: key });

    expect(first.status).toBe(400);
    expect(first.body.error?.code).toBe('VALIDATION_ERROR');
    expect(second.status).toBe(400);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('accepts a submit with no body and replays it with the same key and no body', async () => {
    const ctx = createTestContext();
    const po = await createdPo(ctx);
    const key = randomUUID();
    const path = `/purchase-orders/${po.id}/submit`;

    const first = await ctx.post(path, undefined, { idempotencyKey: key });
    const second = await ctx.post(path, undefined, { idempotencyKey: key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('treats a missing body as {} for hashing, so {} and no body replay each other', async () => {
    const ctx = createTestContext();
    const po = await createdPo(ctx);
    const key = randomUUID();
    const path = `/purchase-orders/${po.id}/submit`;

    const first = await ctx.post(path, {}, { idempotencyKey: key });
    const second = await ctx.post(path, undefined, { idempotencyKey: key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });
});

describe('debug reset', () => {
  it('works without Idempotency-Key and restores the seed state', async () => {
    const ctx = createTestContext();
    await createdPo(ctx);

    const res = await ctx.post('/debug/reset', undefined, { omitIdempotencyKey: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { reset: true } });
    expect(countRows(ctx, 'purchase_orders')).toBe(0);
    expect(countRows(ctx, 'vendors')).toBe(3);
  });
});

describe('5xx responses', () => {
  it.todo('does not store 5xx responses and rolls back their writes so the same key can be retried');
});
