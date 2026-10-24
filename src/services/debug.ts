import type { Db } from '../db/connection';
import type { DebugStateView } from '../domain/views';
import { glTotals } from './glPosting';
import { listInvoices } from './invoices';
import { listPurchaseOrders } from './purchaseOrders';
import { listSkus, listVendors } from './vendors';

export function getDebugState(db: Db): DebugStateView {
  return {
    vendors: listVendors(db),
    skus: listSkus(db),
    purchase_orders: listPurchaseOrders(db),
    invoices: listInvoices(db),
    gl_summary: glTotals(db),
  };
}
