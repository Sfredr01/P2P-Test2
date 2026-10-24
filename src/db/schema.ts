// DDL. Money columns are INTEGER cents. CHECK constraints are a backstop for the invariants
// the services enforce (e.g. never receive more than ordered, GL lines are one-sided).

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vendors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  payment_terms TEXT NOT NULL CHECK (payment_terms IN ('NET30', 'NET60')),
  category      TEXT NOT NULL CHECK (category IN ('LUMBER', 'HARDWARE', 'GENERAL')),
  is_active     INTEGER NOT NULL CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS skus (
  sku                     TEXT PRIMARY KEY,
  description             TEXT NOT NULL,
  category                TEXT NOT NULL CHECK (category IN ('LUMBER', 'HARDWARE', 'GENERAL')),
  default_unit_cost_cents INTEGER NOT NULL CHECK (default_unit_cost_cents >= 0)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           TEXT PRIMARY KEY,
  vendor_id    TEXT NOT NULL REFERENCES vendors(id),
  status       TEXT NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')),
  created_at   TEXT NOT NULL,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS po_line_items (
  id              TEXT PRIMARY KEY,
  po_id           TEXT NOT NULL REFERENCES purchase_orders(id),
  sku             TEXT NOT NULL REFERENCES skus(sku),
  description     TEXT NOT NULL,
  qty_ordered     INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received    INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  UNIQUE (po_id, sku)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id             TEXT PRIMARY KEY,
  po_id          TEXT NOT NULL REFERENCES purchase_orders(id),
  received_by    TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id           TEXT PRIMARY KEY,
  receipt_id   TEXT NOT NULL REFERENCES goods_receipts(id),
  line_item_id TEXT NOT NULL REFERENCES po_line_items(id),
  qty          INTEGER NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  vendor_id         TEXT NOT NULL REFERENCES vendors(id),
  po_id             TEXT NOT NULL REFERENCES purchase_orders(id),
  invoice_number    TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  status            TEXT NOT NULL CHECK (status IN ('PENDING', 'MATCHED', 'APPROVED', 'PAID')),
  created_at        TEXT NOT NULL,
  matched_at        TEXT,
  approved_at       TEXT,
  last_match_result TEXT,
  UNIQUE (vendor_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS gl_entries (
  id             TEXT PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES invoices(id),
  account_code   TEXT NOT NULL,
  debit_cents    INTEGER NOT NULL CHECK (debit_cents >= 0),
  credit_cents   INTEGER NOT NULL CHECK (credit_cents >= 0),
  posted_at      TEXT NOT NULL,
  correlation_id TEXT,
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (key, method, path)
);

CREATE INDEX IF NOT EXISTS idx_po_line_items_po ON po_line_items(po_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts(po_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices(po_id);
CREATE INDEX IF NOT EXISTS idx_gl_entries_invoice ON gl_entries(invoice_id);
`;

/** Drop order respects foreign keys. Used by reset/reseed. */
export const TABLES_IN_DROP_ORDER = [
  'gl_entries',
  'invoices',
  'goods_receipt_lines',
  'goods_receipts',
  'po_line_items',
  'purchase_orders',
  'skus',
  'vendors',
  'idempotency_keys',
] as const;
