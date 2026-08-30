import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from './ui';
import type { PreferencesInput } from '../lib/orderEmail';

/**
 * The half of the owner's 11.08.2026 ruling that this card had never been tested for: the reason
 * box used to disable "שמירה" outright, which meant a manager who wanted to switch a supplier to
 * email had to invent a sentence first. The box is now optional to TYPE and still mandatory in the
 * LEDGER -- `set_supplier_communication_preferences` raises `reason_required` on a blank -- so what
 * has to be proven here is both halves at once: the button saves with an empty box, and the RPC
 * still receives a sentence naming the action.
 */
const calls = vi.hoisted(() => ({
  saved: [] as { supplierId: string; input: PreferencesInput }[],
}));

vi.mock('../lib/orderEmail', async () => {
  const actual = await vi.importActual<typeof import('../lib/orderEmail')>('../lib/orderEmail');
  return {
    ...actual,
    fetchSupplierCommunicationPreferences: async () => null,
    setSupplierCommunicationPreferences: async (supplierId: string, input: PreferencesInput) => {
      calls.saved.push({ supplierId, input });
    },
  };
});

import { SupplierCommunicationCard } from './SupplierCommunicationCard';

function renderCard() {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <SupplierCommunicationCard
            supplierId="supplier-1"
            supplierEmail="orders@supplier.test"
            supplierPhone="972500000001"
            canWrite
          />
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.saved.length = 0;
});

describe('SupplierCommunicationCard', () => {
  it('שומר העדפות תקשורת גם כשלא נכתבה סיבה, ושולח משפט ליומן', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: /עריכה/ }));

    const save = screen.getByRole('button', { name: 'שמירה' });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(calls.saved).toHaveLength(1));
    expect(calls.saved[0].supplierId).toBe('supplier-1');
    expect(calls.saved[0].input.reason).toContain('ללא הערה');
    expect(calls.saved[0].input.reason.trim().length).toBeGreaterThan(0);
  });

  it('סיבה שנכתבה מגיעה ליומן כלשונה', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: /עריכה/ }));
    await user.type(screen.getByLabelText(/רשות/), 'הספק ביקש לעבור למייל');
    await user.click(screen.getByRole('button', { name: 'שמירה' }));

    await waitFor(() => expect(calls.saved).toHaveLength(1));
    expect(calls.saved[0].input.reason).toBe('הספק ביקש לעבור למייל');
  });
});
