// What the receiving screen opens with, and — more importantly — what it must never drop.
//
// Since 0090 a goods-receipt draft can be opened by the machine from a delivery note, and such a
// draft carries ONLY the lines whose sku or barcode matched a product on the order. Everything
// else the order asked for has no draft row at all. If the hydration ever keyed off the draft
// instead of the order, those lines would disappear from the screen: the person would confirm a
// receipt that silently claims nothing else was ordered, and save_goods_receipt (0023:1505-1525)
// would then refuse the payload for having fewer lines than the order.
import { describe, expect, it } from 'vitest';
import { hydrateReceiptLines } from './Receiving';

const items = [
  { id: 'oi-1', product_id: 'p-1', qty: 10, received_qty: 0 },
  { id: 'oi-2', product_id: 'p-2', qty: 5, received_qty: 0 },
  { id: 'oi-3', product_id: 'p-3', qty: 4, received_qty: 1 },
];

describe('a machine draft that covers only part of the order', () => {
  it('keeps every ordered line on the screen', () => {
    const lines = hydrateReceiptLines({
      items,
      localLines: null,
      draftLines: [{ order_item_id: 'oi-1', qty_received: 4, status: 'partial', notes: null }],
      deliveredQty: null,
    });
    expect(Object.keys(lines).sort()).toEqual(['oi-1', 'oi-2', 'oi-3']);
  });

  it('uses the draft where it speaks and the remaining quantity where it is silent', () => {
    const lines = hydrateReceiptLines({
      items,
      localLines: null,
      draftLines: [{ order_item_id: 'oi-1', qty_received: 4, status: 'partial', notes: null }],
      deliveredQty: null,
    });
    expect(lines['oi-1']).toEqual({ qty: 4, status: 'partial', notes: '' });
    // Not zero. A line the delivery note never mentioned is not a line that failed to arrive —
    // the person at the delivery decides that, and the default must not decide it for them.
    expect(lines['oi-2']).toEqual({ qty: 5, status: 'full', notes: '' });
    // qty - received_qty, so a second receipt against a partly-received order opens at the rest.
    expect(lines['oi-3']).toEqual({ qty: 3, status: 'full', notes: '' });
  });
});

describe('the order of authority', () => {
  it('prefers unsynced local work over the server draft', () => {
    const lines = hydrateReceiptLines({
      items,
      localLines: new Map([['oi-1', { qty_received: 9, status: 'partial' as const, notes: 'נספר ידנית' }]]),
      draftLines: [{ order_item_id: 'oi-1', qty_received: 4, status: 'partial', notes: null }],
      deliveredQty: new Map([['p-1', 2]]),
    });
    expect(lines['oi-1']).toEqual({ qty: 9, status: 'partial', notes: 'נספר ידנית' });
  });

  it('prefers the server draft over the delivery note', () => {
    const lines = hydrateReceiptLines({
      items,
      localLines: null,
      draftLines: [{ order_item_id: 'oi-2', qty_received: 5, status: 'full', notes: null }],
      deliveredQty: new Map([['p-2', 1]]),
    });
    expect(lines['oi-2']).toEqual({ qty: 5, status: 'full', notes: '' });
  });

  it('reads a delivery-note quantity as partial, full or missing against what remains', () => {
    const lines = hydrateReceiptLines({
      items,
      localLines: null,
      draftLines: null,
      deliveredQty: new Map([['p-1', 10], ['p-2', 2], ['p-3', 0]]),
    });
    expect(lines['oi-1']).toEqual({ qty: 10, status: 'full', notes: '' });
    expect(lines['oi-2']).toEqual({ qty: 2, status: 'partial', notes: '' });
    // An explicit zero from the note IS a claim that it did not arrive, unlike silence above.
    expect(lines['oi-3']).toEqual({ qty: 0, status: 'missing', notes: '' });
  });
});
