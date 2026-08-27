# Subscription plan depth tree

Branch: `codex/subscription-plans-20260827`

## 1. Establish current truth

- [x] 1.1 Trace decisions `#195`, `#198`, `#199`, `#266`, `#267`, `#274`, and `#276` into migrations, RPCs, and UI consumers.
- [x] 1.2 Identify the exact missing forward-only migration and the next free migration number.
- [x] 1.3 Record which prices and benefits are currently visible on authenticated and public surfaces.

Evidence snapshot, 27.08.2026:

- `0184` seeds the price catalogue and the old `#196` all-capabilities-open invariant; `0208` applies the final 20/40/150/375 document quotas; `0202` applies assistant quotas and the existing 30-day timestamp. No migration implements `#274/#276` capability gating. The next free version in this branch is `0213`.
- `get_public_plan_quotas()` returns numeric per-period quotas only. No server read model returns the decided capability ladder or the introductory Basic capability grant.
- `/settings/subscription` renders the document quota only. It renders a numeric price only after `private.organization_billing_country` contains a verified country, but that writer has no production caller; otherwise it says the price is supplied during upgrade.
- `/pricing` deliberately hides every price per `#267` and still states the superseded `#196` sentence that all capabilities are open.
- Six boolean entitlement keys exist, but repository search finds no product consumer. Turning their catalogue values off without server-side consumers would change what the catalogue says, not what a direct request may do.

## 2. Close database contract

- [ ] 2.1 Add one forward-only migration; never edit applied migrations.
- [ ] 2.2 Seed documented capability decisions and enforce a monotonic plan ladder.
- [ ] 2.3 Reuse the existing introductory-window timestamp; do not create a second clock.
- [ ] 2.4 Add focused SQL regression coverage and register it in the canonical SQL suite list.

## 3. Close application catalogue

- [ ] 3.1 Extend the existing server read model instead of duplicating prices or benefits in TypeScript.
- [ ] 3.2 Show each plan's benefits and authenticated, billing-country-authoritative prices in `/settings/subscription`.
- [ ] 3.3 Keep `/pricing` price-free before launch per decision `#267`.
- [ ] 3.4 Add focused component/page regression coverage.

## 4. Verify and hand off

- [ ] 4.1 Run focused contract, UI, SQL, verify, and build gates.
- [ ] 4.2 Capture authenticated desktop/mobile visual evidence.
- [ ] 4.3 Review final diff, status, and exact SHA boundaries; report implementation and deployment states separately.
