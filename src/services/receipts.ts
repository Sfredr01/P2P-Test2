import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection';
import { transaction } from '../db/connection';
import { getCorrelationId } from '../context';
import type { ReceiveGoodsInput } from '../domain/schemas';
import type { PoLineItemRow, PoStatus } from '../domain/types';
import type { ReceiptView } from '../domain/views';
import { AppError, notFound } from '../errors';

/** Record one goods receipt atomically; returns the PO's new status. All-or-nothing on over-receipt. */
export function recordReceipt(db: Db, poId: string, input: ReceiveGoodsInput): PoStatus {
  return transaction(db, () => {
    const lines = db.prepare('SELECT * FROM po_line_items WHERE po_id = ?').all(poId) as unknown as PoLineItemRow[];
    const byId = new Map(lines.map((line) => [line.id, line]));

    for (const item of input.line_items) {
      if (!byId.has(item.line_item_id)) throw notFound('line_item', item.line_item_id);
    }
    assertNoOverReceipt(input, byId);

    const now = new Date().toISOString();
    const receiptId = `gr_${randomUUID()}`;
    db.prepare('INSERT INTO goods_receipts (id, po_id, received_by, received_at, correlation_id) VALUES (?, ?, ?, ?, ?)').run(
      receiptId,
      poId,
      input.received_by,
      now,
      getCorrelationId(),
    );
    const insertLine = db.prepare(
      'INSERT INTO goods_receipt_lines (id, receipt_id, line_item_id, qty) VALUES (?, ?, ?, ?)',
    );
    const bump = db.prepare('UPDATE po_line_items SET qty_received = qty_received + ? WHERE id = ?');
    for (const item of input.line_items) {
      insertLine.run(`grl_${randomUUID()}`, receiptId, item.line_item_id, item.qty);
      bump.run(item.qty, item.line_item_id);
    }

    const open = db
      .prepare('SELECT COUNT(*) AS n FROM po_line_items WHERE po_id = ? AND qty_received < qty_ordered')
      .get(poId) as { n: number };
    const status: PoStatus = open.n === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, poId);
    return status;
  });
}

function assertNoOverReceipt(input: ReceiveGoodsInput, byId: Map<string, PoLineItemRow>): void {
  const offending = input.line_items.flatMap((item) => {
    const line = byId.get(item.line_item_id)!;
    const outstanding = line.qty_ordered - line.qty_received;
    return item.qty > outstanding
      ? [{ line_item_id: line.id, sku: line.sku, qty_requested: item.qty, qty_outstanding: outstanding }]
      : [];
  });
  if (offending.length === 0) return;
  throw new AppError(
    'OVER_RECEIPT',
    `Receipt exceeds outstanding quantity on ${offending.length} line(s): ${offending
      .map((l) => `${l.sku} requested ${l.qty_requested}, outstanding ${l.qty_outstanding}`)
      .join('; ')}.`,
    { details: { lines: offending } },
  );
}

export function listReceipts(db: Db, poId: string): ReceiptView[] {
  const receipts = db
    .prepare('SELECT id, received_by, received_at FROM goods_receipts WHERE po_id = ? ORDER BY rowid')
    .all(poId) as unknown as { id: string; received_by: string; received_at: string }[];
  const linesStmt = db.prepare(
    `SELECT l.line_item_id, p.sku, l.qty FROM goods_receipt_lines l
     JOIN po_line_items p ON p.id = l.line_item_id WHERE l.receipt_id = ? ORDER BY l.rowid`,
  );
  return receipts.map((r) => ({
    ...r,
    line_items: linesStmt.all(r.id) as unknown as ReceiptView['line_items'],
  }));
}
