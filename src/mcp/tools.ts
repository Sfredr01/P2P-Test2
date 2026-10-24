import { z } from 'zod';

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  method: 'GET' | 'POST';
  path: (args: ToolArgs) => string;
  /** Keys consumed by the path (or the MCP layer) that must not be forwarded in the body. */
  nonBodyKeys: string[];
}

const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe(
    'Optional. Reuse the SAME key when retrying this exact call after a timeout or network error so it is not applied twice. Omit for a new action; one is generated and returned in the result.',
  );

const money = (what: string) =>
  z.string().describe(`${what} as a decimal string with up to 2 decimals, e.g. "12.50". Never a JSON number.`);

const id = (label: string, example: string) => z.string().min(1).describe(`${label}, e.g. "${example}".`);

const encode = (value: unknown) => encodeURIComponent(String(value));

const NEXT = 'Afterwards follow `next_actions` in the result: each `action` is the name of the tool to call next.';
const ERRS = 'On error (isError true) read `error.next_steps` and `error.details`, fix the input or state, then retry.';

export const TOOLS: ToolDef[] = [
  {
    name: 'list_vendors',
    title: 'List vendors',
    description:
      'List all vendors. Call this first to find a valid vendor_id for create_purchase_order or create_invoice. Only vendors with is_active=true can receive new purchase orders or invoices; inactive ones are rejected with VENDOR_INACTIVE.',
    inputSchema: {},
    method: 'GET',
    path: () => '/vendors',
    nonBodyKeys: [],
  },
  {
    name: 'list_skus',
    title: 'List SKUs',
    description:
      'List the catalog of SKUs. Call this before create_purchase_order to get valid `sku` codes and their usual unit costs for line items.',
    inputSchema: {},
    method: 'GET',
    path: () => '/skus',
    nonBodyKeys: [],
  },
  {
    name: 'create_purchase_order',
    title: 'Create purchase order',
    description: `Create a purchase order in DRAFT status for an active vendor (is_active=true). Precondition: vendor_id from list_vendors, sku codes from list_skus. The result includes generated line item ids (needed later by receive_goods). Next step is normally submit_purchase_order. ${NEXT} ${ERRS}`,
    inputSchema: {
      vendor_id: id('Vendor id from list_vendors', 'ven_acme'),
      line_items: z
        .array(
          z.object({
            sku: z.string().min(1).describe('SKU code from list_skus, e.g. "SKU-9234".'),
            qty: z.number().int().positive().describe('Quantity ordered, a positive whole number.'),
            unit_cost: money('Cost per unit'),
            description: z.string().optional().describe('Optional free-text line description.'),
          }),
        )
        .min(1)
        .describe('One or more lines to order.'),
      idempotency_key: idempotencyKey,
    },
    method: 'POST',
    path: () => '/purchase-orders',
    nonBodyKeys: ['idempotency_key'],
  },
  {
    name: 'submit_purchase_order',
    title: 'Submit purchase order',
    description: `Submit a DRAFT purchase order to the vendor, moving it to SUBMITTED. Required before receive_goods. Fails with INVALID_STATE_TRANSITION if the PO is not DRAFT. ${NEXT} ${ERRS}`,
    inputSchema: {
      purchase_order_id: id('Purchase order id from create_purchase_order', 'po_123'),
      idempotency_key: idempotencyKey,
    },
    method: 'POST',
    path: (a) => `/purchase-orders/${encode(a.purchase_order_id)}/submit`,
    nonBodyKeys: ['idempotency_key', 'purchase_order_id'],
  },
  {
    name: 'receive_goods',
    title: 'Receive goods',
    description: `Record a goods receipt against a SUBMITTED or PARTIALLY_RECEIVED purchase order. Partial receipts are allowed and may be repeated; the PO becomes RECEIVED once every line is fully received. qty per line cannot exceed what is still outstanding (OVER_RECEIPT, all-or-nothing). Use the line item ids from the PO. Received value caps what invoices can later be matched. ${NEXT} ${ERRS}`,
    inputSchema: {
      purchase_order_id: id('Purchase order id', 'po_123'),
      received_by: z.string().min(1).describe('Who received the goods, e.g. "dock-1".'),
      line_items: z
        .array(
          z.object({
            line_item_id: z.string().min(1).describe('Id of a line item on this PO (from the PO data).'),
            qty: z.number().int().positive().describe('Quantity received now, a positive whole number.'),
          }),
        )
        .min(1)
        .describe('Lines and quantities received in this delivery.'),
      idempotency_key: idempotencyKey,
    },
    method: 'POST',
    path: (a) => `/purchase-orders/${encode(a.purchase_order_id)}/receive`,
    nonBodyKeys: ['idempotency_key', 'purchase_order_id'],
  },
  {
    name: 'get_purchase_order',
    title: 'Get purchase order',
    description:
      'Fetch a purchase order with its line items, status, money totals (ordered, received, matched) and linked invoices. Use it to check state before acting or to verify the outcome of an earlier call. Follow `next_actions` for valid moves.',
    inputSchema: { purchase_order_id: id('Purchase order id', 'po_123') },
    method: 'GET',
    path: (a) => `/purchase-orders/${encode(a.purchase_order_id)}`,
    nonBodyKeys: ['purchase_order_id'],
  },
  {
    name: 'create_invoice',
    title: 'Create invoice',
    description: `Record a vendor invoice against a purchase order, in PENDING status. Does not require goods to be received yet, but match_invoice will only succeed up to the received value. Next step is match_invoice. ${NEXT} ${ERRS}`,
    inputSchema: {
      vendor_id: id('Vendor id; must be the PO vendor', 'ven_acme'),
      po_id: id('Purchase order id the invoice bills against', 'po_123'),
      invoice_number: z.string().min(1).describe("The vendor's invoice number, e.g. \"INV-1001\"."),
      amount: money('Invoice total'),
      idempotency_key: idempotencyKey,
    },
    method: 'POST',
    path: () => '/invoices',
    nonBodyKeys: ['idempotency_key'],
  },
  {
    name: 'match_invoice',
    title: 'Match invoice (3-way match)',
    description: `Run the 3-way match (PO vs goods received vs invoice) on a PENDING invoice. Success moves it to MATCHED; check \`warnings\` (e.g. PARTIAL_RECEIPT_PENDING) and report them. If the invoice exceeds received value it fails with INVOICE_EXCEEDS_RECEIVED_VALUE and \`error.details.available_to_match\` says what can be matched: receive more goods or correct the invoice, do not retry unchanged. ${NEXT} ${ERRS}`,
    inputSchema: { invoice_id: id('Invoice id from create_invoice', 'inv_123'), idempotency_key: idempotencyKey },
    method: 'POST',
    path: (a) => `/invoices/${encode(a.invoice_id)}/match`,
    nonBodyKeys: ['idempotency_key', 'invoice_id'],
  },
  {
    name: 'approve_invoice',
    title: 'Approve invoice',
    description: `Approve a MATCHED invoice and post its balanced general-ledger entries (expense debit, AP control credit). Fails with INVALID_STATE_TRANSITION unless the invoice is MATCHED. The posted \`gl_entries\` are in the result. ${NEXT} ${ERRS}`,
    inputSchema: { invoice_id: id('Invoice id (must be MATCHED)', 'inv_123'), idempotency_key: idempotencyKey },
    method: 'POST',
    path: (a) => `/invoices/${encode(a.invoice_id)}/approve`,
    nonBodyKeys: ['idempotency_key', 'invoice_id'],
  },
  {
    name: 'get_invoice',
    title: 'Get invoice',
    description:
      'Fetch an invoice with its status, amount and, once approved, its GL entries. Use it to verify state before or after match_invoice / approve_invoice. NOT_FOUND means the id is wrong.',
    inputSchema: { invoice_id: id('Invoice id', 'inv_123') },
    method: 'GET',
    path: (a) => `/invoices/${encode(a.invoice_id)}`,
    nonBodyKeys: ['invoice_id'],
  },
  {
    name: 'debug_get_state',
    title: 'Debug: get full state',
    description:
      'Diagnostics only. Return a snapshot of all stored records plus a GL summary (including whether debits equal credits). Use it to verify end results or investigate unexpected behavior, not as part of the normal workflow.',
    inputSchema: {},
    method: 'GET',
    path: () => '/debug/state',
    nonBodyKeys: [],
  },
];
