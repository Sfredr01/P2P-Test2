import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AP_CONTROL_ACCOUNT, EXPENSE_ACCOUNT_BY_CATEGORY } from '../src/domain/accounts';
import { createTestContext, scenario, type LineInput, type TestContext } from './helpers';

const STUD: LineInput = { sku: 'SKU-9234', qty: 50, unit_cost: '12.50' };
const SCREWS: LineInput = { sku: 'SKU-2040', qty: 20, unit_cost: '30.00' };

/** Create → submit → receive (all lines in full) → invoice → match. Returns the MATCHED invoice id. */
async function matchedInvoice(
  ctx: TestContext,
  { lines = [STUD], vendor = 'ven_acme', receive = [30], amount = '375.00' } = {},
): Promise<{ invoiceId: string; poId: string; lineIds: string[] }> {
  const po = await scenario.submittedPo(ctx, lines, vendor);
  const lineIds: string[] = po.line_items.map((l: { id: string }) => l.id);
  const rec = await scenario.receive(
    ctx,
    po.id,
    lineIds.map((line_item_id, i) => ({ line_item_id, qty: receive[i] ?? 0 })).filter((l) => l.qty > 0),
  );
  expect(rec.status).toBe(201);
  const inv = await scenario.createInvoice(ctx, po.id, amount, `INV-${randomUUID().slice(0, 8)}`, vendor);
  expect(inv.status).toBe(201);
  const m = await scenario.match(ctx, inv.body.data.id);
  expect(m.status).toBe(200);
  return { invoiceId: inv.body.data.id, poId: po.id, lineIds };
}

const glCount = (ctx: TestContext): number =>
  (ctx.db.prepare('SELECT COUNT(*) AS c FROM gl_entries').get() as { c: number }).c;

const glTotals = (ctx: TestContext) =>
  ctx.db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM gl_entries').get() as { d: number; c: number };

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
  }
  return [];
}

describe('POST /invoices/:id/approve', () => {
  it('approves a MATCHED invoice and posts a balanced debit-expense / credit-AP pair', async () => {
    const ctx = createTestContext();
    const { invoiceId } = await matchedInvoice(ctx);

    const res = await scenario.approve(ctx, invoiceId);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(typeof res.body.data.approved_at).toBe('string');
    expect(res.body.next_actions).toEqual([]);

    const gl: Array<{ account_code: string; debit: string; credit: string }> = res.body.data.gl_entries;
    expect(gl).toHaveLength(2);
    expect(gl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_code: EXPENSE_ACCOUNT_BY_CATEGORY.LUMBER, debit: '375.00', credit: '0.00' }),
        expect.objectContaining({ account_code: AP_CONTROL_ACCOUNT, debit: '0.00', credit: '375.00' }),
      ]),
    );
    expect(glCount(ctx)).toBe(2);
    const totals = glTotals(ctx);
    expect(totals.d).toBe(37500);
    expect(totals.d).toBe(totals.c);
  });

  it('debits the hardware expense account for a HARDWARE vendor', async () => {
    const ctx = createTestContext();
    const { invoiceId } = await matchedInvoice(ctx, {
      lines: [SCREWS],
      vendor: 'ven_buildright',
      receive: [10],
      amount: '300.00',
    });
    const res = await scenario.approve(ctx, invoiceId);
    expect(res.status).toBe(200);
    expect(res.body.data.gl_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_code: EXPENSE_ACCOUNT_BY_CATEGORY.HARDWARE, debit: '300.00', credit: '0.00' }),
        expect.objectContaining({ account_code: AP_CONTROL_ACCOUNT, debit: '0.00', credit: '300.00' }),
      ]),
    );
  });

  it('rejects approving a PENDING invoice and posts nothing', async () => {
    const ctx = createTestContext();
    const po = await scenario.submittedPo(ctx, [STUD]);
    const inv = await scenario.createInvoice(ctx, po.id, '10.00');
    expect(inv.status).toBe(201);

    const res = await scenario.approve(ctx, inv.body.data.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details).toMatchObject({
      entity: 'invoice',
      id: inv.body.data.id,
      action: 'approve',
      current_status: 'PENDING',
      allowed_from: ['MATCHED'],
    });
    expect(glCount(ctx)).toBe(0);
  });

  it('rejects a second approval and keeps exactly two GL rows', async () => {
    const ctx = createTestContext();
    const { invoiceId } = await matchedInvoice(ctx);
    expect((await scenario.approve(ctx, invoiceId)).status).toBe(200);

    const again = await scenario.approve(ctx, invoiceId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(again.body.error.details).toMatchObject({ current_status: 'APPROVED', allowed_from: ['MATCHED'] });
    expect(glCount(ctx)).toBe(2);
  });

  it('stamps GL entries with the request Correlation-ID', async () => {
    const ctx = createTestContext();
    const { invoiceId } = await matchedInvoice(ctx);
    const correlationId = `corr-${randomUUID()}`;

    const res = await ctx.post(`/invoices/${invoiceId}/approve`, {}, { correlationId });
    expect(res.status).toBe(200);
    expect(res.headers['correlation-id']).toBe(correlationId);
    expect(res.body.data.gl_entries).toHaveLength(2);
    for (const entry of res.body.data.gl_entries) expect(entry.correlation_id).toBe(correlationId);

    const rows = ctx.db.prepare('SELECT correlation_id FROM gl_entries').all() as Array<{ correlation_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.correlation_id === correlationId)).toBe(true);
  });

  it('exposes money as decimal strings and never leaks _cents keys', async () => {
    const ctx = createTestContext();
    const { invoiceId } = await matchedInvoice(ctx);
    const res = await scenario.approve(ctx, invoiceId);
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe('375.00');
    expect(res.body.data.last_match_result.available_to_match).toBe('375.00');
    expect(keysDeep(res.body).filter((k) => k.includes('cents'))).toEqual([]);
    expect(keysDeep(res.body).length).toBeGreaterThan(0);
  });

  it('re-checks the cumulative invariant and refuses to approve when received goods shrink', async () => {
    const ctx = createTestContext();
    const { invoiceId, poId } = await matchedInvoice(ctx);
    // Tamper: pretend only 10 units (125.00) were received while a 375.00 invoice is MATCHED.
    ctx.db.prepare('UPDATE po_line_items SET qty_received = 10 WHERE po_id = ?').run(poId);

    const res = await scenario.approve(ctx, invoiceId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVOICE_EXCEEDS_RECEIVED_VALUE');
    expect(res.body.error.details).toMatchObject({ invoice_amount: '375.00', received_value: '125.00' });
    expect(glCount(ctx)).toBe(0);

    const after = await ctx.get(`/invoices/${invoiceId}`);
    expect(after.body.data.status).toBe('MATCHED');
    expect(after.body.data.approved_at).toBeNull();
  });

  it('keeps total debits equal to total credits across several approved invoices', async () => {
    const ctx = createTestContext();
    const a = await matchedInvoice(ctx, { amount: '375.00' });
    const b = await matchedInvoice(ctx, { amount: '100.10' });
    const c = await matchedInvoice(ctx, { lines: [SCREWS], vendor: 'ven_buildright', receive: [10], amount: '299.99' });
    for (const { invoiceId } of [a, b, c]) expect((await scenario.approve(ctx, invoiceId)).status).toBe(200);

    expect(glCount(ctx)).toBe(6);
    const totals = glTotals(ctx);
    expect(totals.d).toBe(37500 + 10010 + 29999);
    expect(totals.d).toBe(totals.c);
  });
});
