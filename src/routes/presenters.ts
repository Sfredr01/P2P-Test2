import { invoiceNextActions, poNextActions, type NextAction } from '../domain/stateMachines';
import type { DebugStateView, GlEntryView, InvoiceView, PurchaseOrderView, SkuView, VendorView, Warning } from '../domain/views';
import type { MatchResult } from '../domain/types';
import { fromCents } from '../money';

// The only output-side money conversion: cents in, decimal strings out, no `_cents` keys.

export interface Envelope<T> {
  data: T;
  warnings?: Warning[];
  next_actions: NextAction[];
}

export function single<T>(data: T, nextActions: NextAction[], warnings: Warning[] = []): Envelope<T> {
  return { data, ...(warnings.length > 0 ? { warnings } : {}), next_actions: nextActions };
}

export function list<T>(data: T[]): { data: T[] } {
  return { data };
}

export const presentVendor = (v: VendorView) => ({ ...v });

export const presentSku = ({ default_unit_cost_cents, ...rest }: SkuView) => ({
  ...rest,
  default_unit_cost: fromCents(default_unit_cost_cents),
});

export function presentPurchaseOrder(po: PurchaseOrderView) {
  return {
    id: po.id,
    vendor_id: po.vendor_id,
    vendor_name: po.vendor_name,
    status: po.status,
    created_at: po.created_at,
    submitted_at: po.submitted_at,
    line_items: po.line_items.map((l) => ({
      id: l.id,
      sku: l.sku,
      description: l.description,
      qty_ordered: l.qty_ordered,
      qty_received: l.qty_received,
      qty_outstanding: l.qty_outstanding,
      unit_cost: fromCents(l.unit_cost_cents),
      line_total: fromCents(l.line_total_cents),
      received_value: fromCents(l.received_value_cents),
      receipt_status: l.receipt_status,
    })),
    totals: {
      ordered: fromCents(po.totals.ordered_cents),
      received: fromCents(po.totals.received_cents),
      matched: fromCents(po.totals.matched_cents),
      available_to_match: fromCents(po.totals.available_to_match_cents),
    },
    receipts: po.receipts,
    invoices: po.invoices.map((i) => ({
      id: i.id,
      invoice_number: i.invoice_number,
      amount: fromCents(i.amount_cents),
      status: i.status,
    })),
  };
}

function presentMatchResult(r: MatchResult) {
  return {
    outcome: r.outcome,
    reason: r.reason,
    invoice_amount: fromCents(r.invoice_amount_cents),
    ordered_value: fromCents(r.ordered_value_cents),
    received_value: fromCents(r.received_value_cents),
    already_matched: fromCents(r.already_matched_cents),
    available_to_match: fromCents(r.available_to_match_cents),
    partial_receipt_pending: r.partial_receipt_pending,
    evaluated_at: r.evaluated_at,
  };
}

const presentGlEntry = (e: GlEntryView) => ({
  id: e.id,
  account_code: e.account_code,
  debit: fromCents(e.debit_cents),
  credit: fromCents(e.credit_cents),
  posted_at: e.posted_at,
  correlation_id: e.correlation_id,
});

export function presentInvoice(inv: InvoiceView) {
  return {
    id: inv.id,
    vendor_id: inv.vendor_id,
    po_id: inv.po_id,
    invoice_number: inv.invoice_number,
    amount: fromCents(inv.amount_cents),
    status: inv.status,
    created_at: inv.created_at,
    matched_at: inv.matched_at,
    approved_at: inv.approved_at,
    last_match_result: inv.last_match_result ? presentMatchResult(inv.last_match_result) : null,
    gl_entries: inv.gl_entries.map(presentGlEntry),
  };
}

export const poEnvelope = (po: PurchaseOrderView) => single(presentPurchaseOrder(po), poNextActions(po.id, po.status));

export const invoiceEnvelope = (inv: InvoiceView, warnings: Warning[] = []) =>
  single(presentInvoice(inv), invoiceNextActions(inv.id, inv.status), warnings);

export function presentDebugState(state: DebugStateView) {
  return {
    vendors: state.vendors.map(presentVendor),
    skus: state.skus.map(presentSku),
    purchase_orders: state.purchase_orders.map(presentPurchaseOrder),
    invoices: state.invoices.map(presentInvoice),
    gl_summary: {
      total_debit: fromCents(state.gl_summary.total_debit_cents),
      total_credit: fromCents(state.gl_summary.total_credit_cents),
      balanced: state.gl_summary.balanced,
    },
  };
}
