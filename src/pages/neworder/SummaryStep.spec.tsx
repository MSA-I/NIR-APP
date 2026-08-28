import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';
import type { OrderSplit } from '../../lib/orderSplit';
import type { Product } from '../../lib/types';
import SummaryStep from './SummaryStep';

const product: Product = {
  id: 'product-1',
  org_id: 'org-1',
  name: 'עגבניות מהקטלוג',
  display_name: null,
  category_id: null,
  unit: 'ק״ג',
  sku: null,
  barcode: null,
  notes: null,
  active: true,
  min_stock: null,
};

const split: OrderSplit = {
  groups: [{
    supplier: { id: 'supplier-1', name: 'ספק מקור', minOrderAmount: 200 },
    lines: [{
      productId: product.id,
      qty: 2,
      assignment: { mode: 'auto' },
      supplierId: 'supplier-1',
      unitPrice: 50,
      lineTotal: 100,
      status: 'ok',
    }],
    subtotal: 100,
    shortfall: 100,
    belowMinimum: true,
    savingsContribution: 20,
  }],
  blocked: [],
  total: 100,
  savings: {
    splitTotal: 100,
    singleSupplierTotal: 120,
    singleSupplierId: 'supplier-1',
    savings: 20,
    savingsPercent: 16.7,
    supplierCount: 1,
    allCheapest: true,
  },
  breachCount: 1,
};

describe('SummaryStep language boundary', () => {
  it('renders decision copy in English and preserves order data', () => {
    render(
      <LocaleProvider initialLocale="en">
        <SummaryStep
          split={split}
          products={new Map([[product.id, product]])}
          singleSupplierName="ספק מקור"
          productCount={1}
          notes="הערה שהמשתמש כתב"
          expectedDate="2026-09-01"
          busy={false}
          onBack={vi.fn()}
          onConfirm={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Order summary' })).toBeInTheDocument();
    expect(screen.getByText(/One supplier is below its order minimum/)).toBeInTheDocument();
    expect(screen.getAllByText('ספק מקור')).not.toHaveLength(0);
    expect(screen.getByText('עגבניות מהקטלוג')).toBeInTheDocument();
    expect(screen.getByText('הערה שהמשתמש כתב')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm and send orders' })).toBeInTheDocument();
  });
});
