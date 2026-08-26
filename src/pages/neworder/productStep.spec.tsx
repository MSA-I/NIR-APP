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

function renderStep(cartProductIds: readonly string[], qty = 2) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const onQty = vi.fn();
  render(
    <ProductStep
      products={[tomato, cucumber]}
      categories={[]}
      offersByProduct={new Map([['p1', [offer]]])}
      cart={cartProductIds.map((id) => ({ product: id === 'p1' ? tomato : cucumber, qty }))}
      q="" setQ={() => {}} cat="" setCat={() => {}}
      onAdd={onAdd}
      onRemove={onRemove}
      onQty={onQty}
      onContinue={() => {}}
      nextOrderItems={[]}
      nextOrderBusyId={null}
      onAddNextOrderItem={() => {}}
      onDismissNextOrderItem={() => {}}
      onCreateProduct={null}
    />,
  );
  return { onAdd, onRemove, onQty };
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

// The cart stepper's floor. This is a real behaviour change and it is recorded here so that
// restoring the old floor fails a test rather than passing silently.
//
// Before the shared Stepper, the quantity control had no `min`, so pressing minus at 1 reached 0
// — and NewOrder maps qty 0 to REMOVE_PRODUCT. That was the legacy way out of the cart, and the
// header of this very file records it as the problem the row-as-toggle fixed (owner report,
// 19.08.2026). The floor of 1 also protects the newly editable input: clearing the field clamps
// to 1 instead of deleting the line under the user mid-keystroke.
describe('ProductStep — the quantity stepper has a floor of 1', () => {
  // The screen's own sentences, passed to `Stepper` as decrementLabel/incrementLabel. They are the
  // names this control carried before it was shared, and pinning them here is what keeps the next
  // convergence from quietly trading them for the primitive's generic composition.
  const minusName = 'הפחתת כמות עגבניות';
  const plusName = 'הוספת כמות עגבניות';

  it('the minus is disabled at qty 1, so decrementing can no longer empty the line', async () => {
    const { onQty } = renderStep(['p1'], 1);
    const minus = screen.getByRole('button', { name: minusName });

    expect(minus).toBeDisabled();

    await userEvent.click(minus);
    expect(onQty).not.toHaveBeenCalled();
  });

  it('the minus is live above the floor', async () => {
    const { onQty } = renderStep(['p1'], 3);
    const minus = screen.getByRole('button', { name: minusName });

    expect(minus).toBeEnabled();

    await userEvent.click(minus);
    expect(onQty).toHaveBeenCalledWith('p1', 2);
  });

  it('the plus still raises the quantity', async () => {
    const { onQty } = renderStep(['p1'], 1);

    await userEvent.click(screen.getByRole('button', { name: plusName }));

    expect(onQty).toHaveBeenCalledWith('p1', 2);
  });

  // The floor is only defensible because removal has somewhere else to live. If the row ever
  // stops removing, the floor becomes a trap and this test is the one that says so.
  it('removal still happens through the row toggle', async () => {
    const { onRemove, onQty } = renderStep(['p1'], 1);

    await userEvent.click(screen.getByRole('button', { name: 'ביטול בחירת עגבניות' }));

    expect(onRemove).toHaveBeenCalledWith('p1');
    expect(onQty).not.toHaveBeenCalled();
  });
});
