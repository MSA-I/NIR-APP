# Wave 2 — the price parser, the currency the writer never named, and the bidi root fix

## What is in here

| Path | What it is |
|---|---|
| `migration-requests/w2-prices.sql` | **The SQL for the migration owner.** Not a migration; take a number with `npm run next-number -- migration` when you create the file. Every DB change is an anchored patch of the LIVE body, in the `0232` idiom, read as `replace(pg_get_functiondef(...), e'\r','')`. |
| `i18n/w2.json` | 12 keys referenced from code in this wave. `src/lib/i18n/dictionaries/{he,en}.ts` is owned elsewhere, so `t()` reports 5 of them as unknown until they land — see "Known type errors" below. |
| `evidence/bidi-line-order.txt` | The measurement behind the extraction fix: 3/3 damaged catalogue names detected, 0/12 false positives on readable names, 12/12 round trips, 14/15 agreement with the reference Unicode bidi algorithm. |

## The live bodies this was written against

Printed with `pg_get_functiondef`, not read from the migration that created them. Every one of the
five had been renamed or patched since:

| Function | The decisive line, live today |
|---|---|
| `public.p1_import_supplier_prices_internal(jsonb,date,text)` | `insert into supplier_products (org_id, supplier_id, product_id, current_price, price_effective_date, available)` — **no currency column named**, so the `'ILS'` default decides |
| `public.p1b_submit_supplier_price_list_internal(...8 args)` | `v_price_text := regexp_replace(trim(coalesce(v_item ->> 'price_text', '')), '[[:space:]₪,]', '', 'g');` |
| `public.apply_price_list_interpretation_qualified_impl(uuid,uuid,uuid)` | `v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');` |
| `public.run_price_list_shadow(uuid,uuid,uuid)` | same expression |
| `public.get_qualified_product_creation_dry_run(uuid)` | `regexp_replace(btrim(coalesce(v_values->>'unit_price','')),'[^0-9.]','','g')` — the one `[^0-9.]` in the history, **not adopted** |

All 20 anchors in `w2-prices.sql` were verified to match the live body exactly once.

## Verification that was run

- 20/20 anchors match the live body exactly once.
- `npx vitest run src/lib/price.spec.ts` — 15/15.
- `npx vitest run src/lib/price.spec.ts src/lib/productDisplayName.spec.ts src/lib/importSheetI18n.spec.ts src/components/document-review/PriceListReviewConfirmation.spec.tsx` — 54/54.
- `worker/ocr/self_check.py::_line_order_check` executed against the real source — passed:
  `damaged_detected 3/3 · readable_false_positives 0/12 · round_trip 12/12 · word_order repaired`.
- `npm run typecheck` — clean apart from the not-yet-merged i18n keys listed below.

## Verification that was NOT run, and why

- **No SQL suite, no `npm run quality`, no `supabase db reset`.** The local stack is shared and
  those reset it. The migration request has therefore never been APPLIED; its anchors are
  verified, its behaviour is not.
- **No production data was touched.** Repairing the 105 damaged catalogue rows is a separate,
  owner-authorised step and is deliberately not in this package.

## Known type errors, all expected

Five `t()` keys naming entries in `i18n/w2.json` that are not yet in the dictionaries:

```
src/components/document-review/model.ts(620..623)  documents.filing_line_price_{not_positive,below_minor_unit,above_cap,currency_mismatch}
src/components/PriceListUpload.tsx(271)            priceUpload.skipRow_missing_name
```

The seven `priceUpload.reason_*` keys do not appear because `PRICE_REASON_KEYS` is cast at the
call site; they are in the same file and land with the others.

## Rollout consequence, stated up front

`worker/ocr/**` changed AND the gateway contract version moved on both sides
(`worker/ocr/src/gateway.py` and `supabase/functions/document-processing/contract.ts`, `"3"` →
`"4"`). Per the constitution's rollout matrix that means **the VPS is redeployed in the same
rollout**, with `job_claimed` + `job_completed` proven in the log. `Up` is not evidence. Moving the
number on one side only stops document processing silently — the worker keeps running, reports
`Up`, and fails `gateway_contract_mismatch` on every poll while the screen says "waiting in queue".
That is `a3603c0`: five days, zero documents.
