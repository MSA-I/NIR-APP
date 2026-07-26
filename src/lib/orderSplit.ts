import type { OrderSavings } from './orderSavings';

export type { OrderSavings } from './orderSavings';

export type Assignment = { mode: 'auto' } | { mode: 'pinned'; supplierId: string };

export interface SplitLine { productId: string; qty: number; assignment: Assignment }

export interface SplitOffer { supplierId: string; unitPrice: number; minQty: number | null }
export interface SplitSupplier { id: string; name: string; minOrderAmount: number | null }

export interface SplitInput {
  lines: readonly SplitLine[];
  offersByProduct: ReadonlyMap<string, readonly SplitOffer[]>;
  suppliers: ReadonlyMap<string, SplitSupplier>;
}

export type LineStatus =
  | 'ok'
  | 'pin_below_min_qty'
  | 'pin_supplier_gone'
  | 'no_usable_offer'
  | 'no_offers';

export interface ResolvedLine {
  productId: string;
  qty: number;
  assignment: Assignment;
  supplierId: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  status: LineStatus;
}

export interface SupplierGroup {
  supplier: SplitSupplier;
  lines: ResolvedLine[];
  subtotal: number;
  shortfall: number | null;
  belowMinimum: boolean;
  savingsContribution: number | null;
}

export interface OrderSplit {
  groups: SupplierGroup[];
  blocked: ResolvedLine[];
  total: number;
  savings: OrderSavings;
  breachCount: number;
}
