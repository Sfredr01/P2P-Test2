import { z } from 'zod';
import { toCents } from '../money';

// Request schemas. Money arrives as a decimal string ("12.50") and leaves this module as
// integer cents — services never see strings. This is the only input-side money conversion.

const MAX_CENTS = 100_000_000_00; // $100M per amount: generous ceiling that keeps sums far from MAX_SAFE_INTEGER

const money = (field: string) =>
  z
    .string({ error: `${field} must be a decimal string like "12.50"` })
    .regex(/^\d+(\.\d{1,2})?$/, `${field} must be a decimal string with at most 2 decimal places, like "12.50"`)
    .transform(toCents)
    .refine((cents) => cents <= MAX_CENTS, `${field} must be at most 100000000.00`);

const id = (field: string) => z.string({ error: `${field} is required` }).trim().min(1, `${field} is required`);

const quantity = (field: string) =>
  z.number({ error: `${field} must be a number` }).int(`${field} must be a whole number`).positive(`${field} must be greater than 0`);

export const createPurchaseOrderSchema = z.object({
  vendor_id: id('vendor_id'),
  line_items: z
    .array(
      z.object({
        sku: id('sku'),
        qty: quantity('qty'),
        unit_cost: money('unit_cost'),
        description: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1, 'line_items must contain at least one line')
    .refine(
      (lines) => new Set(lines.map((line) => line.sku)).size === lines.length,
      'Each sku may appear only once per purchase order; combine quantities into one line',
    ),
});
export type CreatePurchaseOrderInput = z.output<typeof createPurchaseOrderSchema>;

export const receiveGoodsSchema = z.object({
  received_by: id('received_by').pipe(z.string().max(200)),
  line_items: z
    .array(z.object({ line_item_id: id('line_item_id'), qty: quantity('qty') }))
    .min(1, 'line_items must contain at least one line')
    .refine(
      (lines) => new Set(lines.map((line) => line.line_item_id)).size === lines.length,
      'Each line_item_id may appear only once per receipt',
    ),
});
export type ReceiveGoodsInput = z.output<typeof receiveGoodsSchema>;

export const createInvoiceSchema = z.object({
  vendor_id: id('vendor_id'),
  po_id: id('po_id'),
  invoice_number: id('invoice_number').pipe(z.string().max(100)),
  amount: money('amount').refine((cents) => cents > 0, 'amount must be greater than 0.00'),
});
export type CreateInvoiceInput = z.output<typeof createInvoiceSchema>;

/** Action endpoints (submit, match, approve) take no fields; an empty or missing body is fine. */
export const emptyActionSchema = z.object({}).strict();
