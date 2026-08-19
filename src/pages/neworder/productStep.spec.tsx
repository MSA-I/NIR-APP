// The product row is shaped like a toggle — it carries `aria-pressed` — so it has to behave like
// one. Before this it only ever added: pressing a product already in the cart did nothing at all,
// and the only way back out was to click the quantity stepper down to zero (owner report,
// 19.08.2026). Pure props, no MSW: this is about what the row calls, nothing else.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ProductStep from './ProductStep';
import type { Product, SupplierProduct } from '../../lib/types';

const product = (id: string, name: string): Product => ({
  id, org_id: 'org', name, display_name: null, category_id: null, unit: 'יח׳',
  sku: null, barcode: null, notes: null, active: true, min_stock: null,
});

const tomato = product('p1', 'עגבניות');
const cucumber = product('p2', 'מלפפונים');

const offer: SupplierProduct = {
  id: 'sp1', org_id: 'org', supplier_id: 's1', product_id: 'p1',
  current_price: 10, previous_price: null, price_effective_date: '2026-08-01',
  available: true, supplier_sku: null, min_qty: null, package_size: null,
  updated_at: '2026-08-01T00:00:00Z',
};

function renderStep(cartProductIds: readonly string[]) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  render(
    <ProductStep
      products={[tomato, cucumber]}
      categories={[]}
      offersByProduct={new Map([['p1', [offer]]])}
      cart={cartProductIds.map((id) => ({ product: id === 'p1' ? tomato : cucumber, qty: 2 }))}
      q="" setQ={() => {}} cat="" setCat={() => {}}
      onAdd={onAdd}
      onRemove={onRemove}
      onQty={() => {}}
      onContinue={() => {}}
      nextOrderItems={[]}
      nextOrderBusyId={null}
      onAddNextOrderItem={() => {}}
      onDismissNextOrderItem={() => {}}
      onCreateProduct={null}
    />,
  );
  return { onAdd, onRemove };
}

describe('ProductStep — the row is a real toggle', () => {
  it('a product that is not in the cart is added', async () => {
    const { onAdd, onRemove } = renderStep([]);
    const row = screen.getByRole('button', { name: 'בחירת עגבניות' });
    expect(row).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(row);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(tomato);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('a product already in the cart is removed, and is not added again', async () => {
    const { onAdd, onRemove } = renderStep(['p1']);
    // The label names the action the press performs, not the state the row is in.
    const row = screen.getByRole('button', { name: 'ביטול בחירת עגבניות' });
    expect(row).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(row);

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('p1');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('pressing a chosen product leaves its neighbours alone', async () => {
    const { onAdd, onRemove } = renderStep(['p1']);

    await userEvent.click(screen.getByRole('button', { name: 'ביטול בחירת עגבניות' }));
    await userEvent.click(screen.getByRole('button', { name: 'בחירת מלפפונים' }));

    expect(onRemove.mock.calls).toEqual([['p1']]);
    expect(onAdd.mock.calls).toEqual([[cucumber]]);
  });
});
