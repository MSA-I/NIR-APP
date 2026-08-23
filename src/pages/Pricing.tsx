import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { fmtNum, fmtPlanPrice } from '../lib/format';

/**
 * The public plan ladder, read from the server catalogue rather than written here.
 *
 * ARCHITECTURE.md:244 forbids a pricing plan hidden in code, and this page is the reason that
 * rule exists: a hardcoded table would drift from what the server actually enforces, and the
 * first customer to notice would be one who was refused something the page promised. Every
 * figure below therefore arrives from `get_public_plan_catalogue()` / `get_public_plan_quotas()`.
 *
 * THREE THINGS THIS PAGE DELIBERATELY DOES NOT DO.
 *
 * 1. It does not pick a currency. OPEN-DECISIONS #208: the catalogue follows the billing country
 *    VERIFIED AT THE MERCHANT OF RECORD — never an IP guess and never a free currency picker. A
 *    visitor to a public page has no verified billing country, so there is no verified currency
 *    to state. Both decided catalogues are shown side by side, labelled, with the rule spelled
 *    out; choosing one here would be presenting a guess as a fact.
 * 2. It does not show `ביזנס`. #194 puts Business in the authenticated upgrade surface only, with
 *    no price. The exclusion is the server's — `get_public_plan_catalogue()` returns four plans — so a
 *    client-side filter cannot be forgotten. #201's internal minimums never leave the platform.
 * 3. It does not publish what nobody measures. `users.max` and `suppliers.max` have no measurement
 *    (DEBT §56) and the storage ceilings of #200 are internal safety limits, not a promise. An
 *    unmeasured quota renders `—`. Never `0`: zero is also a claim about reality.
 */
interface CatalogueRow {
  plan_key: string;
  label: string;
  tier_order: number;
  currency: string;
  catalogue_version: string;
  monthly_amount: number | null;
  yearly_amount: number | null;
}

interface QuotaRow {
  plan_key: string;
  entitlement_key: string;
  label: string;
  unlimited: boolean;
  numeric_limit: number | null;
  measured: boolean;
}

/**
 * The two catalogues, named. Order matters only for reading; neither is a default, and the page
 * never claims one applies to the reader.
 */
const CATALOGUES = [
  { currency: 'ILS', label: 'מחיר — ישראל (₪)' },
  { currency: 'USD', label: 'מחיר — גלובלי ($)' },
] as const;

/**
 * #202 requires a STATIC ascending emphasis with Premium the most desirable. Static is the whole
 * point: it is keyed to a plan, never derived from the reader's own usage, and it changes no
 * permission. The wording is provisional under #203 — the final marketing round happens after
 * live evidence.
 */
const EMPHASIS: Record<string, string> = { premium: 'המקיף ביותר' };

type Interval = 'monthly' | 'yearly';

export default function Pricing() {
  const [interval, setInterval] = useState<Interval>('monthly');
  const [state, setState] = useState<{
    catalogue: CatalogueRow[]; quotas: QuotaRow[]; error: string | null; loading: boolean;
  }>({ catalogue: [], quotas: [], error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalogue, quotas] = await Promise.all([
        supabase.rpc('get_public_plan_catalogue'),
        supabase.rpc('get_public_plan_quotas'),
      ]);
      if (cancelled) return;
      if (catalogue.error || quotas.error) {
        setState({ catalogue: [], quotas: [], loading: false,
          error: 'לא ניתן לטעון את המסלולים כרגע.' });
        return;
      }
      setState({
        catalogue: (catalogue.data ?? []) as CatalogueRow[],
        quotas: (quotas.data ?? []) as QuotaRow[],
        error: null,
        loading: false,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  /** One column per plan, in the server's tier order. */
  const plans = useMemo(() => {
    const seen = new Map<string, { plan_key: string; label: string; tier_order: number }>();
    for (const row of state.catalogue) {
      if (!seen.has(row.plan_key)) {
        seen.set(row.plan_key, { plan_key: row.plan_key, label: row.label, tier_order: row.tier_order });
      }
    }
    return [...seen.values()].sort((a, b) => a.tier_order - b.tier_order);
  }, [state.catalogue]);

  /** One row per quota, in the order the catalogue lists them. */
  const quotaKeys = useMemo(
    () => [...new Set(state.quotas.map((row) => row.entitlement_key))],
    [state.quotas],
  );
  const quotaLabel = (key: string) =>
    state.quotas.find((row) => row.entitlement_key === key)?.label ?? key;

  const priceCell = (planKey: string, currency: string) => {
    const row = state.catalogue.find((entry) => entry.plan_key === planKey && entry.currency === currency);
    const amount = interval === 'monthly' ? row?.monthly_amount : row?.yearly_amount;
    // A plan the catalogue prices for one interval and not the other states nothing about the
    // other. An em dash says that; a zero would say it is free.
    if (amount == null) return <span className="text-ink-muted">—</span>;
    return <span className="num">{fmtPlanPrice(amount, currency)}</span>;
  };

  const quotaCell = (planKey: string, key: string) => {
    const row = state.quotas.find((entry) => entry.plan_key === planKey && entry.entitlement_key === key);
    // Unmeasured is the honest state of `users.max` and `suppliers.max` today (DEBT §56). We do
    // not publish, and therefore do not promise, a number nothing enforces.
    if (!row || !row.measured) return <span className="text-ink-muted">—</span>;
    if (row.unlimited) return 'ללא הגבלה';
    if (row.numeric_limit === null) return <span className="text-ink-muted">—</span>;
    return <span className="num">{fmtNum(row.numeric_limit)}</span>;
  };

  const hasUnmeasured = state.quotas.some((row) => !row.measured);

  if (state.loading) return <PageLoader />;
  if (state.error) {
    return <main className="mx-auto max-w-3xl px-4 py-12"><ErrorNote message={state.error} /></main>;
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-12">
      <header className="space-y-2">
        <h1 className="page-title">מסלולים</h1>
        <p className="text-ink-body">אותה שליטה. קצב שמתאים לעסק שלך.</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-body" id="pricing-interval-label">מחזור חיוב</span>
        <div className="flex gap-2" role="group" aria-labelledby="pricing-interval-label">
          {([['monthly', 'חודשי'], ['yearly', 'שנתי']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={interval === value}
              className={`chip-filter ${interval === value ? 'chip-filter-active' : ''}`}
              onClick={() => setInterval(value)}>{label}</button>
          ))}
        </div>
        <span className="text-sm text-ink-muted">מנוי שנתי מחויב במחיר של עשרה חודשים.</span>
      </div>

      <Note tone="info">
        <span className="min-w-0 flex-1">
          שני קטלוגים, ואיננו בוחרים עבורך: הקטלוג, המטבע והמחיר נקבעים לפי כתובת החיוב המאומתת
          מול ספק הסליקה — לא לפי מיקום משוער ולא לפי בחירת מטבע חופשית. כתובת חיוב בישראל מקבלת
          את קטלוג השקלים, כל מדינה אחרת את קטלוג הדולרים. המחירים כאן הם לפני מס; ספק הסליקה
          מחשב וגובה את המס המקומי.
        </span>
      </Note>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="p-3 text-start font-medium text-ink-body">מסלול</th>
              {plans.map((plan) => (
                <th key={plan.plan_key} scope="col" className="p-3 text-start font-medium text-ink">
                  <span className="block">{plan.label}</span>
                  {EMPHASIS[plan.plan_key] && (
                    <span className="badge-info mt-1 inline-block">{EMPHASIS[plan.plan_key]}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATALOGUES.map((catalogue) => (
              <tr key={catalogue.currency} className="border-b border-line-soft">
                <th scope="row" className="p-3 text-start font-normal text-ink-body">{catalogue.label}</th>
                {plans.map((plan) => (
                  <td key={plan.plan_key} className="p-3 text-ink">
                    {priceCell(plan.plan_key, catalogue.currency)}
                  </td>
                ))}
              </tr>
            ))}
            {quotaKeys.map((key) => (
              <tr key={key} className="border-b border-line-soft last:border-0">
                <th scope="row" className="p-3 text-start font-normal text-ink-body">{quotaLabel(key)}</th>
                {plans.map((plan) => (
                  <td key={plan.plan_key} className="p-3 text-ink-body">{quotaCell(plan.plan_key, key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-ink-muted">
        המכסות נספרות בתקופת שימוש חודשית של הארגון. חריגה עוצרת עיבוד חדש בלבד — שום מסמך אינו
        נמחק ושום דבר שכבר נעשה אינו נחסם למפרע.
      </p>
      {hasUnmeasured && (
        <p className="text-sm text-ink-muted">
          מכסה שהמערכת אינה מודדת היום מוצגת כ«—» ואינה מפורסמת כמספר, כדי שלא תיווצר הבטחה שאין
          מאחוריה מדידה.
        </p>
      )}

      <Link className="btn-primary" to="/signup">פתיחת חשבון חינם</Link>
    </main>
  );
}
