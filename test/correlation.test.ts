import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext, scenario, type TestContext } from './helpers';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LINES = [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }];

/** Creates and submits a PO, asserting each step so setup failures show as assertion failures. */
async function submittedPo(ctx: TestContext) {
  const created = await scenario.createPo(ctx, LINES);
  expect(created.status).toBe(201);
  const submitted = await scenario.submitPo(ctx, created.body.data.id);
  expect(submitted.status).toBe(200);
  return submitted.body.data;
}

function rows(ctx: TestContext, sql: string): Array<Record<string, unknown>> {
  return ctx.db.prepare(sql).all() as Array<Record<string, unknown>>;
}

describe('Correlation-ID header', () => {
  it('echoes the Correlation-ID request header on the response', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/vendors', { correlationId: 'corr-echo-1' });

    expect(res.status).toBe(200);
    expect(res.headers['correlation-id']).toBe('corr-echo-1');
  });

  it('uses X-Correlation-ID when Correlation-ID is absent', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/vendors').set('X-Correlation-ID', 'x-corr-1');

    expect(res.headers['correlation-id']).toBe('x-corr-1');
  });

  it('prefers Correlation-ID over X-Correlation-ID when both are sent', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/vendors', { correlationId: 'primary-1' }).set('X-Correlation-ID', 'secondary-1');

    expect(res.headers['correlation-id']).toBe('primary-1');
  });

  it('generates a UUID v4 when neither header is sent', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/vendors');

    expect(String(res.headers['correlation-id'])).toMatch(UUID_V4);
  });

  it('is present on error responses and matches error.correlation_id', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/purchase-orders/po_does_not_exist', { correlationId: 'err-corr-1' });

    expect(res.status).toBe(404);
    expect(res.headers['correlation-id']).toBe('err-corr-1');
    expect(res.body.error?.correlation_id).toBe('err-corr-1');
  });

  it('is present on unknown-route 404 responses', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/no-such-route', { correlationId: 'route-corr-1' });

    expect(res.status).toBe(404);
    expect(res.headers['correlation-id']).toBe('route-corr-1');
  });

  it('keeps each concurrent request on its own id', async () => {
    const ctx = createTestContext();
    const ids = Array.from({ length: 10 }, (_, i) => `concurrent-${i}-${randomUUID()}`);

    const responses = await Promise.all(ids.map((id) => ctx.get('/vendors', { correlationId: id })));

    responses.forEach((res, i) => {
      expect(res.headers['correlation-id']).toBe(ids[i]);
    });
  });
});

describe('correlation id persisted with writes', () => {
  it('stamps goods_receipts.correlation_id with the id sent on the receive request', async () => {
    const ctx = createTestContext();
    const po = await submittedPo(ctx);

    const res = await ctx.post(
      `/purchase-orders/${po.id}/receive`,
      { received_by: 'dock-1', line_items: [{ line_item_id: po.line_items[0].id, qty: 10 }] },
      { correlationId: 'recv-corr-1' },
    );

    expect(res.status).toBe(201);
    expect(res.headers['correlation-id']).toBe('recv-corr-1');
    expect(rows(ctx, 'SELECT correlation_id FROM goods_receipts')).toEqual([{ correlation_id: 'recv-corr-1' }]);
  });

  it('stamps gl_entries.correlation_id with the id sent on the approve request', async () => {
    const ctx = createTestContext();
    const po = await submittedPo(ctx);
    const received = await scenario.receive(ctx, po.id, [{ line_item_id: po.line_items[0].id, qty: 50 }]);
    expect(received.status).toBe(201);
    const invoice = await scenario.createInvoice(ctx, po.id, '625.00', 'INV-CORR-1');
    expect(invoice.status).toBe(201);
    const matched = await scenario.match(ctx, invoice.body.data.id);
    expect(matched.status).toBe(200);

    const res = await ctx.post(`/invoices/${invoice.body.data.id}/approve`, {}, { correlationId: 'approve-corr-1' });

    expect(res.status).toBe(200);
    const entries = rows(ctx, 'SELECT correlation_id FROM gl_entries');
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.correlation_id).toBe('approve-corr-1');
    }
  });
});
