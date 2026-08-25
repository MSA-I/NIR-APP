import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { fmtNum } from '../lib/format';

/**
 * The public plan ladder — what each plan LETS YOU DO, with no figure attached.
 *
 * ARCHITECTURE.md:244 forbids a pricing plan hidden in code, and this page is the reason that
 * rule exists: a hardcoded table would drift from what the server actually enforces, and the
 * first customer to notice would be one who was refused something the page promised. Every
 * figure below therefore arrives from `get_public_plan_quotas()`; `get_public_plan_catalogue()`
 * supplies the ladder itself — which plans exist, their labels, their order.
 *
 * FOUR THINGS THIS PAGE DELIBERATELY DOES NOT DO.
 *
 * 1. It does not publish a price. Owner decision, 25.08.2026: no amount reaches a public surface
 *    before launch. The catalogue of #195/#208 is decided and seeded, and the AUTHENTICATED
 *    upgrade surface (`OrgSubscriptionPanel`) still shows it — because there the org's billing
 *    country is known and the figure is a fact. A public visitor has no verified billing country,
 *    so #208's rule cannot even decide which of the two catalogues applies to them. This page
 *    therefore compares volumes and says where the price is given.
 *    `get_public_plan_catalogue()` still RETURNS the amounts; nothing renders them. Narrowing the
 *    RPC is a server change and a separate decision.
 * 2. It does not show `ביזנס`. #194 puts Business in the authenticated upgrade surface only. The
 *    exclusion is the server's — `get_public_plan_catalogue()` returns four plans — so a
 *    client-side filter cannot be forgotten. #201's internal minimums never leave the platform.
 * 3. It does not publish what nobody measures. `users.max` and `suppliers.max` have no measurement
 *    (DEBT §56) and the storage ceilings of #200 are internal safety limits, not a promise. An
 *    unmeasured quota renders `—`. Never `0`: zero is also a claim about reality.
 * 4. It does not offer a billing-interval toggle. The toggle existed to switch WHICH PRICE was
 *    shown; with no price shown it would be a control that changes nothing on the page.
 */
interface PlanRow {
  plan_key: string;
  label: string;
  tier_order: number;
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
 * #202 requires a STATIC ascending emphasis with Premium the most desirable. Static is the whole
 * point: it is keyed to a plan, never derived from the reader's own usage, and it changes no
 * permission. The wording is provisional under #203 — the final marketing round happens after
 * live evidence.
 */
const EMPHASIS: Record<string, string> = { premium: 'המקיף ביותר' };

export default function Pricing() {
  const [state, setState] = useState<{
    catalogue: PlanRow[]; quotas: QuotaRow[]; error: string | null; loading: boolean;
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
        catalogue: (catalogue.data ?? []) as PlanRow[],
        quotas: (quotas.data ?? []) as QuotaRow[],
        error: null,
        loading: false,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * One column per plan, in the server's tier order. The catalogue lists each plan once per
   * currency and the ladder is identical across them, so the first row per plan wins.
   */
  const plans = useMemo(() => {
    const seen = new Map<string, PlanRow>();
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

      <Note tone="info">
        <span className="min-w-0 flex-1">
          כל היכולות פתוחות בכל המסלולים; ההבדל הוא נפח בלבד. המחיר אינו מפורסם בדף הזה — הוא נמסר
          בתוך החשבון, בשלב המעבר למסלול בתשלום, במטבע שנקבע לפי כתובת החיוב המאומתת מול ספק
          הסליקה ולא לפי מיקום משוער. פתיחת חשבון והמסלול החינמי אינם דורשים אמצעי תשלום.
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
