import type { Db } from '../db/connection';
import type { SkuRow, VendorRow } from '../domain/types';
import type { SkuView, VendorView } from '../domain/views';
import { AppError, notFound } from '../errors';

function toView(row: VendorRow): VendorView {
  return { ...row, is_active: row.is_active === 1 };
}

export function listVendors(db: Db): VendorView[] {
  return (db.prepare('SELECT * FROM vendors ORDER BY rowid').all() as unknown as VendorRow[]).map(toView);
}

export function getVendor(db: Db, id: string): VendorView {
  return toView(requireVendor(db, id));
}

export function requireVendor(db: Db, id: string): VendorRow {
  const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id) as unknown as VendorRow | undefined;
  if (!row) throw notFound('vendor', id);
  return row;
}

export function requireActiveVendor(db: Db, id: string): VendorRow {
  const vendor = requireVendor(db, id);
  if (!vendor.is_active) {
    throw new AppError('VENDOR_INACTIVE', `Vendor ${id} (${vendor.name}) is inactive.`, { details: { vendor_id: id } });
  }
  return vendor;
}

export function listSkus(db: Db): SkuView[] {
  return db.prepare('SELECT * FROM skus ORDER BY rowid').all() as unknown as SkuRow[];
}
