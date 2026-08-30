import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';
import type { SupplierGroup } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';
import SupplierGroupCard from './SupplierGroupCard';

const group: SupplierGroup = {
  supplier: { id: 'supplier-1', name: 'ירקות השדה', minOrderAmount: 100, currency: 'ILS' },
  lines: [{
    productId: 'product-1', qty: 2, assignment: { mode: 'auto' }, supplierId: 'supplier-1',
    unitPrice: 20, lineTotal: 40, status: 'ok', currency: 'ILS',
  }],
  subtotal: 40,
  currency: 'ILS',
  shortfall: 60,
  belowMinimum: true,
  savingsContribution: 5,
};

const products = new Map([['product-1', { id: 'product-1', name: 'עגבניות' } as Product]]);

describe('SupplierGroupCard language boundary', () => {
  it('translates the decision copy while keeping supplier and product names raw', () => {
    render(
      <LocaleProvider initialLocale="en">
        <SupplierGroupCard group={group} products={products} onOpenFix={vi.fn()}
          onOpenGroupMove={vi.fn()} canMoveGroup />
      </LocaleProvider>,
    );

    expect(screen.getByText('Below minimum')).toBeInTheDocument();
    expect(screen.getByText('Order total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show solutions' })).toBeInTheDocument();
    expect(screen.getByText('ירקות השדה')).toBeInTheDocument();
    expect(screen.getByText('עגבניות')).toBeInTheDocument();
    expect(screen.queryByText('מתחת למינימום')).toBeNull();
  });
});
