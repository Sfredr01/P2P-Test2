import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection';
import { transaction } from '../db/connection';
import type { CreateInvoiceInput } from '../domain/schemas';
import { APPROVE_ALLOWED_FROM, INVOICE_ALLOWED_FROM, MATCH_ALLOWED_FROM } from '../domain/stateMachines';
import type { InvoiceRow, MatchResult, VendorCategory } from '../domain/types';
import type { InvoiceView, Warning, WithWarnings } from '../domain/views';
import { AppError, invalidTransition, notFound } from '../errors';
import { fromCents } from '../money';
import { listGlEntries, postInvoiceApproval } from './glPosting';
import { consumedCents, poValues, requirePurchaseOrder } from './purchaseOrders';
import { requireActiveVendor, requireVendor } from './vendors';

const ENTITY = 'invoice';

function requireInvoice(db: Db, id: string): InvoiceRow {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as unknown as InvoiceRow | undefined;
  if (!row) throw notFound(ENTITY, id);
  return row;
}

export function loadInvoiceView(db: Db, id: string): InvoiceView {
  const row = requireInvoice(db, id);
  const { last_match_result, ...rest } = row;
  return {
    ...rest,
    last_match_result: last_match_result ? (JSON.parse(last_match_result) as MatchResult) : null,
    gl_entries: listGlEntries(db, id),
  };
}

export function listInvoices(db: Db): InvoiceView[] {
  const ids = db.prepare('SELECT id FROM invoices ORDER BY rowid').all() as unknown as { id: string }[];
  return ids.map(({ id }) => loadInvoiceView(db, id));
}

export function getInvoice(db: Db, id: string): InvoiceView {
  return loadInvoiceView(db, id);
}

export function createInvoice(db: Db, input: CreateInvoiceInput): InvoiceView {
  return transaction(db, () => {
    requireActiveVendor(db, input.vendor_id);
    const po = requirePurchaseOrder(db, input.po_id);
    if (po.vendor_id !== input.vendor_id) {
      throw new AppError(
        'VENDOR_MISMATCH',
        `Invoice vendor ${input.vendor_id} does not match purchase order vendor ${po.vendor_id}.`,
        { details: { invoice_vendor_id: input.vendor_id, po_vendor_id: po.vendor_id } },
      );
    }
    const existing = db
      .prepare('SELECT id FROM invoices WHERE vendor_id = ? AND invoice_number = ?')
      .get(input.vendor_id, input.invoice_number) as { id: string } | undefined;
    if (existing) {
      throw new AppError(
        'DUPLICATE_INVOICE',
        `Vendor ${input.vendor_id} already has invoice ${input.invoice_number} (${existing.id}).`,
        { details: { existing_invoice_id: existing.id } },
      );
    }
    if (!INVOICE_ALLOWED_FROM.includes(po.status)) {
      throw invalidTransition('purchase_order', po.id, 'invoice', po.status, INVOICE_ALLOWED_FROM);
    }

    const id = `inv_${randomUUID()}`;
    db.prepare(
      `INSERT INTO invoices (id, vendor_id, po_id, invoice_number, amount_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
    ).run(id, input.vendor_id, input.po_id, input.invoice_number, input.amount, new Date().toISOString());
    return loadInvoiceView(db, id);
  });
}

function evaluateMatch(db: Db, invoice: InvoiceRow): MatchResult {
  const { ordered_cents, received_cents } = poValues(db, invoice.po_id);
  const alreadyMatched = consumedCents(db, invoice.po_id, invoice.id);
  const available = received_cents - alreadyMatched;
  const partial = db
    .prepare('SELECT COUNT(*) AS n FROM po_line_items WHERE po_id = ? AND qty_received < qty_ordered')
    .get(invoice.po_id) as { n: number };

  let reason: MatchResult['reason'] = 'OK';
  if (received_cents === 0) reason = 'NOTHING_RECEIVED';
  else if (invoice.amount_cents > available) reason = 'INVOICE_EXCEEDS_RECEIVED_VALUE';

  return {
    outcome: reason === 'OK' ? 'MATCHED' : 'REJECTED',
    reason,
    invoice_amount_cents: invoice.amount_cents,
    ordered_value_cents: ordered_cents,
    received_value_cents: received_cents,
    already_matched_cents: alreadyMatched,
    available_to_match_cents: available,
    partial_receipt_pending: partial.n > 0,
    evaluated_at: new Date().toISOString(),
  };
}

/** AppError details for money-based failures: the one place services format cents as decimal strings. */
function matchError(code: 'NOTHING_RECEIVED' | 'INVOICE_EXCEEDS_RECEIVED_VALUE', invoice: InvoiceRow, r: MatchResult): AppError {
  const details = {
    invoice_id: invoice.id,
    po_id: invoice.po_id,
    invoice_amount: fromCents(r.invoice_amount_cents),
    ordered_value: fromCents(r.ordered_value_cents),
    received_value: fromCents(r.received_value_cents),
    already_matched: fromCents(r.already_matched_cents),
    available_to_match: fromCents(r.available_to_match_cents),
  };
  const description =
    code === 'NOTHING_RECEIVED'
      ? `Invoice ${invoice.id} cannot be matched: nothing has been received on purchase order ${invoice.po_id}.`
      : `Invoice amount ${details.invoice_amount} exceeds the ${details.available_to_match} still available to match ` +
        `(received ${details.received_value}, already matched ${details.already_matched}).`;
  return new AppError(code, description, { details });
}

const PARTIAL_RECEIPT_WARNING: Warning = {
  code: 'PARTIAL_RECEIPT_PENDING',
  description: 'Some purchase order lines have not been fully received yet.',
  next_steps:
    'The invoice is matched only against goods received so far. More receipts may follow; approving this invoice is allowed.',
};

export function matchInvoice(db: Db, id: string): WithWarnings<InvoiceView> {
  // Check, evaluate and write in one transaction so no concurrent match can consume the same
  // received value between the check and the status change. A rejection is recorded inside it
  // and thrown after it commits, so last_match_result survives the 422.
  const { invoice, result } = transaction(db, () => {
    const invoice = requireInvoice(db, id);
    if (!MATCH_ALLOWED_FROM.includes(invoice.status)) {
      throw invalidTransition(ENTITY, id, 'match', invoice.status, MATCH_ALLOWED_FROM);
    }
    const result = evaluateMatch(db, invoice);
    db.prepare('UPDATE invoices SET last_match_result = ? WHERE id = ?').run(JSON.stringify(result), id);
    if (result.outcome === 'MATCHED') {
      db.prepare('UPDATE invoices SET status = ?, matched_at = ? WHERE id = ?').run('MATCHED', result.evaluated_at, id);
    }
    return { invoice, result };
  });

  if (result.outcome === 'REJECTED') {
    throw matchError(result.reason as 'NOTHING_RECEIVED' | 'INVOICE_EXCEEDS_RECEIVED_VALUE', invoice, result);
  }
  return {
    view: loadInvoiceView(db, id),
    warnings: result.partial_receipt_pending ? [PARTIAL_RECEIPT_WARNING] : [],
  };
}

export function approveInvoice(db: Db, id: string): InvoiceView {
  return transaction(db, () => {
    const invoice = requireInvoice(db, id);
    if (!APPROVE_ALLOWED_FROM.includes(invoice.status)) {
      throw invalidTransition(ENTITY, id, 'approve', invoice.status, APPROVE_ALLOWED_FROM);
    }
    // Defense in depth: re-check the cumulative invariant at the moment money is committed.
    const recheck = evaluateMatch(db, invoice);
    if (recheck.reason !== 'OK') throw matchError(
      recheck.reason === 'NOTHING_RECEIVED' ? 'NOTHING_RECEIVED' : 'INVOICE_EXCEEDS_RECEIVED_VALUE',
      invoice,
      recheck,
    );

    const vendor = requireVendor(db, invoice.vendor_id);
    const now = new Date().toISOString();
    db.prepare('UPDATE invoices SET status = ?, approved_at = ? WHERE id = ?').run('APPROVED', now, id);
    postInvoiceApproval(db, id, vendor.category as VendorCategory, invoice.amount_cents, now);
    return loadInvoiceView(db, id);
  });
}
