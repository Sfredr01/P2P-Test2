import type { InvoiceStatus, MatchResult, PaymentTerms, PoStatus, VendorCategory } from './types';

// Internal read models. Money is integer cents; routes/presenters.ts is the only place that
// turns these into the decimal-string API shapes.

export interface VendorView {
  id: string;
  name: string;
  payment_terms: PaymentTerms;
  category: VendorCategory;
  is_active: boolean;
}

export interface SkuView {
  sku: string;
  description: string;
  category: VendorCategory;
  default_unit_cost_cents: number;
}

export type ReceiptStatus = 'NOT_RECEIVED' | 'PARTIAL' | 'FULL';

export interface PoLineView {
  id: string;
  sku: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  qty_outstanding: number;
  unit_cost_cents: number;
  line_total_cents: number;
  received_value_cents: number;
  receipt_status: ReceiptStatus;
}

export interface ReceiptView {
  id: string;
  received_by: string;
  received_at: string;
  line_items: { line_item_id: string; sku: string; qty: number }[];
}

export interface PoInvoiceSummary {
  id: string;
  invoice_number: string;
  amount_cents: number;
  status: InvoiceStatus;
}

export interface PurchaseOrderView {
  id: string;
  vendor_id: string;
  vendor_name: string;
  status: PoStatus;
  created_at: string;
  submitted_at: string | null;
  line_items: PoLineView[];
  totals: {
    ordered_cents: number;
    received_cents: number;
    matched_cents: number;
    available_to_match_cents: number;
  };
  receipts: ReceiptView[];
  invoices: PoInvoiceSummary[];
}

export interface GlEntryView {
  id: string;
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  posted_at: string;
  correlation_id: string | null;
}

export interface InvoiceView {
  id: string;
  vendor_id: string;
  po_id: string;
  invoice_number: string;
  amount_cents: number;
  status: InvoiceStatus;
  created_at: string;
  matched_at: string | null;
  approved_at: string | null;
  last_match_result: MatchResult | null;
  gl_entries: GlEntryView[];
}

export interface Warning {
  code: string;
  description: string;
  next_steps: string;
}

/** A service result plus any non-fatal warnings for the response envelope. */
export interface WithWarnings<T> {
  view: T;
  warnings: Warning[];
}

export interface DebugStateView {
  vendors: VendorView[];
  skus: SkuView[];
  purchase_orders: PurchaseOrderView[];
  invoices: InvoiceView[];
  gl_summary: { total_debit_cents: number; total_credit_cents: number; balanced: boolean };
}
