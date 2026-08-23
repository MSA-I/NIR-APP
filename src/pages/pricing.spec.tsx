import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Pricing from './Pricing';

/**
 * The public pricing page, held to OPEN-DECISIONS #194, #195, #199–#204 and #208.
 *
 * Every number here comes from the server catalogue, never from a constant in the TSX
 * (ARCHITECTURE.md:244). The PRICE fixtures are #195 verbatim, because the catalogue is being
 * seeded with exactly those figures. The QUOTA fixtures are deliberately NOT #197 verbatim — see
 * the note above `QUOTAS` — because the page's job is to report what the server enforces, and
 * proving that is the point of two of the tests below.
 */
const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

/** #194: the landing ladder is exactly four. `business` never reaches this page. */
const CATALOGUE = [
  { plan_key: 'free', label: 'חינם', tier_order: 1, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 0, yearly_amount: null },
  { plan_key: 'basic', label: 'בסיס', tier_order: 2, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 69, yearly_amount: 690 },
  { plan_key: 'pro', label: 'פרו', tier_order: 3, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 249, yearly_amount: 2490 },
  { plan_key: 'premium', label: 'פרימיום', tier_order: 4, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 449, yearly_amount: 4490 },
  { plan_key: 'free', label: 'חינם', tier_order: 1, currency: 'USD', catalogue_version: 'global-2026-08', monthly_amount: 0, yearly_amount: null },
  { plan_key: 'basic', label: 'בסיס', tier_order: 2, currency: 'USD', catalogue_version: 'global-2026-08', monthly_amount: 20, yearly_amount: 200 },
  { plan_key: 'pro', label: 'פרו', tier_order: 3, currency: 'USD', catalogue_version: 'global-2026-08', monthly_amount: 79, yearly_amount: 790 },
  { plan_key: 'premium', label: 'פרימיום', tier_order: 4, currency: 'USD', catalogue_version: 'global-2026-08', monthly_amount: 149, yearly_amount: 1490 },
];

const quota = (planKey: string, key: string, label: string, limit: number | null, over: Record<string, unknown> = {}) => ({
  plan_key: planKey,
  entitlement_key: key,
  label,
  unit: 'documents',
  unlimited: false,
  numeric_limit: limit,
  measured: limit !== null,
  ...over,
});

/**
 * THE SERVER'S NUMBERS, NOT THE DECISION TABLE'S — and they are deliberately not the same.
 *
 * These quota figures are SYNTHETIC and do not describe production. The owner ruled on 23.08.2026
 * that #197's reduction applies immediately at cutover, so the live catalogue will hold #197
 * verbatim (25/250, 50/500, 200/2,000, 500/5,000) once the migration lands. An earlier ruling had
 * left a mixed catalogue in place and these fixtures used to record it; that is withdrawn.
 *
 * They stay divergent on purpose. If the fixtures matched #197, a page that hardcoded #197 would
 * pass this file, and the one property worth pinning here would go untested: the page must render
 * WHAT THE SERVER ENFORCES, whatever that is, because the day the two disagree again is the day a
 * public promise stops matching the refusal a customer actually gets. Divergent fixtures are the
 * only way to prove the page reads the catalogue rather than a constant.
 */
const QUOTAS = [
  ...['free', 'basic', 'pro', 'premium'].map((plan, index) =>
    quota(plan, 'documents.monthly', 'מסמכים', [25, 50, 300, 500][index])),
  ...['free', 'basic', 'pro', 'premium'].map((plan, index) =>
    quota(plan, 'ocr_pages.monthly', 'עמודי OCR', [500, 500, 6000, 5000][index])),
  // Unmeasured, so the page cannot publish #198's 20/40/100/250. The #197 ruling did not cover
  // the assistant quota — re-verify this against the catalogue when the contract names land.
  ...['free', 'basic', 'pro', 'premium'].map((plan) =>
    quota(plan, 'assistant_runs.monthly', 'ריצות עוזר', null, { measured: false })),
  // DEBT §56 — nothing measures these either.
  ...['free', 'basic', 'pro', 'premium'].map((plan) =>
    quota(plan, 'users.max', 'משתמשים', null, { measured: false })),
  ...['free', 'basic', 'pro', 'premium'].map((plan) =>
    quota(plan, 'suppliers.max', 'ספקים', null, { measured: false })),
];

beforeEach(() => {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_public_plan_catalogue') return Promise.resolve({ data: CATALOGUE, error: null });
    if (name === 'get_public_plan_quotas') return Promise.resolve({ data: QUOTAS, error: null });
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
  });
});

const renderPage = () => render(<MemoryRouter><Pricing /></MemoryRouter>);
const settle = () => waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

describe('דף המסלולים הציבורי', () => {
  it('מציג בדיוק את ארבעת המסלולים הציבוריים, ואת «ביזנס» בכלל לא', async () => {
    renderPage();
    await settle();
    for (const label of ['חינם', 'בסיס', 'פרו', 'פרימיום']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.queryByText(/ביזנס/)).not.toBeInTheDocument();
    expect(screen.queryByText(/דברו איתנו/)).not.toBeInTheDocument();
  });

  it('מציג את שני הקטלוגים המוכרעים בזה לצד זה — ולא בוחר מטבע במקום הלקוח', async () => {
    renderPage();
    await settle();
    // #195, verbatim: Israel 0/69/249/449 ILS, global 0/20/79/149 USD.
    const israel = screen.getByRole('row', { name: /מחיר — ישראל/ });
    for (const amount of ['69', '249', '449']) {
      expect(within(israel).getByText(new RegExp(amount))).toBeInTheDocument();
    }
    const global = screen.getByRole('row', { name: /מחיר — גלובלי/ });
    for (const amount of ['20', '79', '149']) {
      expect(within(global).getByText(new RegExp(amount))).toBeInTheDocument();
    }
  });

  it('מחזיק את המחיר השנתי המוכרע — מחיר של עשרה חודשים, בלי חישוב בדפדפן', async () => {
    const user = userEvent.setup();
    renderPage();
    await settle();
    await user.click(screen.getByRole('button', { name: 'שנתי' }));
    const israel = screen.getByRole('row', { name: /מחיר — ישראל/ });
    for (const amount of ['690', '2,490', '4,490']) {
      expect(within(israel).getByText(new RegExp(amount))).toBeInTheDocument();
    }
    const global = screen.getByRole('row', { name: /מחיר — גלובלי/ });
    for (const amount of ['200', '790', '1,490']) {
      expect(within(global).getByText(new RegExp(amount))).toBeInTheDocument();
    }
    // Free has no annual catalogue entry; an em dash says so instead of inventing a figure.
    expect(within(israel).getByText('—')).toBeInTheDocument();
  });

  it('אומר שהמטבע נקבע מכתובת החיוב המאומתת, ואין בורר מטבע', async () => {
    renderPage();
    await settle();
    expect(screen.getByText(/כתובת החיוב המאומתת/)).toBeInTheDocument();
    expect(screen.getByText(/לפני מס/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /מטבע/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^מטבע/ })).not.toBeInTheDocument();
  });

  it('מציג מכסה שאינה נמדדת כמקף — לא כאפס ולא כהבטחה', async () => {
    renderPage();
    await settle();
    const users = screen.getByRole('row', { name: /משתמשים/ });
    expect(within(users).getAllByText('—')).toHaveLength(4);
    expect(within(users).queryByText('0')).not.toBeInTheDocument();
  });

  it('מציג את המכסה שהשרת אוכף, ולא את המספר שבטבלת ההחלטות', async () => {
    renderPage();
    await settle();
    const documents = screen.getByRole('row', { name: /מסמכים/ });
    // 300 is the fixture's synthetic value, 200 is #197's decided one. The page must print the
    // former: it reports the catalogue, never the decision table.
    expect(within(documents).getByText('300')).toBeInTheDocument();
    expect(within(documents).queryByText('200')).not.toBeInTheDocument();
  });

  it('מכסה שהשרת מדווח כלא־נמדדת מוצגת כמקף, גם כשההחלטה נוקבת במספר', async () => {
    renderPage();
    await settle();
    const assistant = screen.getByRole('row', { name: /ריצות עוזר/ });
    expect(within(assistant).getAllByText('—')).toHaveLength(4);
    expect(within(assistant).queryByText('100')).not.toBeInTheDocument();
  });

  it('אינו מפרסם את תקרות האחסון ואינו חושף את מינימום הביזנס', async () => {
    renderPage();
    await settle();
    // #200: the GB ceilings are internal safety limits, not a commercial promise.
    expect(screen.queryByText(/GB|ג׳יגה|אחסון/)).not.toBeInTheDocument();
    // #201: $299/month and the $299 setup fee are internal.
    expect(screen.queryByText(/299/)).not.toBeInTheDocument();
  });

  it('משתמש רק בניסוח שאושר ב־#203, בלי הבטחת חיסכון ובלי countdown', async () => {
    renderPage();
    await settle();
    expect(screen.getByText('אותה שליטה. קצב שמתאים לעסק שלך.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'פתיחת חשבון חינם' })).toBeInTheDocument();
    expect(screen.queryByText(/תחסכו|חיסכון של|המחיר עולה בעוד|נותרו רק/)).not.toBeInTheDocument();
  });

  it('נותן לפרימיום הדגשה סטטית — לא הדגשה שנגזרת מנתוני לקוח', async () => {
    renderPage();
    await settle();
    const premium = screen.getByRole('columnheader', { name: /פרימיום/ });
    expect(within(premium).getByText('המקיף ביותר')).toBeInTheDocument();
  });

  it('אומר שהקטלוג לא נטען, במקום להציג מחיר מומצא', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText(/לא ניתן לטעון את המסלולים/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
