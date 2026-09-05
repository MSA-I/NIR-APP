/**
 * The organisation VAT rate, resolved in ONE place.
 *
 * WHY THIS FILE EXISTS. The 2026-09-04 sweep was able to put three different VAT rates beside
 * each other on one report — the tenant's stored 17.5, the product's fallback of 18, and the
 * 18.00% the supplier documents print — and the middle one was not a single value at all. It was
 * FIVE independent copies of the digits `18`, written out in four screens: the settings form, the
 * onboarding form, the platform-admin new-organisation form, and twice in the invoice form (once
 * to compute with, once to print in a label). Nothing tied them to each other, and nothing tied
 * any of them to the decision they were all restating.
 *
 * THE RATE IS NOT DECIDED HERE, and this file must never be read as deciding it. It is recorded
 * in `docs/OPEN-DECISIONS.md` under **שיעור מע״מ** — 18%, current for Israel 2026, with amounts
 * stored per invoice so that changing the rate later cannot rewrite what was already issued — and
 * it is enforced by the database, where `organizations.vat_rate` has carried `default 18.00`
 * since the first migration (`0001`). The constant below mirrors that column default the way
 * every constant in `inputBounds.ts` mirrors the server check it stands for. It is deliberately
 * cited by title rather than by decision number: that row predates the `#NNN` series and a `#`
 * citation of it would point at nothing.
 *
 * WHAT IT DOES NOT DO. It does not correct a rate an organisation actually carries. A tenant
 * whose row says 17.5 gets 17.5 from `organizationVatRate`, on every screen, because the value
 * stored against that organisation is the owner's answer and not this repository's — the rate a
 * business charges is a claim about the law and about that business. Making the two agree is a
 * change to that one row, made where the decision record says it is made: הגדרות ← שיעור מע״מ.
 */

/**
 * The rate an organisation is treated as having when its own row does not say.
 *
 * Mirrors `organizations.vat_rate`'s column default in `0001`. It is a FALLBACK, not a policy:
 * the column is `not null`, so a live organisation always has a rate of its own and this value is
 * reached only by a screen holding a partial organisation object — during onboarding, on the
 * platform-admin form that creates one, or before the row has loaded.
 */
export const VAT_RATE_DEFAULT = 18;

/**
 * The VAT rate to use for an organisation, given whatever its row says.
 *
 * `??` and never `||`, and the difference is a real tenant: an organisation configured at 0% is
 * carrying a rate, not missing one, and `||` would quietly serve it 18% on every invoice form.
 */
export function organizationVatRate(rate: number | null | undefined): number {
  return rate ?? VAT_RATE_DEFAULT;
}
