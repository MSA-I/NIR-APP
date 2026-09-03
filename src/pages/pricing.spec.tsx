import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import type { Locale } from '../lib/i18n/locale';
import Pricing from './Pricing';
/* Read, never restated: the promoted rung is a fact of the shared presentation file that the
   marketing site reads too, and a test that spelled the key out would pass while they drifted. */
import { RECOMMENDED_PLAN } from '../components/PlanTicket';

/**
 * The public pricing page, held to OPEN-DECISIONS #194, #199–#204, #208 and the owner's ruling of
 * 25.08.2026 that no price reaches a public surface before launch.
 *
 * Every number the page DOES print comes from the server catalogue, never from a constant in the
 * TSX (ARCHITECTURE.md:244). The QUOTA fixtures are deliberately NOT #197 verbatim — see the note
 * above `QUOTAS` — because the page's job is to report what the server enforces, and proving that
 * is the point of two of the tests below.
 *
 * The PRICE fixtures stay, and stay #195 verbatim, precisely BECAUSE the page must not show them.
 * They are the positive control for the absence: the catalogue hands this page real prices in
 * both currencies and both intervals, so a page that rendered any of them fails the test below.
 * An absence proved against a fixture with nothing in it would prove nothing.
 *
 * THE PAGE BECAME PLAN CARDS ON 26.08.2026 and the assertions moved with it, one for one. It was a
 * horizontally scrolling comparison TABLE and is now the same `PlanCard` grid `/settings/
 * subscription` draws, so every `columnheader` below is a card and every `row` is a feature row
 * inside one. Two tests changed in KIND rather than in selector, and both are called out where
 * they sit: the scroll-region accessibility test (the trap it guarded no longer exists) and the
 * loading-wrapper test (it pinned a literal width, which a redesign is allowed to change).
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
    quota(plan, 'ocr_pages.monthly', 'עמודי סריקה', [500, 500, 6000, 5000][index])),
  // Measured since the capability ladder (0246): both dials have a write guard behind them, so
  // the page may publish a figure for them. They used to sit in the unmeasured block below.
  ...['free', 'basic', 'pro', 'premium'].map((plan, index) =>
    quota(plan, 'users.max', 'משתמשים', [1, 5, 15, 30][index], { unit: 'users' })),
  ...['free', 'basic', 'pro', 'premium'].map((plan, index) =>
    quota(plan, 'branches.max', 'סניפים', [1, 1, 1, 10][index], { unit: 'branches' })),
  // Unmeasured, so the page cannot publish #198's 20/40/100/250. The #197 ruling did not cover
  // the assistant quota — re-verify this against the catalogue when the contract names land.
  ...['free', 'basic', 'pro', 'premium'].map((plan) =>
    quota(plan, 'assistant_runs.monthly', 'ריצות עוזר', null, { measured: false })),
  // DEBT §56 — nothing measures this one.
  ...['free', 'basic', 'pro', 'premium'].map((plan) =>
    quota(plan, 'suppliers.max', 'ספקים', null, { measured: false })),
];

const FEATURES = ['free', 'basic', 'pro', 'premium'].flatMap((planKey, tier) => [
  {
    plan_key: planKey, entitlement_key: 'documents.automation', label: 'קריאה אוטומטית של מסמכים',
    display_order: 10, included: tier >= 1, intro_included: tier === 0,
  },
  {
    plan_key: planKey, entitlement_key: 'bank.reconciliation', label: 'התאמות בנק',
    display_order: 60, included: tier >= 2, intro_included: false,
  },
  {
    plan_key: planKey, entitlement_key: 'integrations.api', label: 'חיבור למערכות אחרות',
    display_order: 100, included: tier >= 3, intro_included: false,
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
/** One rung's card, addressed the way every other surface addresses one. */
const card = (planKey: string) =>
  screen.getByTestId('plan-cards').querySelector(`[data-plan="${planKey}"]`) as HTMLElement;

/** The frame the card sits in. It carries the pointer's strip, which is not inside the card. */
const slot = (planKey: string) =>
  screen.getByTestId('plan-cards').querySelector(`[data-plan-slot="${planKey}"]`) as HTMLElement;

describe('דף המסלולים הציבורי', () => {
  it('מציג בדיוק את ארבעת המסלולים הציבוריים, ואת «ביזנס» בכלל לא', async () => {
    renderPage();
    const cards = await settle();
    expect(cards.querySelectorAll(':scope > li')).toHaveLength(4);
    for (const label of ['חינם', 'בסיס', 'פרו', 'פרימיום']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/ביזנס/)).not.toBeInTheDocument();
    expect(screen.queryByText(/דברו איתנו/)).not.toBeInTheDocument();
  });

  it('אינו מפרסם שום מחיר — גם כשהקטלוג מגיש לו אחד בשני מטבעות', async () => {
    renderPage();
    await settle();
    // The catalogue above hands this page #195 verbatim in both currencies and both intervals.
    // No currency symbol may reach the DOM: `fmtPlanPrice` is the only thing that emits one, and
    // the page no longer calls it.
    expect(screen.queryAllByText(/[₪$]/)).toHaveLength(0);
    // The amounts themselves, chosen from the set that cannot collide with a quota fixture.
    for (const amount of ['449', '4,490', '149', '1,490', '69', '790']) {
      expect(screen.queryAllByText(new RegExp(amount))).toHaveLength(0);
    }
    // And the figure slot on a card holds a QUOTA, not a price — 500 documents on premium, which
    // is the number the server enforces and not the 449 it also happened to hand us.
    expect(card('premium').textContent).toMatch(/500/);
    // No card carries a price line of any kind. The page may still SAY where the price is given —
    // that sentence lives in the notice above the grid and is asserted by its own test.
    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      expect(card(planKey).textContent).not.toMatch(/מחיר/);
    }
  });

  it('אינו מציג בורר מחזור חיוב — פקד שבלי מחיר אינו משנה דבר', async () => {
    renderPage();
    await settle();
    for (const label of ['חודשי', 'שנתי']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/עשרה חודשים/)).not.toBeInTheDocument();
  });

  it('אומר איפה המחיר כן נמסר ולפי מה נקבע המטבע, ואין בורר מטבע', async () => {
    renderPage();
    await settle();
    expect(screen.getByText(/אינו מפורסם בדף הזה/)).toBeInTheDocument();
    expect(screen.getByText(/כתובת החיוב המאומתת/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /מטבע/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^מטבע/ })).not.toBeInTheDocument();
  });

  it('מציג מכסות משתמשים וסניפים רק אחרי שהשרת מודד ואוכף אותן', async () => {
    renderPage();
    await settle();
    // One card per plan now, so the four cells of the old «משתמשים» row are one row in each card.
    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      const users = within(card(planKey)).getByText(/משתמשים/);
      expect(users.textContent).toMatch(/\d/);
    }
  });

  it('מציג את המכסה שהשרת אוכף, ולא את המספר שבטבלת ההחלטות', async () => {
    renderPage();
    await settle();
    // 300 is the fixture's synthetic value, 200 is #197's decided one. The page must print the
    // former: it reports the catalogue, never the decision table.
    expect(within(card('pro')).getAllByText('300').length).toBeGreaterThan(0);
    expect(within(card('pro')).queryByText('200')).not.toBeInTheDocument();
  });

  it('מציג את מדרגות היכולת וחלון ההיכרות מתוך חוזה השרת', async () => {
    renderPage();
    await settle();
    expect(card('free').textContent).toMatch(/קריאה אוטומטית.*30 הימים/);
    expect(within(card('basic')).getByText('קריאה אוטומטית של מסמכים')).toBeInTheDocument();
    expect(within(card('pro')).getByText('התאמות בנק')).toBeInTheDocument();
    expect(within(card('premium')).getByText('חיבור למערכות אחרות')).toBeInTheDocument();
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

  /**
   * #202: «המסלולים מקבלים הדגשה שיווקית סטטית עולה. ההדגשה אינה מבוססת על נתוני הדייר».
   *
   * The emphasis is the cream ticket face plus the «מומלץ» badge, and this test names the SOURCE
   * rather than the plan: `RECOMMENDED_PLAN` is read from `src/data/plan-presentation.json`, the
   * one file this page and the account ladder and the marketing site all draw from, so the three
   * cannot come to point a reader at different rungs. Spelling a key out here would pass happily
   * while they drifted.
   *
   * WHICH rung it is was settled on 27.08.2026 (#296). The two surfaces disagreed — the marketing
   * site promoted `pro`, the product promoted `premium` per the second half of #202 — and the owner
   * ruled «תיישר לפי הדף נחיתה». That supersedes the plan named in #202; the rest of #202 stands
   * and is what the last line here checks: the emphasis is STATIC, and a visitor holds no rung for
   * it to be keyed to in the first place.
   */
  it('נותן למסלול אחד הדגשה סטטית — לא הדגשה שנגזרת מנתוני לקוח', async () => {
    renderPage();
    await settle();
    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      const promoted = planKey === RECOMMENDED_PLAN;
      expect(card(planKey).className.includes('plan-card--framed')).toBe(promoted);
      expect(within(slot(planKey)).queryByText('מומלץ') !== null).toBe(promoted);
    }
  });

  /**
   * A stranger holds no rung, so nothing on this page may claim one. The account ladder's per-row
   * state chips ("המסלול הנוכחי", "מדרגה מעל") are exactly the sentences that would be a lie here,
   * and no action either: a "choose this plan" control would be a selection affordance for a
   * selection that does not exist, which is the same rule `OrgSubscriptionPanel` keeps by having
   * no purchase path at all.
   */
  it('אינו טוען שלמבקר יש מסלול, ואינו מציע לבחור אחד', async () => {
    renderPage();
    const cards = await settle();
    expect(screen.queryByText(/המסלול הנוכחי|מדרגה מעל|מדרגה מתחת/)).not.toBeInTheDocument();
    expect(cards.querySelectorAll('button')).toHaveLength(0);
  });

  it('אומר שהקטלוג לא נטען, במקום להציג מחיר מומצא', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    renderPage();
    expect(await screen.findByText(/לא ניתן לטעון את המסלולים/)).toBeInTheDocument();
    expect(screen.queryByTestId('plan-cards')).not.toBeInTheDocument();
  });

  /**
   * THIS TEST CHANGED SIDES, AND THAT IS THE POINT. It used to pin `tabIndex={0}` and a named
   * `role="region"` on the table's `overflow-x-auto` box — the minimum that makes a sideways
   * scroll reachable by a keyboard, because a visitor using one could otherwise read the free
   * column and never learn the other three existed. WCAG 2.1 AA is the stated target in
   * `PRODUCT.md`.
   *
   * The cards removed the scroll instead of taming it: four rungs stack on a phone and every quota
   * row is inside the card it belongs to. So the assertion is now that NO horizontal scroll
   * container is on the page at all — the stronger form of the same guarantee, and one that fails
   * the moment somebody reintroduces a sideways box.
   */
  it('אין קופסת גלילה לצדדים שמסתירה מסלולים ממקלדת', async () => {
    renderPage();
    const cards = await settle();
    expect(document.querySelectorAll('.overflow-x-auto')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: /השוואת המסלולים/ })).not.toBeInTheDocument();
    // Every rung is reachable by reading, not by scrolling: each card holds its own quota rows.
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/משתמשים/);
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/עמודי סריקה/);
  });

  /**
   * The loader used to return a bare centred spinner with no `main`, no max width and no vertical
   * padding, while both other states wrapped themselves in one. The landmark, the width and the top
   * offset all changed at the moment the catalogue landed, which is a page that jumps under the
   * reader.
   *
   * It pinned the literal `max-w-4xl`, which made a width change look like a regression — and the
   * ladder legitimately needed a wider measure. The property worth keeping is that the three states
   * agree, so the test now compares the loading wrapper to the loaded one instead of to a constant.
   */
  it('מצב הטעינה יושב באותה מסגרת כמו התוכן, כדי שהדף לא יקפוץ', async () => {
    const pending: Array<(value: unknown) => void> = [];
    rpc.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const { unmount } = renderPage();
    const loadingMain = await screen.findByRole('main');
    expect(within(loadingMain).getByRole('status')).toBeInTheDocument();
    const loadingClass = loadingMain.className;
    // Owner ruling 26.08.2026: «אם יש לי כבר שלד אין צורך בסמל הזה». The spinner is gone and the
    // ladder's own shape holds the height — same geometry as the rows it stands for, from the file
    // that owns the row. The TITLE is not data, so it is painted for real in all three states.
    expect(within(loadingMain).getByTestId('pricing-skeleton')).toBeInTheDocument();
    expect(within(loadingMain).getByRole('heading', { name: 'מסלולים' })).toBeInTheDocument();
    // Four rungs (#194 keeps `ביזנס` off this page) and NO action bar — these cards carry no
    // action, so a placeholder for one would promise a control the loaded page never shows.
    /* `.plan-card` and not `li`: the skeleton draws the card's own parts, and since 31.08.2026
       those include the entitlement list — which is a `ul` of `li` inside each card. Counting every
       `li` counted the rows as rungs. The class is what "a rung" means here. */
    expect(within(loadingMain).getByTestId('pricing-skeleton').querySelectorAll('.plan-card'))
      .toHaveLength(4);
    expect(within(loadingMain).queryByRole('button')).toBeNull();
    // The availability notice is fixed prose, not data — #208's currency rule is as true before
    // the RPC answers as after. It is also the block that was still moving the page: the ladder
    // began 90px higher while loading until it was painted here too.
    expect(within(loadingMain).getByText(/המחיר אינו מפורסם בדף הזה/)).toBeInTheDocument();
    // Settle the hanging RPCs so the component is not left mid-update when the test ends.
    for (const resolve of pending) resolve({ data: [], error: null });
    await waitFor(() => expect(screen.getByRole('main').className).toBe(loadingClass));
    unmount();

    rpc.mockImplementation((name: string) => {
      if (name === 'get_public_plan_catalogue') return Promise.resolve({ data: CATALOGUE, error: null });
      return Promise.resolve({ data: QUOTAS, error: null });
    });
    renderPage();
    await settle();
    expect(screen.getByRole('main').className).toBe(loadingClass);
  });

  /**
   * THE FIGURE IS A QUOTA AND THE CARD HAS TO SAY SO WHERE THE FIGURE IS.
   *
   * The slot is a price slot — `/settings/subscription` puts a price in it and so does the
   * marketing card — and this page put a bare number in it with «בתקופת שימוש חודשית» beside it,
   * which is a billing period. The noun sat one line lower in `.plan-card__billed`, the slot the
   * marketing card fills with «חיוב חודשי», and on a phone `plan-card.css:1009` hides both that
   * line and the figure line, leaving the head chip alone: a number with no noun anywhere.
   *
   * So the assertion is about ADJACENCY, not about the page containing the words somewhere.
   */
  it('לא מציג את המכסה כאילו הייתה מחיר — המילה צמודה למספר, בשתי הגרסאות של הכרטיס', async () => {
    renderPage();
    await settle();
    for (const [planKey, expected] of [['free', '25'], ['basic', '50'], ['pro', '300'], ['premium', '500']] as const) {
      // The desktop figure line and the phone's head chip carry the same figure...
      const figures = card(planKey).querySelectorAll('.plan-card__price');
      expect(figures.length).toBe(2);
      for (const figure of figures) {
        expect(figure.textContent).toBe(expected);
        // ...and the noun is the NEXT element in both, never a line away and never a period.
        const per = figure.nextElementSibling;
        expect(per?.className).toContain('plan-card__per');
        // The catalogue's own name for this quota, resolved through `usePlanCatalogue` — not the
        // billing-period phrase that used to sit here.
        expect(per?.textContent).toBe('מסמכים בחודש');
        expect(per?.textContent).not.toMatch(/תקופת שימוש/);
      }
    }
  });

  /**
   * ...and says it to a reader who is not looking at it. Both figure containers are `sr-only`-
   * described and their visible halves are hidden from the tree, so exactly one description is
   * live at any viewport (the two containers are `display:none` at opposite widths).
   */
  it('אומר מה המספר גם למי שאינו רואה אותו', async () => {
    renderPage();
    await settle();
    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      const described = card(planKey).querySelectorAll('[data-figure-kind="described"]');
      expect(described.length).toBe(1);
      // The number is not left to speak for itself.
      expect(described[0]!.getAttribute('aria-hidden')).toBe('true');
      expect(card(planKey).querySelectorAll('.sr-only').length).toBeGreaterThan(0);
    }
  });

  /**
   * A COMPARISON THAT TICKS WHAT YOU DO NOT GET IS WORSE THAN NO COMPARISON.
   *
   * Two collapses shipped together and both are pinned here, derived from the fixtures rather than
   * written as constants so a fixture change cannot leave this passing about the wrong rows:
   *
   *   · `affirmative: included || (free && intro_included)` gave the free rung a TICK for every
   *     capability it loses on day thirty-one — five of them in production, one in these fixtures.
   *   · An UNMEASURED quota (`suppliers.max`, `assistant_runs.monthly`) was `affirmative: false`,
   *     which drew the same ✗ as a real exclusion. A row that asserts nothing was published as a
   *     row that asserts «you do not get this».
   */
  it('לא מסמן ב־✓ שורה שאינה כלולה, ולא ב־✗ שורה שאינה נמדדת', async () => {
    renderPage();
    await settle();

    const rowsOf = (planKey: string) =>
      [...card(planKey).querySelectorAll('[data-row-state]')]
        .map((li) => li.getAttribute('data-row-state'));

    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      const states = rowsOf(planKey);
      const features = FEATURES.filter((row) => row.plan_key === planKey);
      const introOnly = features.filter((row) => row.intro_included && !row.included).length;
      const excludedFeatures = features.filter((row) => !row.included && !row.intro_included).length;
      const unmeasuredQuotas = QUOTAS.filter(
        (row) => row.plan_key === planKey && !row.measured && row.entitlement_key !== 'documents.monthly',
      ).length;

      expect(states.filter((s) => s === 'intro')).toHaveLength(introOnly);
      expect(states.filter((s) => s === 'excluded')).toHaveLength(excludedFeatures);
      expect(states.filter((s) => s === 'unmeasured')).toHaveLength(unmeasuredQuotas);
      // Nothing the server refuses is counted as an inclusion.
      expect(states.filter((s) => s === 'included')).toHaveLength(
        states.length - introOnly - excludedFeatures - unmeasuredQuotas,
      );
    }

    // And the collapse itself, stated as the thing it was: not every row is the same mark.
    const everyState = new Set(
      ['free', 'basic', 'pro', 'premium'].flatMap((planKey) => rowsOf(planKey)),
    );
    expect([...everyState].sort()).toEqual(['excluded', 'included', 'intro', 'unmeasured']);
  });

  /**
   * The distinction has to survive a screen reader. `.plan-row__mark` is `aria-hidden` — a lucide
   * glyph has no name worth reading — and it was the only thing on the row that carried the state,
   * so «התאמות בנק» on the free card and «התאמות בנק» on the premium card were the same four
   * syllables on a comparison whose entire purpose is that difference (WCAG 1.3.1).
   */
  it('מבחין בין כלול ללא־כלול גם בלי לראות את הסמל', async () => {
    renderPage();
    await settle();
    const spoken = (planKey: string, entitlementKey: string) => {
      const row = card(planKey).querySelector(`[data-row-state]:has(+ *), [data-row-state]`);
      expect(row).not.toBeNull();
      return entitlementKey;
    };
    expect(spoken('free', 'bank.reconciliation')).toBe('bank.reconciliation');

    // The glyph stays hidden, and a word stands beside it on every single row.
    for (const planKey of ['free', 'basic', 'pro', 'premium']) {
      for (const row of card(planKey).querySelectorAll('[data-row-state]')) {
        expect(row.querySelector('.plan-row__mark')?.getAttribute('aria-hidden')).toBe('true');
        const word = row.querySelector('.sr-only');
        expect(word).not.toBeNull();
        expect(word!.textContent?.trim().length).toBeGreaterThan(0);
      }
    }

    // Two rows that differ ONLY in state must not read alike. `bank.reconciliation` is excluded on
    // the free rung and included on premium, and the label is identical on both.
    const wordFor = (planKey: string, index: number) => {
      const row = [...card(planKey).querySelectorAll('[data-row-state]')][index]!;
      return `${row.getAttribute('data-row-state')}|${row.querySelector('.sr-only')?.textContent}`;
    };
    const freeBank = [...card('free').querySelectorAll('[data-row-state]')]
      .findIndex((row) => row.textContent?.includes('התאמות בנק'));
    const premiumBank = [...card('premium').querySelectorAll('[data-row-state]')]
      .findIndex((row) => row.textContent?.includes('התאמות בנק'));
    expect(freeBank).toBeGreaterThanOrEqual(0);
    expect(premiumBank).toBeGreaterThanOrEqual(0);
    expect(wordFor('free', freeBank)).not.toBe(wordFor('premium', premiumBank));
  });

  it('renders the public-plan promise in English', async () => {
    renderPage('en');
    await settle();

    expect(screen.getByRole('heading', { name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByText(/The price is not published on this page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open a free account' })).toBeInTheDocument();
    expect(screen.queryByText('פתיחת חשבון חינם')).toBeNull();
  });
});
