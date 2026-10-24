// DB row shapes. All money fields are integer cents (suffix _cents). Never exposed directly:
// routes map rows to API shapes (decimal strings) — see docs/api-contract.md.

export const PAYMENT_TERMS = ['NET30', 'NET60'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

export const VENDOR_CATEGORIES = ['LUMBER', 'HARDWARE', 'GENERAL'] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export const PO_STATUSES = ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const INVOICE_STATUSES = ['PENDING', 'MATCHED', 'APPROVED', 'PAID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Invoice statuses whose amount counts against a PO's received value in the cumulative 3-way match. */
export const MATCH_CONSUMING_STATUSES = ['MATCHED', 'APPROVED', 'PAID'] as const satisfies readonly InvoiceStatus[];

export interface VendorRow {
  id: string;
  name: string;
  payment_terms: PaymentTerms;
  category: VendorCategory;
  is_active: 0 | 1;
}

export interface SkuRow {
  sku: string;
  description: string;
  category: VendorCategory;
  default_unit_cost_cents: number;
}

export interface PurchaseOrderRow {
  id: string;
  vendor_id: string;
  status: PoStatus;
  created_at: string;
  submitted_at: string | null;
}

export interface PoLineItemRow {
  id: string;
  po_id: string;
  sku: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number;
}

export interface GoodsReceiptRow {
  id: string;
  po_id: string;
  received_by: string;
  received_at: string;
  correlation_id: string | null;
}

export interface GoodsReceiptLineRow {
  id: string;
  receipt_id: string;
  line_item_id: string;
  qty: number;
}

export interface InvoiceRow {
  id: string;
  vendor_id: string;
  po_id: string;
  invoice_number: string;
  amount_cents: number;
  status: InvoiceStatus;
  created_at: string;
  matched_at: string | null;
  approved_at: string | null;
  /** JSON-encoded MatchResult, null until the first match attempt. */
  last_match_result: string | null;
}

export interface GlEntryRow {
  id: string;
  invoice_id: string;
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  posted_at: string;
  correlation_id: string | null;
}

/** Outcome of a 3-way match attempt, all values in cents. Stored on the invoice as JSON. */
export interface MatchResult {
  outcome: 'MATCHED' | 'REJECTED';
  reason: 'OK' | 'INVOICE_EXCEEDS_RECEIVED_VALUE' | 'NOTHING_RECEIVED';
  invoice_amount_cents: number;
  ordered_value_cents: number;
  received_value_cents: number;
  /** Sum of other MATCHED/APPROVED/PAID invoices on the same PO. */
  already_matched_cents: number;
  /** received_value - already_matched (before this invoice). */
  available_to_match_cents: number;
  partial_receipt_pending: boolean;
  evaluated_at: string;
}
