import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection';
import { transaction } from '../db/connection';
import type { CreatePurchaseOrderInput, ReceiveGoodsInput } from '../domain/schemas';
import { RECEIVE_ALLOWED_FROM, SUBMIT_ALLOWED_FROM } from '../domain/stateMachines';
import {
  MATCH_CONSUMING_STATUSES,
  type PoLineItemRow,
  type PurchaseOrderRow,
  type SkuRow,
} from '../domain/types';
import type { PoInvoiceSummary, PoLineView, PurchaseOrderView, ReceiptStatus } from '../domain/views';
import { AppError, invalidTransition, notFound } from '../errors';
import { listReceipts, recordReceipt } from './receipts';
import { requireActiveVendor } from './vendors';

const ENTITY = 'purchase_order';
const CONSUMING_PLACEHOLDERS = MATCH_CONSUMING_STATUSES.map(() => '?').join(', ');

export function requirePurchaseOrder(db: Db, id: string): PurchaseOrderRow {
  const row = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as unknown as PurchaseOrderRow | undefined;
  if (!row) throw notFound(ENTITY, id);
  return row;
}

/** Ordered and received value of a PO in cents. */
export function poValues(db: Db, poId: string): { ordered_cents: number; received_cents: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_ordered * unit_cost_cents), 0) AS ordered,
              COALESCE(SUM(qty_received * unit_cost_cents), 0) AS received
       FROM po_line_items WHERE po_id = ?`,
    )
    .get(poId) as { ordered: number; received: number };
  return { ordered_cents: row.ordered, received_cents: row.received };
}

/** Σ amount of invoices on the PO that consume received value, optionally excluding one invoice. */
export function consumedCents(db: Db, poId: string, excludeInvoiceId = ''): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM invoices
       WHERE po_id = ? AND id != ? AND status IN (${CONSUMING_PLACEHOLDERS})`,
    )
    .get(poId, excludeInvoiceId, ...MATCH_CONSUMING_STATUSES) as { total: number };
  return row.total;
}

function receiptStatus(line: PoLineItemRow): ReceiptStatus {
  if (line.qty_received === 0) return 'NOT_RECEIVED';
  return line.qty_received < line.qty_ordered ? 'PARTIAL' : 'FULL';
}

function lineView(line: PoLineItemRow): PoLineView {
  return {
    id: line.id,
    sku: line.sku,
    description: line.description,
    qty_ordered: line.qty_ordered,
    qty_received: line.qty_received,
    qty_outstanding: line.qty_ordered - line.qty_received,
    unit_cost_cents: line.unit_cost_cents,
    line_total_cents: line.qty_ordered * line.unit_cost_cents,
    received_value_cents: line.qty_received * line.unit_cost_cents,
    receipt_status: receiptStatus(line),
  };
}

export function loadPurchaseOrderView(db: Db, id: string): PurchaseOrderView {
  const po = requirePurchaseOrder(db, id);
  const vendor = db.prepare('SELECT name FROM vendors WHERE id = ?').get(po.vendor_id) as { name: string };
  const lines = db
    .prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY rowid')
    .all(id) as unknown as PoLineItemRow[];
  const invoices = db
    .prepare('SELECT id, invoice_number, amount_cents, status FROM invoices WHERE po_id = ? ORDER BY rowid')
    .all(id) as unknown as PoInvoiceSummary[];
  const { ordered_cents, received_cents } = poValues(db, id);
  const matched_cents = consumedCents(db, id);

  return {
    id: po.id,
    vendor_id: po.vendor_id,
    vendor_name: vendor.name,
    status: po.status,
    created_at: po.created_at,
    submitted_at: po.submitted_at,
    line_items: lines.map(lineView),
    totals: {
      ordered_cents,
      received_cents,
      matched_cents,
      available_to_match_cents: received_cents - matched_cents,
    },
    receipts: listReceipts(db, id),
    invoices,
  };
}

export function listPurchaseOrders(db: Db): PurchaseOrderView[] {
  const ids = db.prepare('SELECT id FROM purchase_orders ORDER BY rowid').all() as unknown as { id: string }[];
  return ids.map(({ id }) => loadPurchaseOrderView(db, id));
}

export function getPurchaseOrder(db: Db, id: string): PurchaseOrderView {
  return loadPurchaseOrderView(db, id);
}

export function createPurchaseOrder(db: Db, input: CreatePurchaseOrderInput): PurchaseOrderView {
  return transaction(db, () => {
    requireActiveVendor(db, input.vendor_id);
    const catalog = loadCatalog(db, input.line_items.map((l) => l.sku));
    const unknown = input.line_items.map((l) => l.sku).filter((sku) => !catalog.has(sku));
    if (unknown.length > 0) {
      throw new AppError('UNKNOWN_SKU', `Unknown SKU(s): ${unknown.join(', ')}.`, { details: { skus: unknown } });
    }

    const poId = `po_${randomUUID()}`;
    db.prepare('INSERT INTO purchase_orders (id, vendor_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      poId,
      input.vendor_id,
      'DRAFT',
      new Date().toISOString(),
    );
    const insertLine = db.prepare(
      `INSERT INTO po_line_items (id, po_id, sku, description, qty_ordered, unit_cost_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const line of input.line_items) {
      const description = line.description ?? catalog.get(line.sku)!.description;
      insertLine.run(`pol_${randomUUID()}`, poId, line.sku, description, line.qty, line.unit_cost);
    }
    return loadPurchaseOrderView(db, poId);
  });
}

function loadCatalog(db: Db, skus: string[]): Map<string, SkuRow> {
  const stmt = db.prepare('SELECT * FROM skus WHERE sku = ?');
  const found = new Map<string, SkuRow>();
  for (const sku of skus) {
    const row = stmt.get(sku) as unknown as SkuRow | undefined;
    if (row) found.set(sku, row);
  }
  return found;
}

export function submitPurchaseOrder(db: Db, id: string): PurchaseOrderView {
  return transaction(db, () => {
    const po = requirePurchaseOrder(db, id);
    if (!SUBMIT_ALLOWED_FROM.includes(po.status)) {
      throw invalidTransition(ENTITY, id, 'submit', po.status, SUBMIT_ALLOWED_FROM);
    }
    db.prepare('UPDATE purchase_orders SET status = ?, submitted_at = ? WHERE id = ?').run(
      'SUBMITTED',
      new Date().toISOString(),
      id,
    );
    return loadPurchaseOrderView(db, id);
  });
}

export function receiveGoods(db: Db, id: string, input: ReceiveGoodsInput): PurchaseOrderView {
  return transaction(db, () => {
    const po = requirePurchaseOrder(db, id);
    if (!RECEIVE_ALLOWED_FROM.includes(po.status)) {
      throw invalidTransition(ENTITY, id, 'receive', po.status, RECEIVE_ALLOWED_FROM);
    }
    recordReceipt(db, id, input);
    return loadPurchaseOrderView(db, id);
  });
}
