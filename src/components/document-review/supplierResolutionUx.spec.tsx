import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentReviewRead } from './assessment';

type TestSupplier = { id: string; name: string };

const db = vi.hoisted(() => ({
  suppliers: [
    { id: 'supplier-machine', name: 'הספק שהמסמך הציע' },
    { id: 'supplier-human', name: 'הספק שהאדם בחר' },
  ] as TestSupplier[],
  supplierMode: 'ok' as 'ok' | 'error' | 'pending',
  resolveSuppliers: null as null | ((value: { data: TestSupplier[]; error: null }) => void),
  orders: [] as Array<{
    id: string;
    number: number;
    status: string;
    currency: string;
    items: Array<{ qty: number; received_qty: number }>;
  }>,
}));
const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn((table: string) => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order']) chain[method] = () => chain;
  chain.range = () => {
    if (table === 'suppliers' && db.supplierMode === 'pending') {
      return new Promise((resolve) => { db.resolveSuppliers = resolve; });
    }
    if (table === 'suppliers' && db.supplierMode === 'error') {
      return Promise.resolve({ data: null, error: { message: 'supplier_fetch_failed' } });
    }
    return Promise.resolve({
      data: table === 'suppliers' ? db.suppliers : table === 'purchase_orders' ? db.orders : [],
      error: null,
    });
  };
  return chain;
}));

vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-1', role: 'owner' },
    org: { vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';

function unresolvedRead(): DocumentReviewRead {
  return {
    document_id: 'doc-1',
    file_name: 'invoice.pdf',
    document_kind: 'invoice',
    document_type: 'invoice',
    document_date: '2026-09-05',
    file_stored: true,
    data_approved: false,
    interpretation_id: 'interpretation-1',
    supplier_resolution: {
      resolved: false,
      supplier_id: null,
      matched_by: null,
      reason: 'no_evidence',
      suggested_name: 'הספק שהמסמך הציע',
      candidates: [{
        supplier_id: 'supplier-machine',
        name: 'הספק שהמסמך הציע',
        matched_by: 'model_suggestion',
        authoritative: false,
      }],
    },
    order_resolution: null,
    assessment: null,
    state: 'supplier_unresolved',
  };
}

describe('document supplier resolution', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockClear();
    db.supplierMode = 'ok';
    db.resolveSuppliers = null;
    db.orders = [];
    rpc.mockResolvedValue({ data: unresolvedRead(), error: null });
  });

  it('turns an unresolved machine suggestion into a human supplier decision', async () => {
    render(<DocumentAssessmentPanel documentId="doc-1" />);

    const supplier = await screen.findByRole('combobox', { name: 'הספק' });
    expect(supplier).toHaveValue('');
    expect(screen.getByRole('option', { name: 'הספק שהמסמך הציע' })).toBeInTheDocument();
    expect(screen.getByText(/קריאת המכונה/)).toHaveTextContent('הספק שהמסמך הציע');

    await userEvent.selectOptions(supplier, 'supplier-human');

    expect(screen.getByText(/נבחר ידנית/)).toHaveTextContent('הספק שהאדם בחר');
    expect(screen.getByRole('button', { name: 'אישור המסמך' })).toBeEnabled();
  });

  it('shows loading, an actionable supplier error, and a working retry', async () => {
    db.supplierMode = 'pending';
    const first = render(<DocumentAssessmentPanel documentId="doc-1" />);

    const supplier = await screen.findByRole('combobox', { name: 'הספק' });
    expect(supplier).toBeDisabled();
    expect(screen.getByRole('option', { name: 'טוען ספקים…' })).toBeInTheDocument();

    await act(async () => {
      db.resolveSuppliers?.({ data: db.suppliers, error: null });
    });
    first.unmount();

    db.supplierMode = 'error';
    // A second render is a fresh request; the failed read must explain itself instead of leaving
    // the disabled loading placeholder on screen forever.
    render(<DocumentAssessmentPanel documentId="doc-2" />);
    expect(await screen.findByText('לא ניתן לטעון את רשימת הספקים.')).toBeInTheDocument();

    db.supplierMode = 'ok';
    await userEvent.click(screen.getByRole('button', { name: 'נסה שוב' }));
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'הספק שהאדם בחר' })).not.toHaveLength(0));
  });

  it('requires a person to confirm a supplier name read from the document before creation', async () => {
    render(<DocumentAssessmentPanel documentId="doc-1" />);
    await screen.findByRole('combobox', { name: 'הספק' });

    await userEvent.click(screen.getByRole('button', { name: 'ספק חדש' }));

    expect(screen.getByLabelText('שם הספק *')).toHaveValue('הספק שהמסמך הציע');
    const confirmation = screen.getByRole('checkbox', { name: /אני מאשר/ });
    expect(confirmation).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'שמירה' })).toBeDisabled();

    await userEvent.click(confirmation);
    expect(screen.getByRole('button', { name: 'שמירה' })).toBeEnabled();
    expect(screen.getByText(/את שאר פרטי הספק משלימים/)).toBeInTheDocument();
  });

  it('creates through the reasoned idempotent RPC and selects the returned supplier', async () => {
    const read = unresolvedRead();
    read.supplier_resolution = {
      ...read.supplier_resolution!,
      suggested_name: 'ספק חדש לגמרי',
      candidates: [],
    };
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_document_review_assessment') return { data: read, error: null };
      if (name === 'create_supplier_from_document') {
        return {
          data: { supplier_id: 'supplier-created', name: 'ספק חדש לגמרי', idempotent: false },
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected_rpc:${name}` } };
    });
    render(<DocumentAssessmentPanel documentId="doc-1" />);
    const supplier = await screen.findByRole('combobox', { name: 'הספק' });

    await userEvent.click(screen.getByRole('button', { name: 'ספק חדש' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /אני מאשר/ }));
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      'create_supplier_from_document',
      expect.objectContaining({
        p_document_id: 'doc-1',
        p_name: 'ספק חדש לגמרי',
        p_tax_id: null,
        p_idempotency_key: expect.any(String),
        p_reason: 'יצירת ספק במהלך בדיקת מסמך',
      }),
    ));
    await waitFor(() => expect(supplier).toHaveValue('supplier-created'));
  });

  it('shows every scoped order and names risky cancelled, closed and fully received states', async () => {
    const read = unresolvedRead();
    read.supplier_resolution = {
      resolved: true,
      supplier_id: 'supplier-machine',
      matched_by: 'exact_name',
      reason: null,
      suggested_name: 'הספק שהמסמך הציע',
      candidates: [],
    };
    read.assessment = {
      document_type: 'invoice',
      supplier_id: 'supplier-machine',
      order_id: null,
      currency: 'ILS',
      document_number: 'INV-109',
      document_date: '2026-09-05',
      sources: { document: true, ordered: false, received: false, baseline: false },
      totals: {
        lines_net: null,
        lines_discount: null,
        header_net: null,
        header_vat: null,
        header_total: null,
        computed_total: null,
        unexplained_gap: null,
        lines_vs_header_gap: null,
        overcharge_total: null,
        line_tolerance: 0.05,
        document_tolerance: 1,
        currency: 'ILS',
        missing_rungs: ['lines_net', 'header_net', 'header_vat', 'header_total'],
      },
      severity: 'info',
      approval_blocked: false,
      lines: [],
      order_items: [],
      findings: [],
    };
    db.orders = [
      { id: 'order-cancelled', number: 101, status: 'cancelled', currency: 'ILS', items: [{ qty: 2, received_qty: 0 }] },
      { id: 'order-closed', number: 102, status: 'closed', currency: 'ILS', items: [{ qty: 2, received_qty: 1 }] },
      { id: 'order-received', number: 103, status: 'received', currency: 'ILS', items: [{ qty: 2, received_qty: 2 }] },
      { id: 'order-open', number: 104, status: 'sent', currency: 'ILS', items: [{ qty: 2, received_qty: 0 }] },
    ];
    rpc.mockResolvedValue({ data: read, error: null });
    render(<DocumentAssessmentPanel documentId="doc-1" />);

    const order = await screen.findByRole('combobox', { name: 'ההזמנה' });
    expect(await screen.findByRole('option', { name: /הזמנה 101.*בוטלה/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /הזמנה 102.*סגורה/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /הזמנה 103.*סגורה.*התקבלה במלואה/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'הזמנה 104' })).toBeInTheDocument();

    await userEvent.selectOptions(order, 'order-cancelled');
    expect(screen.getByRole('alert')).toHaveTextContent('בוטלה');
  });

  it('does not treat a manual supplier choice as the missing source invoice for a credit', async () => {
    const read = unresolvedRead();
    read.document_kind = 'credit_note';
    read.document_type = 'credit_note';
    read.credit_resolution = {
      resolved: false,
      reason: 'invoice_reference_unresolved',
      supplier_id: null,
      invoice_id: null,
      reference_invoice_number: null,
      amount: 50,
    };
    rpc.mockResolvedValue({ data: read, error: null });
    render(<DocumentAssessmentPanel documentId="doc-1" />);

    const supplier = await screen.findByRole('combobox', { name: 'הספק' });
    await userEvent.selectOptions(supplier, 'supplier-human');

    expect(screen.getByRole('button', { name: 'אישור המסמך' })).toBeDisabled();
    expect(screen.getByText(/לא ניתן לזהות חשבונית מקור/)).toBeInTheDocument();
  });
});
