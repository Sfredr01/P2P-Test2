import type { DatabaseSync } from 'node:sqlite';
import type { SkuRow, VendorRow } from '../domain/types';

// Fixed ids so tests, the README and an agent can reference seed data directly.

export const SEED_VENDORS: VendorRow[] = [
  { id: 'ven_acme', name: 'ACME Lumber Co.', payment_terms: 'NET30', category: 'LUMBER', is_active: 1 },
  { id: 'ven_buildright', name: 'BuildRight Hardware', payment_terms: 'NET60', category: 'HARDWARE', is_active: 1 },
  { id: 'ven_defunct', name: 'Defunct Supply LLC', payment_terms: 'NET30', category: 'GENERAL', is_active: 0 },
];

export const SEED_SKUS: SkuRow[] = [
  { sku: 'SKU-9234', description: '2x4x8 SPF Stud', category: 'LUMBER', default_unit_cost_cents: 425 },
  { sku: 'SKU-3300', description: 'Pressure-Treated 4x4x8 Post', category: 'LUMBER', default_unit_cost_cents: 1250 },
  { sku: 'SKU-4410', description: '3/4in Plywood Sheet 4x8', category: 'LUMBER', default_unit_cost_cents: 5400 },
  { sku: 'SKU-1001', description: '1/2in Drywall Sheet 4x8', category: 'GENERAL', default_unit_cost_cents: 1375 },
  { sku: 'SKU-2040', description: '3in Deck Screws 5lb Box', category: 'HARDWARE', default_unit_cost_cents: 2999 },
  { sku: 'SKU-5120', description: 'Galvanized Joist Hanger 2x6', category: 'HARDWARE', default_unit_cost_cents: 185 },
  { sku: 'SKU-6001', description: 'Construction Adhesive 28oz', category: 'GENERAL', default_unit_cost_cents: 740 },
  { sku: 'SKU-7700', description: '16d Framing Nails 50lb Box', category: 'HARDWARE', default_unit_cost_cents: 8900 },
];

export function seed(db: DatabaseSync): void {
  const insertVendor = db.prepare(
    'INSERT INTO vendors (id, name, payment_terms, category, is_active) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSku = db.prepare(
    'INSERT INTO skus (sku, description, category, default_unit_cost_cents) VALUES (?, ?, ?, ?)',
  );
  for (const v of SEED_VENDORS) insertVendor.run(v.id, v.name, v.payment_terms, v.category, v.is_active);
  for (const s of SEED_SKUS) insertSku.run(s.sku, s.description, s.category, s.default_unit_cost_cents);
}
