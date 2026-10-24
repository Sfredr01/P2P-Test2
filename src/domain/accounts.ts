import type { VendorCategory } from './types';

export const AP_CONTROL_ACCOUNT = '2000-AP-CONTROL';

// Single source of truth for which expense account an approved invoice is debited to.
export const EXPENSE_ACCOUNT_BY_CATEGORY: Record<VendorCategory, string> = {
  LUMBER: '5100-EXPENSE-LUMBER',
  HARDWARE: '5200-EXPENSE-HARDWARE',
  GENERAL: '6000-EXPENSE-GENERAL',
};
