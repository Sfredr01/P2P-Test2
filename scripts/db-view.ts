// Read-only DB inspector for debugging and live walkthroughs.
// Usage: npm run db:view [table]
// Exit codes: 0 ok, 1 bad usage or no database file, 2 GL is unbalanced.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config';
import type { MatchResult } from '../src/domain/types';
import { fromCents } from '../src/money';

const TABLE_NAMES = [
  'vendors',
  'skus',
  'purchase_orders',
  'po_line_items',
  'goods_receipts',
  'invoices',
  'gl_entries',
  'idempotency_keys',
] as const;

type TableName = (typeof TABLE_NAMES)[number];
type Row = Record<string, unknown>;

function isTableName(name: string): name is TableName {
  return (TABLE_NAMES as readonly string[]).includes(name);
}

function query<T>(db: DatabaseSync, sql: string): T[] {
  // node:sqlite returns plain objects keyed by column name; each caller names the shape it selects.
  return db.prepare(sql).all() as unknown as T[];
}

/** Turns the stored MatchResult JSON into printable outcome/reason. Never throws. */
function describeMatch(raw: string | null): { match_outcome: string; match_reason: string } {
  if (raw === null) return { match_outcome: '-', match_reason: '-' };
  try {
    const result = JSON.parse(raw) as Partial<MatchResult>;
    return { match_outcome: result.outcome ?? '?', match_reason: result.reason ?? '?' };
  } catch {
    return { match_outcome: 'INVALID_JSON', match_reason: '-' };
  }
}

function buildViewers(db: DatabaseSync): Record<TableName, () => Row[]> {
  return {
    vendors: () =>
      query<{ id: string; name: string; payment_terms: string; category: string; is_active: number }>(
        db,
        'SELECT id, name, payment_terms, category, is_active FROM vendors ORDER BY id',
      ).map((v) => ({
        id: v.id,
        name: v.name,
        payment_terms: v.payment_terms,
        category: v.category,
        is_active: v.is_active === 1,
      })),

    skus: () =>
      query<{ sku: string; description: string; category: string; default_unit_cost_cents: number }>(
        db,
        'SELECT sku, description, category, default_unit_cost_cents FROM skus ORDER BY sku',
      ).map((s) => ({
        sku: s.sku,
        description: s.description,
        category: s.category,
        default_unit_cost: fromCents(s.default_unit_cost_cents),
      })),

    purchase_orders: () =>
      query<{
        id: string;
        vendor_id: string;
        status: string;
        created_at: string;
        submitted_at: string | null;
        qty_ordered: number;
        qty_received: number;
        ordered_cents: number;
        received_cents: number;
      }>(
        db,
        `SELECT po.id, po.vendor_id, po.status, po.created_at, po.submitted_at,
                COALESCE(SUM(l.qty_ordered), 0) AS qty_ordered,
                COALESCE(SUM(l.qty_received), 0) AS qty_received,
                COALESCE(SUM(l.qty_ordered * l.unit_cost_cents), 0) AS ordered_cents,
                COALESCE(SUM(l.qty_received * l.unit_cost_cents), 0) AS received_cents
           FROM purchase_orders po
           LEFT JOIN po_line_items l ON l.po_id = po.id
          GROUP BY po.id
          ORDER BY po.created_at`,
      ).map((p) => ({
        id: p.id,
        vendor_id: p.vendor_id,
        status: p.status,
        qty_ordered: p.qty_ordered,
        qty_received: p.qty_received,
        ordered: fromCents(p.ordered_cents),
        received: fromCents(p.received_cents),
        submitted_at: p.submitted_at ?? '-',
      })),

    po_line_items: () =>
      query<{
        id: string;
        po_id: string;
        sku: string;
        qty_ordered: number;
        qty_received: number;
        unit_cost_cents: number;
      }>(
        db,
        'SELECT id, po_id, sku, qty_ordered, qty_received, unit_cost_cents FROM po_line_items ORDER BY po_id, sku',
      ).map((l) => ({
        id: l.id,
        po_id: l.po_id,
        sku: l.sku,
        qty_ordered: l.qty_ordered,
        qty_received: l.qty_received,
        qty_outstanding: l.qty_ordered - l.qty_received,
        unit_cost: fromCents(l.unit_cost_cents),
        line_total: fromCents(l.qty_ordered * l.unit_cost_cents),
      })),

    goods_receipts: () =>
      query<{
        id: string;
        po_id: string;
        received_by: string;
        received_at: string;
        correlation_id: string | null;
        line_count: number;
        total_qty: number;
      }>(
        db,
        `SELECT g.id, g.po_id, g.received_by, g.received_at, g.correlation_id,
                COUNT(gl.id) AS line_count,
                COALESCE(SUM(gl.qty), 0) AS total_qty
           FROM goods_receipts g
           LEFT JOIN goods_receipt_lines gl ON gl.receipt_id = g.id
          GROUP BY g.id
          ORDER BY g.received_at`,
      ).map((g) => ({
        id: g.id,
        po_id: g.po_id,
        received_by: g.received_by,
        received_at: g.received_at,
        line_count: g.line_count,
        total_qty: g.total_qty,
        correlation_id: g.correlation_id ?? '-',
      })),

    invoices: () =>
      query<{
        id: string;
        invoice_number: string;
        vendor_id: string;
        po_id: string;
        amount_cents: number;
        status: string;
        matched_at: string | null;
        last_match_result: string | null;
      }>(
        db,
        `SELECT id, invoice_number, vendor_id, po_id, amount_cents, status, matched_at, last_match_result
           FROM invoices
          ORDER BY created_at`,
      ).map((i) => ({
        id: i.id,
        invoice_number: i.invoice_number,
        vendor_id: i.vendor_id,
        po_id: i.po_id,
        amount: fromCents(i.amount_cents),
        status: i.status,
        ...describeMatch(i.last_match_result),
        matched_at: i.matched_at ?? '-',
      })),

    gl_entries: () =>
      query<{
        id: string;
        invoice_id: string;
        account_code: string;
        debit_cents: number;
        credit_cents: number;
        posted_at: string;
        correlation_id: string | null;
      }>(
        db,
        'SELECT id, invoice_id, account_code, debit_cents, credit_cents, posted_at, correlation_id FROM gl_entries ORDER BY posted_at, id',
      ).map((e) => ({
        id: e.id,
        invoice_id: e.invoice_id,
        account_code: e.account_code,
        debit: fromCents(e.debit_cents),
        credit: fromCents(e.credit_cents),
        posted_at: e.posted_at,
        correlation_id: e.correlation_id ?? '-',
      })),

    idempotency_keys: () =>
      query<{ key: string; method: string; path: string; response_status: number; created_at: string }>(
        db,
        'SELECT key, method, path, response_status, created_at FROM idempotency_keys ORDER BY created_at',
      ).map((k) => ({
        key: k.key,
        method: k.method,
        path: k.path,
        response_status: k.response_status,
        created_at: k.created_at,
      })),
  };
}

/** Prints the GL balance line. Returns true when total debits equal total credits. */
function printGlBalance(db: DatabaseSync): boolean {
  const totals = query<{ debits: number; credits: number }>(
    db,
    'SELECT COALESCE(SUM(debit_cents), 0) AS debits, COALESCE(SUM(credit_cents), 0) AS credits FROM gl_entries',
  )[0] ?? { debits: 0, credits: 0 };
  const balanced = totals.debits === totals.credits;
  const difference = fromCents(Math.abs(totals.debits - totals.credits));
  console.log(
    `\nGL balance: total debits ${fromCents(totals.debits)}, total credits ${fromCents(totals.credits)} -> ` +
      (balanced ? 'BALANCED' : `UNBALANCED (difference ${difference})`),
  );
  return balanced;
}

function main(): number {
  const requested = process.argv[2];
  let tables: readonly TableName[] = TABLE_NAMES;
  if (requested !== undefined) {
    if (!isTableName(requested)) {
      console.error(`Unknown table "${requested}". Valid tables: ${TABLE_NAMES.join(', ')}`);
      return 1;
    }
    tables = [requested];
  }

  const dbPath = config.dbPath;
  // Never create the file: a viewer that writes an empty DB would hide a missing seed.
  if (!existsSync(dbPath)) {
    console.error(
      `No database at ${resolve(dbPath)}. Run "npm run db:seed" or start the server to create it.`,
    );
    return 1;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const viewers = buildViewers(db);
    for (const name of tables) {
      const rows = viewers[name]();
      console.log(`\n== ${name} (${rows.length}) ==`);
      if (rows.length === 0) console.log('(no rows)');
      else console.table(rows);
    }
    return printGlBalance(db) ? 0 : 2;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
