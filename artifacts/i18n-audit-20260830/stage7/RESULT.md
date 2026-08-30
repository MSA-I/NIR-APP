# Stage 7 — result

Plan: `docs/PLAN-english-completion-20260830.md`.

## The plan said seven. It is 72.

Stage 7 was scoped from what the audit caught: seven counted phrases with no key at all. Measuring
the class properly gives a different number — **112 English keys interpolate `{count}`, and 72 of
them put it straight in front of a bare plural noun**, so they read `1 suppliers`, `1 items`,
`1 rows`, `1 transactions`. Most predate this work; they came over with the English branch.

Five of the plan's original seven had already been given `{count}` keys in Stage 3 as a side effect
of wiring their screens. What none of them had was a singular.

## The mechanism, not seventy-two special cases

`src/lib/i18n/t.ts` opens with a deliberate refusal: *"interpolation is `{name}` and nothing else —
no ICU"*, because an ICU plural puts a language rule inside a translation file. That reasoning still
holds, so this does not add ICU. It adds a **sibling key**:

`t()` now reaches for `<key>_one` when `vars.count` is a number and the locale's plural category for
it is `one`. A key with no sibling is untouched, which is what makes the change additive — the 40
keys that render `Orders ({count})` and the sentences that read fine at one are unaffected.

Binary on purpose. Hebrew has one/two/many/other, and this handles `one` only — which is exactly
what the three hand-rolled sites this generalises already do (`supplierGroupCard.itemOne`,
`uiTail.recordOne`, `Invoices.countKey`). Making it four forms is a decision about copy, not
something a mechanism should settle by itself.

`translate` and `tryTranslate` take the locale now; `LocaleProvider` and `translateIn` pass it.

## What was converted, and what is pinned

**24 of the 72** — every counted phrase that renders on the 44 audited screens: the suppliers list
meta, the dashboard's open-invoice count and its aria-label, the payment-request page meta and its
three severity counters, the accountant queue, products, exceptions, reports, bank import, the
consolidated page counts, and the four `lineMapping` sentences written in Stage 4.

**48 are pinned.** `scripts/check-plurals.mjs` counts them and fails in both directions, like
`check:i18n`: a new one is a regression, and converting one without lowering the pin is a stale
baseline. It is wired into `npm run verify` — unlike `gate-i18n.mjs`, three of whose oracles had
been red for days precisely because nothing ran them.

`gate-i18n.mjs plurals` delegates to it rather than parsing the dictionary a second time, for the
same reason `ratchet` delegates to `check-i18n.ts`.

## A spec was holding the defect in place

`productNameReview.spec.tsx:298` asserted `1 שמות ממתינים לתיקון ממקור` — the plural, read at a
count of one. It was pinning the bug rather than catching it. It now asserts
`שם אחד ממתין לתיקון ממקור`, and the failure that surfaced it is the mechanism working: the suite
went red the moment the sentence started agreeing with its number.

Two new specs in `t.spec.ts` cover the mechanism itself — that the sibling is reached at one and
only at one, in both languages; that a key without one is untouched; that a `{count}`-free key pays
nothing; and that every `_one` has a base key it can be reached from, which the compiler cannot see.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, now
including `check:plurals` · Vitest **1953/1954**, the one failure being `p2Reliability` at
`Test timed out in 5000ms`, which passes in isolation.

## Honest scope note

No screenshot comparison: a counted phrase only differs at exactly one, and the seeded demo data
does not put a `1` in front of most of these. The oracles are the spec and the ratchet, and the
`_one` values themselves are copy — they are right or wrong by reading, not by measurement.

The 48 that remain are a known, counted, guarded debt rather than an unknown one. Lowering that pin
is now a one-line change per phrase, in both dictionaries, with no call site to touch.
