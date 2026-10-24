import type { InvoiceStatus, PoStatus } from './types';

// Allowed-from lists feed invalidTransition(); next-action lists feed response envelopes.
// Action names equal the MCP tool names.

export const SUBMIT_ALLOWED_FROM: readonly PoStatus[] = ['DRAFT'];
export const RECEIVE_ALLOWED_FROM: readonly PoStatus[] = ['SUBMITTED', 'PARTIALLY_RECEIVED'];
export const INVOICE_ALLOWED_FROM: readonly PoStatus[] = ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED'];
export const MATCH_ALLOWED_FROM: readonly InvoiceStatus[] = ['PENDING'];
export const APPROVE_ALLOWED_FROM: readonly InvoiceStatus[] = ['MATCHED'];

export interface NextAction {
  action: string;
  method: 'POST';
  path: string;
  description: string;
}

const submit = (id: string): NextAction => ({
  action: 'submit_purchase_order',
  method: 'POST',
  path: `/purchase-orders/${id}/submit`,
  description: 'Submit this draft purchase order to the vendor.',
});

const receive = (id: string): NextAction => ({
  action: 'receive_goods',
  method: 'POST',
  path: `/purchase-orders/${id}/receive`,
  description: 'Record goods received against this purchase order.',
});

const createInvoice: NextAction = {
  action: 'create_invoice',
  method: 'POST',
  path: '/invoices',
  description: 'Record a vendor invoice against this purchase order.',
};

export function poNextActions(id: string, status: PoStatus): NextAction[] {
  switch (status) {
    case 'DRAFT':
      return [submit(id)];
    case 'SUBMITTED':
    case 'PARTIALLY_RECEIVED':
      return [receive(id), createInvoice];
    case 'RECEIVED':
      return [createInvoice];
    default:
      return [];
  }
}

export function invoiceNextActions(id: string, status: InvoiceStatus): NextAction[] {
  switch (status) {
    case 'PENDING':
      return [
        {
          action: 'match_invoice',
          method: 'POST',
          path: `/invoices/${id}/match`,
          description: 'Run the 3-way match of this invoice against goods received.',
        },
      ];
    case 'MATCHED':
      return [
        {
          action: 'approve_invoice',
          method: 'POST',
          path: `/invoices/${id}/approve`,
          description: 'Approve this matched invoice and post it to the general ledger.',
        },
      ];
    default:
      return [];
  }
}
