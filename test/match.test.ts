import { describe, expect, it } from 'vitest';
import { createTestContext, scenario, type LineInput, type TestContext } from './helpers';

const STUD: LineInput = { sku: 'SKU-9234', qty: 50, unit_cost: '12.50' }; // ordered value 625.00

interface PoFixture {
  poId: string;
  lineIds: string[];
}

/** Create + submit a PO and optionally receive quantities (one per line, 0 = skip that line). */
async function poWith(ctx: TestContext, lines: LineInput[] = [STUD], received: number[] = [0]): Promise<PoFixture> {
  const po = await scenario.submittedPo(ctx, lines);
  const lineIds: string[] = po.line_items.map((l: { id: string }) => l.id);
  await receiveMore(ctx, { poId: po.id, lineIds }, received);
  return { poId: po.id, lineIds };
}

async function receiveMore(ctx: TestContext, po: PoFixture, qtys: number[]): Promise<void> {
  const line_items = po.lineIds.map((line_item_id, i) => ({ line_item_id, qty: qtys[i] ?? 0 })).filter((l) => l.qty > 0);
  if (line_items.length === 0) return;
  const res = await scenario.receive(ctx, po.poId, line_items);
  expect(res.status).toBe(201);
}

async function newInvoice(ctx: TestContext, poId: string, amount: string): Promise<string> {
  const res = await scenario.createInvoice(ctx, poId, amount);
  expect(res.status).toBe(201);
  return res.body.data.id;
}

async function matched(ctx: TestContext, poId: string, amount: string): Promise<string> {
  const id = await newInvoice(ctx, poId, amount);
  const res = await scenario.match(ctx, id);
  expect(res.status).toBe(200);
  return id;
}

describe('POST /invoices (create)', () => {
  it('creates a PENDING invoice with string money and a match_invoice next action', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const res = await scenario.createInvoice(ctx, poId, '375', 'INV-1');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      vendor_id: 'ven_acme',
      po_id: poId,
      invoice_number: 'INV-1',
      amount: '375.00',
      status: 'PENDING',
      matched_at: null,
      approved_at: null,
      last_match_result: null,
      gl_entries: [],
    });
    expect(res.body.next_actions).toEqual([
      expect.objectContaining({ action: 'match_invoice', method: 'POST', path: `/invoices/${res.body.data.id}/match` }),
    ]);
  });

  it('rejects an invoice from a different vendor than the PO with VENDOR_MISMATCH', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx);
    const res = await scenario.createInvoice(ctx, poId, '10.00', 'INV-X', 'ven_buildright');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VENDOR_MISMATCH');
    expect(res.body.error.details).toEqual({ invoice_vendor_id: 'ven_buildright', po_vendor_id: 'ven_acme' });
  });

  it('rejects a duplicate (vendor_id, invoice_number) with DUPLICATE_INVOICE', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx);
    const first = await scenario.createInvoice(ctx, poId, '10.00', 'INV-DUP');
    expect(first.status).toBe(201);
    const second = await scenario.createInvoice(ctx, poId, '20.00', 'INV-DUP');
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('DUPLICATE_INVOICE');
    expect(second.body.error.details.existing_invoice_id).toBe(first.body.data.id);
  });

  it('rejects an inactive vendor with VENDOR_INACTIVE', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx);
    const res = await scenario.createInvoice(ctx, poId, '10.00', 'INV-D', 'ven_defunct');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VENDOR_INACTIVE');
    expect(res.body.error.details).toEqual({ vendor_id: 'ven_defunct' });
  });

  it('returns 404 NOT_FOUND for an unknown purchase order', async () => {
    const ctx = createTestContext();
    const res = await scenario.createInvoice(ctx, 'po_missing', '10.00');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.details).toEqual({ entity: 'purchase_order', id: 'po_missing' });
  });

  it.each(['0.00', '12.345'])('rejects amount %s with VALIDATION_ERROR and issues', async (amount) => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx);
    const res = await scenario.createInvoice(ctx, poId, amount);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'amount', message: expect.any(String) })]),
    );
  });
});

describe('POST /invoices/:id/match (cumulative 3-way match)', () => {
  it('rejects an invoice above received value, keeps it PENDING and persists the rejection', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const id = await newInvoice(ctx, poId, '400.00');

    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
    expect(res.body.error.details).toEqual({
      invoice_id: id,
      po_id: poId,
      invoice_amount: '400.00',
      ordered_value: '625.00',
      received_value: '375.00',
      already_matched: '0.00',
      available_to_match: '375.00',
    });

    const after = await ctx.get(`/invoices/${id}`);
    expect(after.status).toBe(200);
    expect(after.body.data.status).toBe('PENDING');
    expect(after.body.data.matched_at).toBeNull();
    expect(after.body.data.last_match_result).toMatchObject({
      outcome: 'REJECTED',
      reason: 'INVOICE_EXCEEDS_RECEIVED_VALUE',
      invoice_amount: '400.00',
      available_to_match: '375.00',
    });
  });

  it('consumes capacity across invoices on the same PO', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    await matched(ctx, poId, '300.00');

    const b = await newInvoice(ctx, poId, '100.00');
    const rejected = await scenario.match(ctx, b);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
    expect(rejected.body.error.details).toMatchObject({
      invoice_amount: '100.00',
      received_value: '375.00',
      already_matched: '300.00',
      available_to_match: '75.00',
    });

    const c = await newInvoice(ctx, poId, '75.00');
    const ok = await scenario.match(ctx, c);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('MATCHED');
  });

  it('lets a rejected invoice be re-matched after more goods arrive, while still enforcing the cap', async () => {
    const ctx = createTestContext();
    const po = await poWith(ctx, [STUD], [30]);
    await matched(ctx, po.poId, '300.00');
    const fits = await newInvoice(ctx, po.poId, '325.00'); // 300 + 325 = 625
    const overflows = await newInvoice(ctx, po.poId, '326.00'); // 300 + 326 = 626

    expect((await scenario.match(ctx, fits)).status).toBe(422);
    expect((await scenario.match(ctx, overflows)).status).toBe(422);

    await receiveMore(ctx, po, [20]); // received value now 625.00

    const okRes = await scenario.match(ctx, fits);
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.status).toBe('MATCHED');
    expect(okRes.body.data.last_match_result).toMatchObject({ outcome: 'MATCHED', reason: 'OK' });
    expect(okRes.body.warnings).toBeUndefined();

    const overRes = await scenario.match(ctx, overflows);
    expect(overRes.status).toBe(422);
    expect(overRes.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
    expect(overRes.body.error.details).toMatchObject({ already_matched: '625.00', available_to_match: '0.00' });
  });

  it('does not let PENDING invoices consume capacity', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    await newInvoice(ctx, poId, '375.00'); // stays PENDING
    const b = await newInvoice(ctx, poId, '375.00');
    const res = await scenario.match(ctx, b);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('MATCHED');
  });

  it('lets APPROVED invoices consume capacity', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const a = await matched(ctx, poId, '300.00');
    expect((await scenario.approve(ctx, a)).status).toBe(200);

    const b = await newInvoice(ctx, poId, '100.00');
    const res = await scenario.match(ctx, b);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
    expect(res.body.error.details).toMatchObject({ already_matched: '300.00', available_to_match: '75.00' });
  });

  it('matches exactly at the received value and rejects one cent more', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);

    const over = await newInvoice(ctx, poId, '375.01');
    const overRes = await scenario.match(ctx, over);
    expect(overRes.status).toBe(422);
    expect(overRes.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');

    const exact = await newInvoice(ctx, poId, '375.00');
    const exactRes = await scenario.match(ctx, exact);
    expect(exactRes.status).toBe(200);
    expect(exactRes.body.data.status).toBe('MATCHED');
  });

  it('rejects with NOTHING_RECEIVED when no goods were received', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx);
    const id = await newInvoice(ctx, poId, '10.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOTHING_RECEIVED');
    expect(res.body.error.details).toMatchObject({
      invoice_id: id,
      po_id: poId,
      invoice_amount: '10.00',
      ordered_value: '625.00',
      received_value: '0.00',
      already_matched: '0.00',
      available_to_match: '0.00',
    });
    const after = await ctx.get(`/invoices/${id}`);
    expect(after.body.data.status).toBe('PENDING');
    expect(after.body.data.last_match_result).toMatchObject({ outcome: 'REJECTED', reason: 'NOTHING_RECEIVED' });
  });

  it('matches on partial receipt with a PARTIAL_RECEIPT_PENDING warning and approve next action', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const id = await newInvoice(ctx, poId, '200.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('MATCHED');
    expect(typeof res.body.data.matched_at).toBe('string');
    expect(res.body.data.last_match_result).toMatchObject({ outcome: 'MATCHED', partial_receipt_pending: true });
    expect(res.body.warnings).toEqual([
      expect.objectContaining({
        code: 'PARTIAL_RECEIPT_PENDING',
        description: expect.stringMatching(/\S/),
        next_steps: expect.stringMatching(/\S/),
      }),
    ]);
    expect(res.body.next_actions).toEqual([
      expect.objectContaining({ action: 'approve_invoice', method: 'POST', path: `/invoices/${id}/approve` }),
    ]);
  });

  it('matches on full receipt without a warnings key', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [50]);
    const id = await newInvoice(ctx, poId, '625.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(200);
    expect(res.body.data.last_match_result).toMatchObject({ partial_receipt_pending: false });
    expect(res.body).not.toHaveProperty('warnings');
  });

  it('rejects matching a non-PENDING invoice with INVALID_STATE_TRANSITION', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const id = await matched(ctx, poId, '100.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details).toMatchObject({
      entity: 'invoice',
      id,
      action: 'match',
      current_status: 'MATCHED',
      allowed_from: ['PENDING'],
    });
  });

  it('returns 404 NOT_FOUND for an unknown invoice', async () => {
    const ctx = createTestContext();
    const res = await scenario.match(ctx, 'inv_missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.details).toEqual({ entity: 'invoice', id: 'inv_missing' });
  });

  it('computes received value across lines with different unit costs', async () => {
    const ctx = createTestContext();
    const lines: LineInput[] = [
      { sku: 'SKU-9234', qty: 10, unit_cost: '4.25' }, // ordered 42.50
      { sku: 'SKU-3300', qty: 4, unit_cost: '12.50' }, // ordered 50.00
      { sku: 'SKU-4410', qty: 2, unit_cost: '54.00' }, // ordered 108.00
    ];
    const { poId } = await poWith(ctx, lines, [10, 2, 1]); // 42.50 + 25.00 + 54.00 = 121.50

    const over = await newInvoice(ctx, poId, '121.51');
    const overRes = await scenario.match(ctx, over);
    expect(overRes.status).toBe(422);
    expect(overRes.body.error.details).toMatchObject({
      ordered_value: '200.50',
      received_value: '121.50',
      available_to_match: '121.50',
    });

    const exact = await newInvoice(ctx, poId, '121.50');
    expect((await scenario.match(ctx, exact)).status).toBe(200);
  });

  it('does not share capacity with invoices on another PO of the same vendor', async () => {
    const ctx = createTestContext();
    const first = await poWith(ctx, [STUD], [30]);
    const second = await poWith(ctx, [STUD], [30]);
    await matched(ctx, first.poId, '375.00');

    const id = await newInvoice(ctx, second.poId, '375.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(200);
    expect(res.body.data.last_match_result).toMatchObject({ already_matched: '0.00' });
  });

  it('returns the standard error envelope on a 422', async () => {
    const ctx = createTestContext();
    const { poId } = await poWith(ctx, [STUD], [30]);
    const id = await newInvoice(ctx, poId, '400.00');
    const res = await scenario.match(ctx, id);
    expect(res.status).toBe(422);
    const { error } = res.body;
    expect(error.status).toBe(res.status);
    expect(error.description).toEqual(expect.stringMatching(/\S/));
    expect(error.next_steps).toEqual(expect.stringMatching(/\S/));
    expect(error.correlation_id).toEqual(expect.stringMatching(/\S/));
    expect(res.headers['correlation-id']).toBe(error.correlation_id);
  });
});
