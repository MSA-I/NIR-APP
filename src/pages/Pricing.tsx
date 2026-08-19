import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note, PageLoader } from '../components/ui';
import { fmtNum } from '../lib/format';

interface PlanRow { plan_key: string; label: string; tier_order: number; active: boolean }
interface EntitlementRow {
  plan_key: string;
  entitlement_key: string;
  kind: 'numeric' | 'boolean';
  unlimited: boolean;
  numeric_limit: number | null;
  boolean_value: boolean | null;
}

/**
 * The plan comparison, read from the database (0154) rather than written here.
 *
 * ARCHITECTURE.md:244 forbids a pricing plan hidden in code, and this page is the reason that
 * rule exists: a hardcoded table would drift from what the server actually enforces, and the
 * first customer to notice would be one who was refused something the page promised.
 *
 * There are NO PRICES on this page, and that is not an omission to fill in later without a
 * decision. Prices are OPEN-DECISIONS #161 and no shekel figure exists anywhere in the schema;
 * inventing one on a public page would be the most expensive kind of guess.
 */
export default function Pricing() {
  const [state, setState] = useState<{
    plans: PlanRow[]; entitlements: EntitlementRow[]; error: string | null; loading: boolean;
  }>({ plans: [], entitlements: [], error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [plans, entitlements] = await Promise.all([
        supabase.from('subscription_plans')
          .select('plan_key, label, tier_order, active').eq('active', true).order('tier_order'),
        supabase.from('plan_entitlements')
          .select('plan_key, entitlement_key, kind, unlimited, numeric_limit, boolean_value'),
      ]);
      if (cancelled) return;
      if (plans.error || entitlements.error) {
        setState({ plans: [], entitlements: [], loading: false,
          error: 'לא ניתן לטעון את המסלולים כרגע.' });
        return;
      }
      setState({
        plans: (plans.data ?? []) as PlanRow[],
        entitlements: (entitlements.data ?? []) as EntitlementRow[],
        error: null,
        loading: false,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.loading) return <PageLoader />;
  if (state.error) return <main className="mx-auto max-w-3xl px-4 py-12"><ErrorNote message={state.error} /></main>;

  const keys = [...new Set(state.entitlements.map((row) => row.entitlement_key))].sort();
  const cell = (planKey: string, entitlementKey: string) => {
    const row = state.entitlements
      .find((entry) => entry.plan_key === planKey && entry.entitlement_key === entitlementKey);
    // A plan with no row for an entitlement states nothing about it. An em dash says that; a
    // zero or a cross would be a claim the catalogue does not make.
    if (!row) return <span className="text-ink-muted">—</span>;
    if (row.kind === 'boolean') return row.boolean_value ? 'כלול' : 'לא כלול';
    if (row.unlimited) return 'ללא הגבלה';
    if (row.numeric_limit === null) return <span className="text-ink-muted">—</span>;
    return <span className="num">{fmtNum(row.numeric_limit)}</span>;
  };

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-12">
      <h1 className="page-title">מסלולים</h1>

      <Note tone="info">
        <span className="min-w-0 flex-1">
          הטבלה נטענת מהמסלולים שהמערכת אוכפת בפועל, ולא מרשימה שנכתבה בדף. מסלול שאינו מגביל
          יכולת מוצג כ«ללא הגבלה», ומסלול שלא נקבעה לו מגבלה מוצג כ«—».
        </span>
      </Note>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="p-3 text-start font-medium text-ink-body">יכולת</th>
              {state.plans.map((plan) => (
                <th key={plan.plan_key} scope="col" className="p-3 text-start font-medium text-ink">
                  {plan.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key} className="border-b border-line-soft last:border-0">
                <th scope="row" className="p-3 text-start font-normal text-ink-body">{key}</th>
                {state.plans.map((plan) => (
                  <td key={plan.plan_key} className="p-3 text-ink-body">{cell(plan.plan_key, key)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-ink-muted">
        מחירים טרם נקבעו ואינם מוצגים כאן. פרטים מול השירות.
      </p>

      <Link className="btn-primary" to="/signup">פתיחת חשבון</Link>
    </main>
  );
}
