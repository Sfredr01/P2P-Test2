import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestContext, scenario, type TestContext } from './helpers';

const REQUIRED_ERROR_KEYS = ['code', 'status', 'description', 'next_steps', 'correlation_id'];
const ALLOWED_ERROR_KEYS = [...REQUIRED_ERROR_KEYS, 'details'];
const LEAK_PATTERN = /at .*\.ts|SQLITE|stack/i;

const LINES = [{ sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }];

/** Asserts the documented error envelope shape on a response. */
function expectErrorEnvelope(res: { status: number; body: any; headers: Record<string, unknown>; text: string }) {
  expect(String(res.headers['content-type'])).toMatch(/application\/json/);
  expect(Object.keys(res.body).sort()).toEqual(['error']);

  const error = res.body?.error ?? {};
  for (const key of REQUIRED_ERROR_KEYS) expect(error).toHaveProperty(key);
  for (const key of Object.keys(error)) expect(ALLOWED_ERROR_KEYS).toContain(key);

  expect(error.status).toBe(res.status);
  expect(typeof error.description).toBe('string');
  expect(typeof error.next_steps).toBe('string');
  expect(error.next_steps.length).toBeGreaterThan(0);
  expect(error.description).not.toMatch(LEAK_PATTERN);
  expect(error.next_steps).not.toMatch(LEAK_PATTERN);
  expect(res.text).not.toMatch(LEAK_PATTERN);
}

/** Creates and submits a PO, asserting each step so setup failures show as assertion failures. */
async function submittedPo(ctx: TestContext) {
  const created = await scenario.createPo(ctx, LINES);
  expect(created.status).toBe(201);
  const submitted = await scenario.submitPo(ctx, created.body.data.id);
  expect(submitted.status).toBe(200);
  return submitted.body.data;
}

const validBody = { vendor_id: 'ven_acme', line_items: LINES };

const errorCases: Array<[string, (ctx: TestContext) => Promise<any>]> = [
  ['404 unknown purchase order', (ctx) => ctx.get('/purchase-orders/po_missing')],
  ['404 unknown route', (ctx) => ctx.get('/nope')],
  ['400 missing Idempotency-Key', (ctx) => ctx.post('/purchase-orders', validBody, { omitIdempotencyKey: true })],
  [
    '400 validation failure',
    (ctx) => ctx.post('/purchase-orders', { vendor_id: 'ven_acme', line_items: [{ sku: 'SKU-9234', qty: 0, unit_cost: '12.50' }] }),
  ],
  ['422 inactive vendor', (ctx) => ctx.post('/purchase-orders', { vendor_id: 'ven_defunct', line_items: LINES })],
  [
    '422 unknown SKU',
    (ctx) => ctx.post('/purchase-orders', { vendor_id: 'ven_acme', line_items: [{ sku: 'SKU-NOPE', qty: 1, unit_cost: '1.00' }] }),
  ],
  [
    '409 invalid state transition',
    async (ctx) => {
      const po = await submittedPo(ctx);
      return ctx.post(`/purchase-orders/${po.id}/submit`, {});
    },
  ],
];

describe('error envelope', () => {
  it('returns 404 NOT_FOUND with method and path details for an unknown route', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.details).toEqual({ method: 'GET', path: '/nope' });
    expect(res.body.error?.next_steps?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns a VALIDATION_ERROR envelope, not Express HTML, for malformed JSON', async () => {
    const ctx = createTestContext();

    const res = await request(ctx.app)
      .post('/purchase-orders')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json')
      .send('{bad');

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expectErrorEnvelope(res);
  });

  it('returns 400 VALIDATION_ERROR when the JSON body exceeds the parser size limit', async () => {
    const ctx = createTestContext();

    const res = await ctx.post('/purchase-orders', {
      vendor_id: 'ven_acme',
      line_items: [],
      pad: 'x'.repeat(200_000),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.description).toMatch(/100kb/);
    expect(res.body.error?.details?.issues?.[0]?.path).toBe('(root)');
    expectErrorEnvelope(res);
  });

  it('returns 400 VALIDATION_ERROR for an unsupported request charset', async () => {
    const ctx = createTestContext();

    const res = await request(ctx.app)
      .post('/purchase-orders')
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'application/json; charset=latin-9')
      .send(JSON.stringify(validBody));

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.details?.issues?.[0]?.path).toBe('(root)');
    expectErrorEnvelope(res);
  });

  it.each(errorCases)('uses the envelope shape for %s', async (_label, run) => {
    const ctx = createTestContext();

    const res = await run(ctx);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expectErrorEnvelope(res);
  });

  it('includes details.issues as {path, message} entries for validation errors', async () => {
    const ctx = createTestContext();

    const res = await ctx.post(
      '/purchase-orders',
      { vendor_id: 'ven_acme', line_items: [{ sku: 'SKU-9234', qty: 0, unit_cost: '12.50' }] },
      { idempotencyKey: randomUUID() },
    );

    expect(res.status).toBe(400);
    const issues = res.body.error?.details?.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.path).toBe('string');
      expect(typeof issue.message).toBe('string');
    }
    expect(issues.map((issue: { path: string }) => issue.path)).toContain('line_items.0.qty');
  });

  it('never exposes stack traces or SQL in an unexpected-path error', async () => {
    const ctx = createTestContext();

    const res = await ctx.get('/purchase-orders/po_missing');

    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.text).not.toMatch(LEAK_PATTERN);
  });
});
