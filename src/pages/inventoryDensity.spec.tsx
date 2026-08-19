// What the מלאי screen wraps, and what it stopped wrapping.
//
// The screen used to open with four separate surfaces before the first table: a `Note` box holding
// a sentence that never changes, a `Disclosure` inside a `.card` (a box around a box), and three
// `KpiCard`s that a phone stacks into three more boxes. Below them stood two tables of identical
// visual weight, so the ledger of past movements looked exactly as much like a decision as the
// balances that drive a purchase.
//
// These tests pin the shape, not the styling: one card for the three stock counts, no card around
// the method note, no note box around the reading key, and a movement feed that is FOLDED rather
// than dropped — the count and the last movement time stay on screen while it is closed, and every
// row comes back when it is opened. DESIGN.md's חוק תיבת הדואר is the rule being enforced: what
// folds is evidence and detail, the count on the summary row is the content, and a failed read is
// never folded away.
//
// They also pin the band's PROMISE: three counts that look alike must behave alike. "מוצרים שנספרו"
// used to be the one segment that never filtered, so the row a user read as a control did nothing
// when clicked, and the two that did filter went dead whenever their count was zero.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-1', role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Inventory from './Inventory';

// A product that exists ONLY in the movement feed. Product names appear in the balances table too,
// so a name shared between the two would make "the feed is folded" pass for the wrong reason.
const MOVED_ONLY = 'שמן זית פרימיום';

const BALANCES = [
  {
    product_id: 'p-1', product_name: 'קמח לבן', unit: 'kg', min_stock: 20, quantity_on_hand: 8,
    is_counted: true, last_counted_at: '2026-08-10T06:00:00Z', is_low_stock: true,
    consumption_sample_count: 4, consumption_quantity: 12, average_daily_consumption: 1.5,
    expected_incoming_quantity: 0, incoming_without_date_quantity: 0, next_expected_incoming_date: null,
    projected_stockout_days: 5, suggested_reorder_quantity: 30, cheapest_supplier_name: 'ספק א',
    cheapest_unit_price: 4.5, price_advantage: 0.4, supplier_price_count: 2, latest_purchase_unit_price: 4.8,
  },
  {
    product_id: 'p-2', product_name: 'סוכר', unit: 'kg', min_stock: 10, quantity_on_hand: null,
    is_counted: false, last_counted_at: null, is_low_stock: null,
    consumption_sample_count: null, consumption_quantity: null, average_daily_consumption: null,
    expected_incoming_quantity: null, incoming_without_date_quantity: null, next_expected_incoming_date: null,
    projected_stockout_days: null, suggested_reorder_quantity: null, cheapest_supplier_name: null,
    cheapest_unit_price: null, price_advantage: null, supplier_price_count: null, latest_purchase_unit_price: null,
  },
];

const MOVEMENTS = [
  {
    id: 'm-1', product_id: 'p-9', product_name: MOVED_ONLY, unit: 'l', movement_type: 'stocktake',
    quantity_delta: 6, counted_quantity: 6, negative_override: false, reason: 'ספירת פתיחה',
    created_by: 'u-1', created_by_name: 'בודק', created_at: '2026-08-17T09:30:00Z',
    receipt_id: null, receipt_number: null, reverses_movement_id: null,
  },
  {
    id: 'm-2', product_id: 'p-1', product_name: 'קמח לבן', unit: 'kg', movement_type: 'consumption',
    quantity_delta: -2, counted_quantity: null, negative_override: false, reason: 'מטבח',
    created_by: 'u-1', created_by_name: 'בודק', created_at: '2026-08-16T09:30:00Z',
    receipt_id: null, receipt_number: null, reverses_movement_id: null,
  },
];

const inventoryTraffic = [
  http.get(`${SUPABASE_URL}/rest/v1/inventory_intelligence`, () => HttpResponse.json(BALANCES)),
  http.get(`${SUPABASE_URL}/rest/v1/inventory_movement_feed`, () => HttpResponse.json(MOVEMENTS)),
];

function renderInventory() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<Inventory />, { wrapper: Wrapper });
}

describe('מלאי — הכרטיסים שנשארו והכרטיסים שהוסרו', () => {
  it('שלושת מדדי המלאי חיים בכרטיס אחד, לא בשלושה', async () => {
    server.use(...inventoryTraffic);
    renderInventory();

    const counted = await screen.findByText('מוצרים שנספרו');
    const band = counted.closest<HTMLElement>('.card');
    expect(band).not.toBeNull();

    // Scoped to the band on purpose: "מתחת למינימום" is also an option in the table's filter
    // select, and an unscoped query would pass on a screen that had lost the segment entirely.
    expect(within(band!).getByText('מתחת למינימום')).toBeInTheDocument();
    expect(within(band!).getByText('ממתינים לספירה')).toBeInTheDocument();
    // One card, not a card holding three more.
    expect(band!.querySelectorAll('.card')).toHaveLength(0);
  });

  it('מפתח הקריאה של המסך נשאר על המסך אך אינו יושב בתוך תיבת Note', async () => {
    server.use(...inventoryTraffic);
    renderInventory();

    const key = await screen.findByText(/מוצר שלא נספר מוצג כמקף/);
    expect(key.closest('[class*="note-"]')).toBeNull();
  });

  it('הסבר החישוב אינו עטוף בכרטיס, ויושב ליד הטבלה שהוא מתאר', async () => {
    server.use(...inventoryTraffic);
    renderInventory();

    const method = await screen.findByText('איך המספרים כאן מחושבים');
    expect(method.closest('.card')).toBeNull();
    // …and it now belongs to the balances section, whose columns it explains.
    expect(method.closest('section')?.getAttribute('aria-labelledby')).toBe('inventory-balances-title');
  });
});

describe('רצועת המלאי — כל שלושת המדדים מסננים את הטבלה', () => {
  it('לחיצה על "מוצרים שנספרו" מסננת לנספרים בלבד, ולחיצה חוזרת מנקה את הסינון', async () => {
    server.use(...inventoryTraffic);
    renderInventory();

    const title = await screen.findByText('מוצרים שנספרו');
    // The segment is a real control, not decoration — it was the one card with no onClick at all.
    const segment = () => title.closest('button');
    expect(segment()).not.toBeNull();
    expect(segment()).toHaveAttribute('aria-pressed', 'false');

    // Scoped to the balances section: 'קמח לבן' also appears in the movement feed below, so an
    // unscoped query would report the feed's row as if the table had kept it.
    const balances = () => screen.getByRole('region', { name: 'יתרות מוצרים' });
    expect(within(balances()).getAllByText('סוכר').length).toBeGreaterThan(0);

    await userEvent.click(segment()!);

    expect(segment()).toHaveAttribute('aria-pressed', 'true');
    expect(within(balances()).getAllByText('קמח לבן').length).toBeGreaterThan(0);
    // 'סוכר' is the uncounted product; filtering to the counted ones must drop it.
    expect(within(balances()).queryAllByText('סוכר')).toHaveLength(0);

    await userEvent.click(segment()!);

    expect(segment()).toHaveAttribute('aria-pressed', 'false');
    expect(within(balances()).getAllByText('סוכר').length).toBeGreaterThan(0);
  });
});

describe('פיד התנועות מקופל — ולא נמחק', () => {
  it('הכותרת, הספירה והתנועה האחרונה נשארות גלויות כשהפיד סגור', async () => {
    server.use(...inventoryTraffic);
    renderInventory();

    const heading = await screen.findByText('תנועות אחרונות');
    expect(heading).toBeVisible();
    const summary = heading.closest('summary');
    expect(summary).not.toBeNull();
    // The count IS the content of a folded section (DESIGN.md, חוק תיבת הדואר §2).
    expect(within(summary!).getByText('2')).toBeVisible();
    expect(within(summary!).getByText(/אחרונה:/)).toBeVisible();
  });

  it('שורות הפיד מוסתרות כשהוא סגור וחוזרות במלואן בפתיחה', async () => {
    server.use(...inventoryTraffic);
    renderInventory();
    const heading = await screen.findByText('תנועות אחרונות');
    const summary = heading.closest('summary')!;

    // DataTable keeps both the mobile card list and the desktop table mounted, so every value
    // legitimately appears more than once in jsdom; what is asserted is that NONE of the copies
    // is reachable while the section is folded, and that they all come back when it is opened.
    const folded = await screen.findAllByText(MOVED_ONLY);
    expect(folded).not.toHaveLength(0);
    folded.forEach((node) => expect(node).not.toBeVisible());

    await userEvent.click(summary);

    const opened = screen.getAllByText(MOVED_ONLY);
    expect(opened).not.toHaveLength(0);
    opened.forEach((node) => expect(node).toBeVisible());
  });

  it('כשל בטעינת התנועות מוכרז על שורת הסיכום — קיפול אינו מסתיר תקלה', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/inventory_intelligence`, () => HttpResponse.json(BALANCES)),
      http.get(`${SUPABASE_URL}/rest/v1/inventory_movement_feed`, () =>
        HttpResponse.json({ message: 'boom', code: null, details: null, hint: null }, { status: 500 })),
    );
    renderInventory();

    expect(await screen.findByText('שגיאה בטעינת התנועות')).toBeVisible();
  });
});
