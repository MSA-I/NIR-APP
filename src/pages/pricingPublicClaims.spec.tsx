import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import type { Locale } from '../lib/i18n/locale';
import Pricing from './Pricing';

/**
 * WHAT THE PUBLIC PRICING PAGE CLAIMS, HELD AGAINST WHAT IT SHOWS — `ENTRY-05` and `ENTRY-06`.
 *
 * Two findings, one page, and both of them are about a screen saying a thing twice.
 *
 * `ENTRY-05`: the banner above the ladder said «כל היכולות פתוחות בכל המסלולים; ההבדל הוא נפח
 * בלבד» — every capability is open on every plan, only volume differs — while the cards directly
 * beneath it drew eight `לא כלול` rows on בסיס and one block titled «אין גישה לכספים וחיבורים».
 * A visitor who reads only the banner believes Basic includes bank reconciliation and accountant
 * exports. It does not. And on a phone the banner was ALL a visitor got (`ENTRY-02`), so the false
 * half was the only half.
 *
 * `ENTRY-06`: an intro row on the free rung stated its thirty-day window THREE times — the badge
 * `.plan-row__tag` the card draws, the `sr-only` state word `BlockRow` writes, and a whole sentence
 * this page baked into the label. In a 209px column a 110px `white-space: nowrap` badge beside a
 * full sentence starves the label to about 50px, which is how the row measured 138px against every
 * other plan's 17px and how the badge left the card by nineteen pixels. The geometry is measured in
 * a browser by `scripts/measure-public-entrance.mjs`; what is pinned HERE is its cause — one fact,
 * stated once, in the slot the card reserves for it.
 *
 * The fixtures are synthetic and deliberately not the decision table, for the reason `pricing.spec`
 * gives at length: the page reports the catalogue it is handed, so a fixture matching production
 * would let a page that hardcoded production pass.
 */
const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

const PLANS = ['free', 'basic', 'pro', 'premium'] as const;

const CATALOGUE = PLANS.map((plan, index) => ({
  plan_key: plan,
  label: ['חינם', 'בסיס', 'פרו', 'פרימיום'][index],
  tier_order: index + 1,
  currency: 'ILS',
  catalogue_version: 'spec-fixture',
  monthly_amount: [0, 69, 249, 449][index],
  yearly_amount: null,
}));

const QUOTAS = PLANS.map((plan, index) => ({
  plan_key: plan,
  entitlement_key: 'documents.monthly',
  label: 'מסמכים',
  unit: 'documents',
  unlimited: false,
  numeric_limit: [25, 50, 300, 500][index],
  measured: true,
}));

/**
 * `AUTOMATION` is the row the finding photographed: the longest label on the card, intro-only on
 * the free rung. `RECONCILIATION` is a plain exclusion on the two lower rungs — the row that makes
 * the banner's claim false.
 */
const AUTOMATION = { key: 'documents.automation', label: 'קריאה אוטומטית של מסמכים' };
const RECONCILIATION = { key: 'bank.reconciliation', label: 'התאמות בנק' };

const FEATURES = PLANS.flatMap((plan, tier) => [
  {
    plan_key: plan, entitlement_key: AUTOMATION.key, label: AUTOMATION.label,
    display_order: 10, included: tier >= 1, intro_included: tier === 0,
  },
  {
    plan_key: plan, entitlement_key: RECONCILIATION.key, label: RECONCILIATION.label,
    display_order: 60, included: tier >= 2, intro_included: false,
  },
]);

beforeEach(() => {
  rpc.mockImplementation((name: string) => {
    if (name === 'get_public_plan_catalogue') return Promise.resolve({ data: CATALOGUE, error: null });
    if (name === 'get_public_plan_quotas') return Promise.resolve({ data: QUOTAS, error: null });
    if (name === 'get_public_plan_features') return Promise.resolve({ data: FEATURES, error: null });
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
  });
});

const renderPage = (locale: Locale = 'he') => render(
  <LocaleProvider initialLocale={locale}><MemoryRouter><Pricing /></MemoryRouter></LocaleProvider>,
);
const settle = () => screen.findByTestId('plan-cards');
const card = (planKey: string) =>
  screen.getByTestId('plan-cards').querySelector(`[data-plan="${planKey}"]`) as HTMLElement;

/**
 * Everything the page says AROUND the ladder — the banner and the two footnotes.
 *
 * Addressed as "the page minus the cards" rather than by a class on the `Note`, because the claim
 * under test is about what the page tells a reader, and moving the sentence into a different
 * wrapper must not be a way to pass this.
 */
const noticeText = () => {
  const main = screen.getByRole('main');
  const ladder = screen.getByTestId('plan-cards');
  return [...main.children]
    .filter((el) => el !== ladder && !el.contains(ladder))
    .map((el) => el.textContent ?? '')
    .join(' ')
    .trim();
};

describe('הבטחות דף המסלולים הציבורי', () => {
  /**
   * `ENTRY-05`. The two halves are asserted together on purpose: a page that simply deleted the
   * banner would pass a bare "does not say X" test while telling the reader less than before.
   */
  it('אינו מבטיח שכל היכולות פתוחות בכל מסלול בזמן שהכרטיסים שוללים יכולות', async () => {
    renderPage('he');
    await settle();

    // The cards do exclude capabilities — the fact the banner has to agree with.
    const excluded = screen.getByTestId('plan-cards').querySelectorAll('[data-row-state="excluded"]');
    expect(excluded.length).toBeGreaterThan(0);
    expect(card('basic').textContent).toMatch(/התאמות בנק/);

    const notice = noticeText();
    // The claim the sweep quoted, in the words it quoted.
    expect(notice).not.toMatch(/כל היכולות פתוחות בכל המסלולים/);
    expect(notice).not.toMatch(/ההבדל הוא נפח בלבד/);
    // And it still tells the reader what the difference IS, rather than going quiet.
    expect(notice).toMatch(/יכולות/);
    // The rest of the banner is untouched: #208's currency rule and the owner's no-price ruling.
    expect(notice).toMatch(/אינו מפורסם בדף הזה/);
  });

  it('אותה הבטחה גם באנגלית', async () => {
    renderPage('en');
    await settle();
    const notice = noticeText();
    expect(notice).not.toMatch(/every capability is open on every plan/i);
    expect(notice).not.toMatch(/only volume differs/i);
    expect(notice).toMatch(/capabilit/i);
    expect(notice).toMatch(/not published on this page/i);
  });

  /**
   * `ENTRY-06`. The row states the window ONCE, in the badge the card reserves for it — and the
   * label is the capability's own name, the same name every other rung prints.
   */
  it('שורת חלון ההיכרות אומרת את החלון פעם אחת, והתווית היא שם היכולת בלבד', async () => {
    renderPage('he');
    await settle();

    const introRows = [...card('free').querySelectorAll('[data-row-state="intro"]')];
    expect(introRows.length).toBeGreaterThan(0);

    for (const row of introRows) {
      const label = row.querySelector('.plan-row__label');
      const tag = row.querySelector('.plan-row__tag');
      expect(tag, 'an intro row must carry the badge that states the window').not.toBeNull();
      expect(tag!.textContent?.trim()).toBeTruthy();
      // The label is the name, not the name plus the sentence the badge already carries.
      expect(label?.textContent?.trim()).toBe(AUTOMATION.label);
    }

    // The same name, unqualified, on the rung that simply includes it — so the two rungs are
    // compared on one string rather than on two differently-worded ones.
    expect(card('basic').querySelector('.plan-row__label')?.textContent?.trim())
      .toBe(AUTOMATION.label);
  });
});
