import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection';
import { AP_CONTROL_ACCOUNT, EXPENSE_ACCOUNT_BY_CATEGORY } from '../domain/accounts';
import type { GlEntryRow, VendorCategory } from '../domain/types';
import type { GlEntryView } from '../domain/views';
import { getCorrelationId } from '../context';

/** Post the balanced pair for an approved invoice: debit expense, credit AP control. */
export function postInvoiceApproval(
  db: Db,
  invoiceId: string,
  category: VendorCategory,
  amountCents: number,
  postedAt: string,
): void {
  const insert = db.prepare(
    `INSERT INTO gl_entries (id, invoice_id, account_code, debit_cents, credit_cents, posted_at, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const correlationId = getCorrelationId();
  insert.run(`gl_${randomUUID()}`, invoiceId, EXPENSE_ACCOUNT_BY_CATEGORY[category], amountCents, 0, postedAt, correlationId);
  insert.run(`gl_${randomUUID()}`, invoiceId, AP_CONTROL_ACCOUNT, 0, amountCents, postedAt, correlationId);
}

export function listGlEntries(db: Db, invoiceId: string): GlEntryView[] {
  const rows = db
    .prepare('SELECT * FROM gl_entries WHERE invoice_id = ? ORDER BY rowid')
    .all(invoiceId) as unknown as GlEntryRow[];
  return rows.map(({ id, account_code, debit_cents, credit_cents, posted_at, correlation_id }) => ({
    id,
    account_code,
    debit_cents,
    credit_cents,
    posted_at,
    correlation_id,
  }));
}

export function glTotals(db: Db): { total_debit_cents: number; total_credit_cents: number; balanced: boolean } {
  const row = db
    .prepare('SELECT COALESCE(SUM(debit_cents), 0) AS d, COALESCE(SUM(credit_cents), 0) AS c FROM gl_entries')
    .get() as { d: number; c: number };
  return { total_debit_cents: row.d, total_credit_cents: row.c, balanced: row.d === row.c };
}
