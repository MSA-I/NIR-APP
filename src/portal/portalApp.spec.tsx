import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PortalApp from './PortalApp';
import type { PortalView } from './api';

// The portal's contract: one order rendered from the snapshot, one submission, uniform failure
// states — and the payload it sends is exactly what the supplier typed, item-fenced to the
// snapshot. The Edge endpoint is mocked at fetch level: the portal has no Supabase client.

const TOKEN = 'ab'.repeat(32);

const view = (over: Partial<PortalView> = {}): PortalView => ({
  state: 'open',
  expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
  proposal: null,
  snapshot: {
    order_id: 'o-1',
    order_number: 42,
    revision_number: 1,
    expected_date: '2026-08-25',
    notes: null,
    supplier_name: 'ספק בדיקה',
    org_name: 'ארגון בדיקה',
    issued_at: new Date().toISOString(),
    items: [
      { order_item_id: 'i-1', position: 1, product_name: 'קמח 1 ק"ג', unit: 'kg', qty: 5, unit_price: 10 },
      { order_item_id: 'i-2', position: 2, product_name: 'שמן זית', unit: 'liter', qty: 2, unit_price: 20 },
    ],
  },
  ...over,
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.location.hash = `#token=${TOKEN}`;
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('PortalApp', () => {
  it('renders the snapshot: order number, supplier, raw wording, quantities and prices', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view()));
    render(<PortalApp />);
    expect(await screen.findByText(/#42/)).toBeInTheDocument();
    expect(screen.getByText('קמח 1 ק"ג')).toBeInTheDocument();
    expect(screen.getByText('שמן זית')).toBeInTheDocument();
    expect(screen.getByText('ארגון בדיקה')).toBeInTheDocument();
    // resolve was called with the token from the fragment, POSTed, never in the URL
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).not.toContain(TOKEN);
    expect(JSON.parse(init.body as string)).toMatchObject({ action: 'resolve', token: TOKEN });
  });

  it('approves as sent: every line available, no proposed values', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view()));
    render(<PortalApp />);
    await screen.findByText(/#42/);
    fetchMock.mockResolvedValueOnce(jsonResponse({ proposal_id: 'p-1', status: 'submitted' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(view({ state: 'submitted', proposal: {
      status: 'submitted', submitted_at: new Date().toISOString(),
      proposed_delivery_date: null, total_delta: 0,
    } })));
    await userEvent.click(screen.getByRole('button', { name: 'אישור ההזמנה כפי שנשלחה' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const submitBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(submitBody.action).toBe('submit');
    expect(submitBody.proposal.lines).toEqual([
      { order_item_id: 'i-1', availability: 'available' },
      { order_item_id: 'i-2', availability: 'available' },
    ]);
    expect(await screen.findByText('התשובה נשלחה בהצלחה')).toBeInTheDocument();
  });

  it('sends structured changes: proposed qty/price, unavailability with replacement text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view()));
    render(<PortalApp />);
    await screen.findByText(/#42/);

    await userEvent.type(screen.getByLabelText('כמות מוצעת', { selector: '#qty-i-1' }), '3');
    await userEvent.type(screen.getByLabelText('מחיר יחידה מוצע', { selector: '#price-i-1' }), '9');
    await userEvent.click(screen.getAllByLabelText('הפריט אינו זמין')[1]);
    await userEvent.type(
      screen.getByLabelText(/הצעת תחליף/), 'שמן קנולה 5 ליטר');

    fetchMock.mockResolvedValueOnce(jsonResponse({ proposal_id: 'p-1', status: 'submitted' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(view({ state: 'submitted', proposal: {
      status: 'submitted', submitted_at: new Date().toISOString(),
      proposed_delivery_date: null, total_delta: -63,
    } })));
    await userEvent.click(screen.getByRole('button', { name: 'שליחת השינויים המוצעים' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const submitBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(submitBody.proposal.lines).toEqual([
      {
        order_item_id: 'i-1', availability: 'available',
        proposed_qty: 3, proposed_unit_price: 9, replacement_note: null,
      },
      {
        order_item_id: 'i-2', availability: 'unavailable',
        proposed_qty: null, proposed_unit_price: null, replacement_note: 'שמן קנולה 5 ליטר',
      },
    ]);
  });

  it('shows the dead-link screen on 404, with no retry surface', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'link_invalid' }, 404));
    render(<PortalApp />);
    expect(await screen.findByText('הקישור אינו פעיל')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a missing or malformed fragment token never reaches the network', async () => {
    window.location.hash = '#token=not-a-token';
    render(<PortalApp />);
    expect(await screen.findByText('הקישור אינו פעיל')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the already-answered state read-only with the proposal status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(view({
      state: 'submitted',
      proposal: {
        status: 'partially_accepted', submitted_at: new Date().toISOString(),
        proposed_delivery_date: '2026-09-01', total_delta: -63,
      },
    })));
    render(<PortalApp />);
    expect(await screen.findByText('כבר נשלחה תשובה להזמנה זו')).toBeInTheDocument();
    expect(screen.getByText('ההצעה אושרה חלקית על ידי העסק')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /אישור ההזמנה/ })).not.toBeInTheDocument();
  });
});
