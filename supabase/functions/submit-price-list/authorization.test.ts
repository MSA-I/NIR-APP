import { activePriceListRoleAllowed } from './authorization.ts';

function assert(value: unknown): asserts value {
  if (!value) throw new Error('expected a truthy value');
}

function assertFalse(value: unknown): void {
  if (value) throw new Error('expected a falsy value');
}

Deno.test('price-list intake accepts only owner and office', () => {
  assert(activePriceListRoleAllowed('owner'));
  assert(activePriceListRoleAllowed('office'));
  for (const role of ['accountant', 'kitchen', 'payer', 'supplier']) {
    assertFalse(activePriceListRoleAllowed(role));
  }
});
