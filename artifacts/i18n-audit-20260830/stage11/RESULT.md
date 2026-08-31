# Stage 11 — the plan badge, and the two label families behind it

Owner, 31.08.2026: *"the subscription badge — if it's in English then it should be written in
English too."* That closes `OPEN-DECISIONS #303`, which had been left open with three ways out.

## What was measured first

The badge is `PlanBadge`, worn in the header. Read back from the running app under `lang="en"`:

```
badge chip="פרימיום"   aria="My subscription — פרימיום"
```

And it was never only the badge. The same wording is printed on two whole screens:

| screen | Hebrew strings on an English page |
|---|---|
| `/settings/subscription` | **32** — `The פרימיום plan was given…`, `Move to חינם`, every quota row |
| `/pricing` | **23** |

## Three families, not one — and all three have a machine key

| database column | keyed by | rows |
|---|---|---|
| `subscription_plans.label` | `plan_key` | 6 |
| `private.entitlement_definitions.label` | `entitlement_key` | 20 |
| `private.plan_feature_presentation.public_label` | `entitlement_key` | 11 |

The third is the same key said differently, because a plan card sells a capability and a quota row
names a limit: `org.multi_unit` is «ריבוי יחידות» in the definition and «עד 10 סניפים» on the card.
Two maps, because the database keeps two columns on purpose.

**Because every row already has a stable machine key, this needed no migration** — no `label_en`
column, no language added to the schema, no migration per new rung. `usePlanCatalogue()` resolves
the key against the dictionary, exactly as `status.ts` already does for statuses, roles, credit
reasons and exception types.

## The cost of that route, paid rather than denied

`#303` named it: *"a new plan needs code, not just a row."* So an unmapped key **falls back to the
label the server sent**. A plan seeded by a future migration appears on screen in Hebrew rather
than vanishing or printing its own key at a customer. It degrades to today's behaviour.

## The guard, and the drift it caught on its first run

Moving wording into the dictionary creates a second copy of what the database holds — the exact
failure `PlanBadge` already documents for `TIER_CLASS`: *"this table used to exist twice, and the
two copies had already drifted."* `scripts/check-plan-labels.mjs` parses the seeding migrations and
fails when a Hebrew entry no longer matches its row.

**It found a real one immediately, and then a second one in itself:**

1. First run: three plans mismatched. The bug was in the guard — `0184` renames plans through
   `update … from (values (key, tier_order, label))`, a different column order from the insert it
   was matching, so it was comparing against `0154`'s original English seed.
2. Once fixed, it reported `ocr_pages.monthly`: **database «עמודי סריקה בחודש», dictionary «עמודי
   OCR בחודש»**. `0251` had renamed that quota away from the word OCR — an owner decision of
   28.08.2026 about what customers are told a quota is called — through an `update … set label`,
   which the guard could not see either. Without it the English side would have shipped
   *"OCR pages per month"* and quietly reversed that decision on one screen.

Both parser shapes are now covered, with the reason written at each pattern.

## Result

| | before | after |
|---|---|---|
| badge chip | `פרימיום` | **`Premium`** |
| badge accessible name | `My subscription — פרימיום` | **`My subscription — Premium`** |
| `/settings/subscription` | 32 Hebrew strings | **3** — the demo user's own name and business name |
| `/pricing` | 23 | **0** |

Hebrew is unchanged word for word — `subscription-he.png` beside `subscription-en.png` is the pair
worth looking at. That is not a hope: `check:plan-labels` pins all 37 Hebrew strings to the rows
they mirror, and the 59 existing tests on these three screens pass untouched *because* their
Hebrew fixtures still read the same.

## What was deliberately NOT changed

- **The cancel dialog's usage rows.** `organization_usage_snapshot()` returns its own shorter
  labels («מסמכים», not «מסמכים בחודש») from a different source. Mapping them to the definitions
  would have silently reworded the Hebrew screen. A fourth family, left alone.
- **`"1 Branches"` and `"1 Active users"` on the plan cards.** A real defect, and **pre-existing in
  both languages** — the Hebrew screenshot reads `1 סניפים` in the same place. These are composed
  as `{number} {label}` rather than as a counted `t()` phrase, so `check:plurals` cannot see them
  and its pinned 48 do not include them. Fixing it needs a count-aware resolver plus `_one` siblings
  for the countable quotas, in both languages. Out of scope here; worth its own change.
- **The operator console.** It reads the same labels and is an internal Hebrew surface.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` green, now
including `check:plan-labels` (37 labels) · Vitest **1963/1967**, the four failures being the same
`Test timed out in 5000ms` workbook and reliability specs, which pass 44/44 in isolation.

Two documented principles said the opposite of what the code now does — `PlanBadge`'s "the Hebrew
rung names live in `subscription_plans` and not in this file" and its spec's "a local map of rung
names would be a second catalogue". Both are rewritten in place to record the change and to say
why the objection is now answered rather than ignored.
