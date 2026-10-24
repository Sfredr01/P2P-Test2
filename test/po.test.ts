import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, scenario, type LineInput, type TestContext } from './helpers';

// Purchase order lifecycle: create, submit, receive, read. Written test-first against docs/api-contract.md.

const ACME = 'ven_acme';
const STUD: LineInput = { sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }; // catalog: "2x4x8 SPF Stud"
const POST: LineInput = { sku: 'SKU-3300', qty: 5, unit_cost: '12.50' }; // catalog: "Pressure-Treated 4x4x8 Post"

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

/** Creates a DRAFT PO and returns its detail body. Throws if the setup step fails. */
async function createDraft(line_items: LineInput[] = [STUD], vendor_id = ACME) {
  const res = await scenario.createPo(ctx, line_items, vendor_id);
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Creates and submits a PO, returning the SUBMITTED detail body. */
function submittedPo(line_items: LineInput[] = [STUD], vendor_id = ACME) {
  return scenario.submittedPo(ctx, line_items, vendor_id);
}

function actionNames(body: { next_actions: { action: string }[] }): string[] {
  return body.next_actions.map((a) => a.action).sort();
}

function expectValidationIssue(res: { status: number; body: any }, path: string) {
  expect(res.status).toBe(400);
  expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  expect(res.body.error?.details?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
}

/** Every object key in a JSON value, at any depth. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
  }
  return [];
}

describe('POST /purchase-orders', () => {
  it('creates a DRAFT PO with the full detail shape', async () => {
    const res = await scenario.createPo(ctx, [STUD]);

    expect(res.status).toBe(201);
    const po = res.body.data;
    expect(po.id).toMatch(/^po_/);
    expect(po).toMatchObject({
      vendor_id: ACME,
      vendor_name: 'ACME Lumber Co.',
      status: 'DRAFT',
      submitted_at: null,
    });
    expect(po.line_items).toHaveLength(1);
    expect(po.line_items[0]).toMatchObject({
      id: expect.stringMatching(/^pol_/),
      sku: 'SKU-9234',
      description: '2x4x8 SPF Stud',
      qty_ordered: 50,
      qty_received: 0,
      qty_outstanding: 50,
      unit_cost: '12.50',
      line_total: '625.00',
      received_value: '0.00',
      receipt_status: 'NOT_RECEIVED',
    });
    expect(po.totals).toEqual({ ordered: '625.00', received: '0.00', matched: '0.00', available_to_match: '0.00' });
    expect(po.receipts).toEqual([]);
    expect(po.invoices).toEqual([]);
    expect(res.body.next_actions).toEqual([
      expect.objectContaining({
        action: 'submit_purchase_order',
        method: 'POST',
        path: `/purchase-orders/${po.id}/submit`,
      }),
    ]);
  });

  it('defaults the line description to the catalog description when omitted', async () => {
    const po = await createDraft([STUD]);
    expect(po.line_items[0].description).toBe('2x4x8 SPF Stud');
  });

  it('keeps a custom line description', async () => {
    const po = await createDraft([{ ...STUD, description: 'Kiln-dried studs, bundle of 50' }]);
    expect(po.line_items[0].description).toBe('Kiln-dried studs, bundle of 50');
  });

  it.each([
    ['12.5', '12.50'],
    ['12', '12.00'],
  ])('accepts unit_cost %j and returns it as %j', async (input, expected) => {
    const po = await createDraft([{ ...STUD, unit_cost: input }]);
    expect(po.line_items[0].unit_cost).toBe(expected);
  });

  it('rejects unit_cost with more than 2 decimals', async () => {
    const res = await scenario.createPo(ctx, [{ ...STUD, unit_cost: '4.255' }]);
    expectValidationIssue(res, 'line_items.0.unit_cost');
  });

  it('rejects unit_cost sent as a JSON number', async () => {
    const res = await ctx.post('/purchase-orders', {
      vendor_id: ACME,
      line_items: [{ sku: 'SKU-9234', qty: 1, unit_cost: 12.5 }],
    });
    expectValidationIssue(res, 'line_items.0.unit_cost');
  });

  it('returns 422 VENDOR_INACTIVE for an inactive vendor', async () => {
    const res = await scenario.createPo(ctx, [STUD], 'ven_defunct');

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VENDOR_INACTIVE');
    expect(res.body.error?.details).toEqual({ vendor_id: 'ven_defunct' });
  });

  it('returns 404 for an unknown vendor', async () => {
    const res = await scenario.createPo(ctx, [STUD], 'ven_nope');

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.details).toEqual(expect.objectContaining({ entity: 'vendor' }));
  });

  it('returns 422 UNKNOWN_SKU listing every unknown SKU', async () => {
    const res = await scenario.createPo(ctx, [
      { sku: 'SKU-NOPE', qty: 1, unit_cost: '1.00' },
      STUD,
      { sku: 'SKU-XXX', qty: 2, unit_cost: '2.00' },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('UNKNOWN_SKU');
    expect(res.body.error?.details.skus).toHaveLength(2);
    expect(res.body.error?.details.skus).toEqual(expect.arrayContaining(['SKU-NOPE', 'SKU-XXX']));
  });

  it.each([
    ['empty line_items', { vendor_id: ACME, line_items: [] }, 'line_items'],
    ['qty 0', { vendor_id: ACME, line_items: [{ ...STUD, qty: 0 }] }, 'line_items.0.qty'],
    ['qty 1.5', { vendor_id: ACME, line_items: [{ ...STUD, qty: 1.5 }] }, 'line_items.0.qty'],
    ['negative qty', { vendor_id: ACME, line_items: [{ ...STUD, qty: -3 }] }, 'line_items.0.qty'],
    [
      'duplicate SKU',
      { vendor_id: ACME, line_items: [STUD, { ...STUD, qty: 10 }] },
      'line_items',
    ],
    ['missing vendor_id', { line_items: [STUD] }, 'vendor_id'],
  ])('returns 400 VALIDATION_ERROR for %s', async (_label, body, path) => {
    const res = await ctx.post('/purchase-orders', body);
    expectValidationIssue(res, path);
  });
});

describe('GET /purchase-orders/:id', () => {
  it('returns the same detail that create returned', async () => {
    const created = await scenario.createPo(ctx, [STUD]);
    expect(created.status).toBe(201);
    const res = await ctx.get(`/purchase-orders/${created.body.data.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created.body.data);
    expect(res.body.next_actions).toEqual(created.body.next_actions);
  });

  it('returns 404 for an unknown PO', async () => {
    const res = await ctx.get('/purchase-orders/po_nope');

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.details).toEqual(expect.objectContaining({ entity: 'purchase_order' }));
  });
});

describe('POST /purchase-orders/:id/submit', () => {
  it('moves a DRAFT PO to SUBMITTED with next_actions for receiving and invoicing', async () => {
    const draft = await createDraft();
    const res = await scenario.submitPo(ctx, draft.id);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(draft.id);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(typeof res.body.data.submitted_at).toBe('string');
    expect(actionNames(res.body)).toEqual(['create_invoice', 'receive_goods']);
    expect(res.body.next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'receive_goods', method: 'POST', path: `/purchase-orders/${draft.id}/receive` }),
        expect.objectContaining({ action: 'create_invoice', method: 'POST', path: '/invoices' }),
      ]),
    );
  });

  it('returns 409 INVALID_STATE_TRANSITION when submitting an already SUBMITTED PO', async () => {
    const po = await submittedPo();
    const res = await scenario.submitPo(ctx, po.id);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error?.details).toEqual(
      expect.objectContaining({
        entity: 'purchase_order',
        id: po.id,
        action: 'submit',
        current_status: 'SUBMITTED',
        allowed_from: ['DRAFT'],
      }),
    );
  });

  it('returns 404 for an unknown PO', async () => {
    const res = await scenario.submitPo(ctx, 'po_nope');

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('POST /purchase-orders/:id/receive', () => {
  it('returns 409 INVALID_STATE_TRANSITION when receiving on a DRAFT PO', async () => {
    const draft = await createDraft();
    const res = await scenario.receive(ctx, draft.id, [{ line_item_id: draft.line_items[0].id, qty: 1 }]);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error?.details).toEqual(
      expect.objectContaining({ action: 'receive', current_status: 'DRAFT' }),
    );
  });

  it('records a partial receipt: PARTIALLY_RECEIVED with totals, receipt and next_actions', async () => {
    const po = await submittedPo([STUD]);
    const line = po.line_items[0];
    const res = await scenario.receive(ctx, po.id, [{ line_item_id: line.id, qty: 30 }], 'dock-1');

    expect(res.status).toBe(201);
    const body = res.body.data;
    expect(body.status).toBe('PARTIALLY_RECEIVED');
    expect(body.line_items[0]).toMatchObject({
      qty_received: 30,
      qty_outstanding: 20,
      received_value: '375.00',
      receipt_status: 'PARTIAL',
    });
    expect(body.totals).toEqual({ ordered: '625.00', received: '375.00', matched: '0.00', available_to_match: '375.00' });

    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      id: expect.stringMatching(/^gr_/),
      received_by: 'dock-1',
      received_at: expect.any(String),
      line_items: [{ line_item_id: line.id, sku: 'SKU-9234', qty: 30 }],
    });

    expect(actionNames(res.body)).toEqual(['create_invoice', 'receive_goods']);
  });

  it('appends a second receipt, reaches RECEIVED, and offers only create_invoice', async () => {
    const po = await submittedPo([STUD]);
    const lineId = po.line_items[0].id;
    await scenario.receive(ctx, po.id, [{ line_item_id: lineId, qty: 30 }]);

    const res = await scenario.receive(ctx, po.id, [{ line_item_id: lineId, qty: 20 }]);

    expect(res.status).toBe(201);
    const body = res.body.data;
    expect(body.status).toBe('RECEIVED');
    expect(body.line_items[0]).toMatchObject({ qty_received: 50, qty_outstanding: 0, receipt_status: 'FULL' });
    expect(body.totals.received).toBe('625.00');
    expect(body.receipts).toHaveLength(2);
    expect(body.receipts[0].line_items[0].qty).toBe(30);
    expect(body.receipts[1].line_items[0].qty).toBe(20);
    expect(actionNames(res.body)).toEqual(['create_invoice']);
  });

  it('returns 409 when receiving on a fully RECEIVED PO', async () => {
    const po = await submittedPo([STUD]);
    await scenario.receive(ctx, po.id, [{ line_item_id: po.line_items[0].id, qty: 50 }]);

    const res = await scenario.receive(ctx, po.id, [{ line_item_id: po.line_items[0].id, qty: 1 }]);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error?.details).toEqual(expect.objectContaining({ current_status: 'RECEIVED' }));
  });

  it('returns 422 OVER_RECEIPT when qty exceeds the ordered quantity', async () => {
    const po = await submittedPo([STUD]);
    const lineId = po.line_items[0].id;
    const res = await scenario.receive(ctx, po.id, [{ line_item_id: lineId, qty: 51 }]);

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('OVER_RECEIPT');
    expect(res.body.error?.details.lines).toEqual([
      { line_item_id: lineId, sku: 'SKU-9234', qty_requested: 51, qty_outstanding: 50 },
    ]);
  });

  it('returns 422 OVER_RECEIPT when qty exceeds what is still outstanding', async () => {
    const po = await submittedPo([STUD]);
    const lineId = po.line_items[0].id;
    await scenario.receive(ctx, po.id, [{ line_item_id: lineId, qty: 30 }]);

    const res = await scenario.receive(ctx, po.id, [{ line_item_id: lineId, qty: 21 }]);

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('OVER_RECEIPT');
    expect(res.body.error?.details.lines).toEqual([
      { line_item_id: lineId, sku: 'SKU-9234', qty_requested: 21, qty_outstanding: 20 },
    ]);
  });

  it('is all-or-nothing: an over-receipt on one line writes nothing on any line', async () => {
    const po = await submittedPo([STUD, POST]);
    const [studLine, postLine] = po.line_items;

    const res = await scenario.receive(ctx, po.id, [
      { line_item_id: studLine.id, qty: 10 },
      { line_item_id: postLine.id, qty: 6 },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('OVER_RECEIPT');
    expect(res.body.error?.details.lines).toEqual([
      { line_item_id: postLine.id, sku: 'SKU-3300', qty_requested: 6, qty_outstanding: 5 },
    ]);

    const after = (await ctx.get(`/purchase-orders/${po.id}`)).body.data;
    expect(after?.status).toBe('SUBMITTED');
    expect(after?.line_items?.map((l: { qty_received: number }) => l.qty_received)).toEqual([0, 0]);
    expect(after?.receipts).toEqual([]);
  });

  it('returns 404 entity line_item when the line belongs to a different PO', async () => {
    const otherPo = await submittedPo([STUD]);
    const po = await submittedPo([POST]);

    const res = await scenario.receive(ctx, po.id, [{ line_item_id: otherPo.line_items[0].id, qty: 1 }]);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.details).toEqual(expect.objectContaining({ entity: 'line_item' }));
  });

  it('returns 404 for an unknown PO', async () => {
    const res = await scenario.receive(ctx, 'po_nope', [{ line_item_id: 'pol_nope', qty: 1 }]);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it.each([
    [
      'qty 0',
      (lineId: string) => ({ received_by: 'dock-1', line_items: [{ line_item_id: lineId, qty: 0 }] }),
      'line_items.0.qty',
    ],
    ['empty line_items', () => ({ received_by: 'dock-1', line_items: [] }), 'line_items'],
    [
      'missing received_by',
      (lineId: string) => ({ line_items: [{ line_item_id: lineId, qty: 1 }] }),
      'received_by',
    ],
    [
      'duplicate line_item_id',
      (lineId: string) => ({
        received_by: 'dock-1',
        line_items: [
          { line_item_id: lineId, qty: 1 },
          { line_item_id: lineId, qty: 2 },
        ],
      }),
      'line_items',
    ],
  ])('returns 400 VALIDATION_ERROR for %s', async (_label, buildBody, path) => {
    const po = await submittedPo([STUD]);
    const res = await ctx.post(`/purchase-orders/${po.id}/receive`, buildBody(po.line_items[0].id));
    expectValidationIssue(res, path);
  });

  it('keeps a multi-line PO PARTIALLY_RECEIVED until every line is fully received', async () => {
    const po = await submittedPo([STUD, POST]);
    const [studLine, postLine] = po.line_items;

    const first = await scenario.receive(ctx, po.id, [{ line_item_id: studLine.id, qty: 50 }]);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('PARTIALLY_RECEIVED');

    const second = await scenario.receive(ctx, po.id, [{ line_item_id: postLine.id, qty: 5 }]);
    expect(second.status).toBe(201);
    expect(second.body.data.status).toBe('RECEIVED');
    expect(second.body.data.line_items.map((l: { receipt_status: string }) => l.receipt_status)).toEqual([
      'FULL',
      'FULL',
    ]);
  });

  it('still submits and receives a PO whose vendor was deactivated afterwards', async () => {
    const draft = await createDraft([STUD], ACME);
    ctx.db.prepare("UPDATE vendors SET is_active=0 WHERE id='ven_acme'").run();

    const submitted = await scenario.submitPo(ctx, draft.id);
    expect(submitted.status).toBe(200);

    const received = await scenario.receive(ctx, draft.id, [{ line_item_id: draft.line_items[0].id, qty: 50 }]);
    expect(received.status).toBe(201);
    expect(received.body.data.status).toBe('RECEIVED');
  });

  it('never exposes *_cents keys in PO responses', async () => {
    const po = await submittedPo([STUD]);
    const received = await scenario.receive(ctx, po.id, [{ line_item_id: po.line_items[0].id, qty: 30 }]);
    const fetched = await ctx.get(`/purchase-orders/${po.id}`);

    for (const body of [received.body, fetched.body]) {
      expect(keysDeep(body).filter((key) => key.endsWith('_cents'))).toEqual([]);
    }
  });
});

describe('GET /vendors', () => {
  it('lists all three seeded vendors with boolean is_active', async () => {
    const res = await ctx.get('/vendors');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    for (const vendor of res.body.data) {
      expect(typeof vendor.is_active).toBe('boolean');
    }
    expect(res.body.data.find((v: { id: string }) => v.id === 'ven_defunct').is_active).toBe(false);
  });
});

describe('GET /vendors/:id', () => {
  it('returns the vendor with empty next_actions', async () => {
    const res = await ctx.get('/vendors/ven_acme');

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('ACME Lumber Co.');
    expect(res.body.next_actions).toEqual([]);
  });

  it('returns 404 for an unknown vendor', async () => {
    const res = await ctx.get('/vendors/nope');

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.details).toEqual(expect.objectContaining({ entity: 'vendor' }));
  });
});

describe('GET /skus', () => {
  it('lists the 8 seeded SKUs with a decimal default_unit_cost', async () => {
    const res = await ctx.get('/skus');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(8);
    const stud = res.body.data.find((s: { sku: string }) => s.sku === 'SKU-9234');
    expect(stud.default_unit_cost).toBe('4.25');
  });
});

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await ctx.get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok' });
  });
});
