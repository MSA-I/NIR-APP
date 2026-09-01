import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note } from '../components/ui';
import {
  HEADLINE_QUOTA_KEY, PLAN_TRAY, PlanTicket, PlanTicketSkeleton, RECOMMENDED_PLAN,
  type PlanTicketFeature,
} from '../components/PlanTicket';
import { fmtNum } from '../lib/format';
import { usePlanCatalogue } from '../lib/planLabels';
import type { PlanFeatureRowData } from '../lib/planEntitlements';

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
 *
 * ─── AND FROM 26.08.2026 IT IS BUILT THE WAY THE ACCOUNT SCREEN IS BUILT ──────────────────────
 *
 * This page used to be a horizontally scrolling comparison TABLE, while `/settings/subscription`
 * showed sunken boxes. Two constructions, one product, and a visitor who signed up met a
 * different-looking ladder on the other side of the login screen than the one that convinced
 * them. Both are now `PlanCard` on `PLAN_LIST` — one rung per ROW, in tier order, so the eye
 * climbs the ladder instead of scanning a shelf of equals (owner ruling 26.08.2026). Same tier
 * metals, same four blocks in the same order along the row, same check-glyph entitlements, same
 * inverted onyx on the rung #202 emphasises.
 *
 * WHAT STILL DIFFERS, AND ONLY THIS — because it is what the two surfaces may SAY:
 *   * The figure. Signed in it is the PRICE; here it is the published documents quota, which is
 *     the largest true number this page owns. A price-shaped slot holding «—» on a public page
 *     would be a page about a price it refuses to give.
 *   * There is NO ACTION on a row. A "בחרו מסלול" button would be a selection control for a
 *     selection that does not exist — the same reason `OrgSubscriptionPanel` renders no purchase
 *     affordance at all (#217/#224). The single CTA under the list opens an account, which is the
 *     one thing a visitor can actually do, and it keeps #203's approved wording. Every row lacks
 *     it equally, so no row is left 44px short of its neighbours.
 *   * There is no "מדרגה מעל / מתחת" chip. A stranger holds no rung, so there is nothing to be
 *     above or below.
 *
 * THE TABLE'S ONE REAL VIRTUE WENT WITH IT AND CAME BACK BETTER. It existed to compare every
 * quota across every plan, and it did that inside a `overflow-x-auto` box that needed `tabIndex`
 * and a `role="region"` name just so a keyboard could reach the columns a phone could not show.
 * Each rung carries the identical entitlements — every key the catalogue returns, in the
 * catalogue's own order, with `—` wherever nothing is measured — laid along its own row, and the
 * rungs stack instead of scrolling sideways. The scroll trap is not fixed; it is gone.
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
 * One wrapper for all three states. They each used to render their own outer element and only two
 * of them agreed: the loader returned a bare centred spinner with no `main`, no max width and no
 * vertical padding, so the whole page jumped — a different width, a different top offset and a
 * landmark appearing from nowhere — at the moment the catalogue landed. One constant, three
 * bodies, and a spec that compares the states to each other rather than to a literal width.
 */
const PAGE_WRAPPER = 'mx-auto max-w-6xl space-y-6 px-4 py-12';

export default function Pricing() {
  const { t } = useT();
  const { planName, quotaName, featureName } = usePlanCatalogue();
  const [state, setState] = useState<{
    catalogue: PlanRow[];
    quotas: QuotaRow[];
    features: PlanFeatureRowData[];
    error: string | null;
    loading: boolean;
  }>({ catalogue: [], quotas: [], features: [], error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalogue, quotas, features] = await Promise.all([
        supabase.rpc('get_public_plan_catalogue'),
        supabase.rpc('get_public_plan_quotas'),
        supabase.rpc('get_public_plan_features'),
      ]);
      if (cancelled) return;
      if (catalogue.error || quotas.error || features.error) {
        setState({ catalogue: [], quotas: [], features: [], loading: false,
          error: t('pricingTail.loadFailed') });
        return;
      }
      setState({
        catalogue: (catalogue.data ?? []) as PlanRow[],
        quotas: (quotas.data ?? []) as QuotaRow[],
        features: (features.data ?? []) as PlanFeatureRowData[],
        error: null,
        loading: false,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * One card per plan, in the server's tier order. The catalogue lists each plan once per
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

  const quotaOf = (planKey: string, key: string) =>
    state.quotas.find((entry) => entry.plan_key === planKey && entry.entitlement_key === key);
  const quotaLabel = (key: string) =>
    quotaName(key, state.quotas.find((row) => row.entitlement_key === key)?.label ?? key);

  /**
   * A quota as one feature row. Unmeasured is the honest state of `users.max` and `suppliers.max`
   * today (DEBT §56): we do not publish, and therefore do not promise, a number nothing enforces.
   * It renders `—` and wears the dash glyph rather than a tick, because a check mark asserts that
   * the rung includes something and this row asserts nothing at all. Never `0`.
   */
  const featureRow = (planKey: string, key: string): PlanTicketFeature => {
    const row = quotaOf(planKey, key);
    const label = quotaLabel(key);
    if (!row || !row.measured || (!row.unlimited && row.numeric_limit === null)) {
      // Same shape as a measured row — value then label — so a column of rows stays a column.
      // No colour class of its own: the row already wears the card's tone, and a hardcoded
      // `text-ink-muted` here would be invisible on the inverted fill.
      return { key, text: <><span>—</span> {label}</>, affirmative: false };
    }
    if (row.unlimited) return { key, text: t('pricingTail.unlimitedFeature', { label }), affirmative: true };
    return {
      key,
      text: <><span className="num font-medium">{fmtNum(row.numeric_limit)}</span> {label}</>,
      affirmative: true,
    };
  };

  const hasUnmeasured = state.quotas.some((row) => !row.measured);

  /**
   * THE TITLE IS NOT DATA, so it is never a placeholder and never absent. It was inside the loaded
   * branch alone, which meant the loading state had no heading at all: the page opened with an
   * empty band, the `h1` appeared when the catalogue landed, and everything below it moved down by
   * its height. Written once, rendered by all three states.
   */
  const header = (
    <header className="space-y-2">
      <h1 className="page-title">{t('pricingTail.title')}</h1>
      <p className="text-ink-body">{t('pricingTail.subtitle')}</p>
    </header>
  );

  /**
   * AND NEITHER IS THE AVAILABILITY NOTICE, which is why it is painted while the catalogue is still
   * in flight rather than faked or withheld. It is fixed prose: it states #208's currency rule and
   * the owner's ruling that no amount reaches a public surface, neither of which depends on a row
   * coming back. Every word of it is as true before the RPC answers as after.
   *
   * It is also, measurably, the block that was still moving the page. With the title alone held in
   * place the ladder began 90px higher while loading than it did once the notice arrived (135px vs
   * 225px at 1280); painting it here takes that to 0. Nothing below the ladder is hoisted with it —
   * a block that appears BELOW the reader's content extends the page, it does not shove it.
   */
  const notice = (
    <Note tone="info">
      <span className="min-w-0 flex-1">
        {t('pricingTail.notice')}
      </span>
    </Note>
  );

  /**
   * NO SPINNER (owner ruling 26.08.2026: «אם יש לי כבר שלד אין צורך בסמל הזה»). `PageLoader` was a
   * centred figure with `py-24` and nothing under it, so this page discarded the full height of the
   * ladder while it loaded and everything jumped into place at once when the catalogue arrived.
   * `PlanLadderSkeleton` is the ladder's own geometry, from the file that owns the row.
   *
   * FOUR ROWS AND NO ACTION BAR, because that is what THIS page resolves into: #194 keeps `ביזנס`
   * off the public catalogue, and these cards carry no action at all — a fifth row or an action
   * slot would be a placeholder for something the loaded page never shows.
   */
  if (state.loading) {
    return (
      <main className={PAGE_WRAPPER}>
        {header}
        {notice}
        <PlanTicketSkeleton rows={4} action={false} testId="pricing-skeleton" />
      </main>
    );
  }
  if (state.error) {
    return <main className={PAGE_WRAPPER}>{header}<ErrorNote message={state.error} /></main>;
  }

  return (
    <main className={PAGE_WRAPPER}>
      {header}

      {notice}

      <ul data-testid="plan-cards" className={PLAN_TRAY}>
        {plans.map((plan) => {
          const headline = quotaOf(plan.plan_key, HEADLINE_QUOTA_KEY);
          const measured = !!headline && headline.measured;
          const capabilityRows = state.features
            .filter((row) => row.plan_key === plan.plan_key)
            .sort((a, b) => a.display_order - b.display_order)
            .map((row): PlanTicketFeature => ({
              key: row.entitlement_key,
              text: row.plan_key === 'free' && row.intro_included && !row.included
                ? t('pricingTail.entitlementIntroOnly', { label: featureName(row.entitlement_key, row.label) })
                : featureName(row.entitlement_key, row.label),
              affirmative: row.included || (row.plan_key === 'free' && row.intro_included),
            }));
          return (
            <PlanTicket
              key={plan.plan_key}
              planKey={plan.plan_key}
              label={planName(plan.plan_key, plan.label)}
              /* THE FIGURE SLOT HOLDS THE QUOTA, NOT A PRICE, and the line under it says so. This
                 page publishes no amount (owner decision 25.08.2026 / #267), so the largest true
                 number it owns takes the slot the card reserves for its biggest figure. A
                 price-shaped slot holding «—» would be a page about a price it refuses to give.

                 The label moved from a slot of its own into `.plan-card__billed` when the card was
                 re-transcribed on 31.08.2026: the marketing site's card has no label ABOVE its
                 figure, and inventing one here would be the product growing a second opinion about
                 a design it does not own. The quiet line under the figure is where that card puts
                 the sentence about what the figure is, and «מסמכים בחודש» is exactly that. */
              who={quotaLabel(HEADLINE_QUOTA_KEY)}
              figure={!measured ? '—'
                : headline.unlimited ? t('pricingTail.unlimited')
                  : fmtNum(headline.numeric_limit)}
              figureIsWords={!measured || headline.unlimited}
              term={measured && !headline.unlimited ? t('pricingTail.perUsagePeriod') : undefined}
              /* The badge, and ONLY from the shared presentation file. #202 forbids an emphasis
                 keyed to the reader, and a stranger holds no rung to be keyed to in the first
                 place; this is the one static mark, identical for everyone, and it is the same
                 mark the marketing site prints (owner ruling 27.08.2026: «תיישר לפי הדף נחיתה»). */
              badgeLabel={plan.plan_key === RECOMMENDED_PLAN ? t('pricingTail.recommended') : undefined}
              /* No action on a card. A "בחרו מסלול" button would be a selection control for a
                 selection that does not exist (#217/#224) — the single CTA under the list opens an
                 account, which is the one thing a visitor can actually do. Every card lacks it
                 equally, so no card is left short of its neighbours. */
              /* Every remaining entitlement the catalogue returns — the comparison the table used
                 to hold, one plan at a time and with no sideways scroll to trap a keyboard.
                 The list carries no heading of its own since the 31.08.2026 re-transcription: the
                 marketing site's card runs its rows straight off the rule under the figure, and a
                 heading here would be a row the other surface does not have. */
              features={quotaKeys
                .filter((key) => key !== HEADLINE_QUOTA_KEY)
                .map((key) => featureRow(plan.plan_key, key))
                .concat(capabilityRows)}
            />
          );
        })}
      </ul>

      <p className="text-sm text-ink-muted">
        {t('pricingTail.quotaPeriod')}
      </p>
      {hasUnmeasured && (
        <p className="text-sm text-ink-muted">
          {t('pricingTail.unmeasuredNote')}
        </p>
      )}

      <Link className="btn-primary" to="/signup">{t('pricingTail.openFreeAccount')}</Link>
    </main>
  );
}
