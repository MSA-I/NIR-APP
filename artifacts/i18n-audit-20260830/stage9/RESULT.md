# Stage 9 — result

Plan: `docs/PLAN-english-completion-20260830.md`. The stage that stops this happening again, and
corrects the record that would have sent the next reader the wrong way.

## The guard that was missing

Merge `7278f787` dropped 439 `t()` calls and **nothing in the repository noticed for three days.**
That is the defect this stage exists for, and it is worth naming why each existing check was blind:

- **`check:i18n` could not see it.** It is a ratchet on the *count of Hebrew lines*, and that count
  went **up** at the merge. The pin was updated with the command the guard provides for exactly
  that, and the guard was satisfied.
- **`tsc` could not see it.** An object property nobody reads is not an error.
- Nothing measured the gap between *"the key exists"* and *"something asks for it"*.

`scripts/check-orphan-keys.mjs` measures that gap: 5,530 leaf keys in `he.ts`, **145 with no call
site**, pinned. It fails when the number goes **up** — which is precisely the moment a screen stops
asking for a key — and when it goes down without the pin following.

What it deliberately cannot see is written into the file: `status.*` and `errors.*` resolve by
template so a literal search finds none of them and they are excluded by name rather than reported
as 254 false orphans; specs count as call sites, because a key a test reads is not orphaned in the
sense that matters; and `_one` siblings are reached by `t()` itself, never by a literal. It also
carries a positive control — if more than half the dictionary looked unreachable, the check would
be broken rather than the dictionary, and it says so instead of reporting a catastrophe.

**Both new ratchets are in `npm run verify`.** That is the second half of the lesson: `gate-i18n.mjs`
has nine good oracles and is part of nothing that runs, which is how three of them stayed red for
days while the register and the baseline said the decision they check had been made.

## The record, corrected

**`DEBT §84` was wrong in the direction that creates duplicate work.** It said the extractor "never
saw" 91 files and named `scripts/extract.mjs` as the cheap next step. Extraction *had* run and the
dictionary already held the English — an agent following that entry would have generated a second
set of keys beside translated ones. It is rewritten with the measured mechanism, closed for
extraction, and it now points at the two ratchets and at `#302`/`#303` instead of at the extractor.
The register's header line says the same in one sentence, because that is the line people read.

`docs/PROGRESS.md` carries the campaign: how it started, the finding that changed the work, the
eight stages, what was measured, and — at the same length — what was **not** done. No heavy gate, no
deploy, no live smoke, no migration; one role; default screen states only; and the local database
moving `0241 → 0245` mid-session, which is why two screens measured broken in Stage 1 and working in
Stage 3.

## All nine oracles

```
ratchet · extracted · dictionaries · abandon · help-registry-paired
currency-untouched · legacy-errors · zero · plurals
```

`zero` reads *"nothing left to extract; 62 documented exception(s) remain pinned"*.

## Where the campaign ends

| | at the baseline | now |
|---|---:|---:|
| Hebrew lines in product source | 1,387 across 91 files | **951 across 62**, every one documented |
| screens with no hardcoded Hebrew | 8 of 44 (all signed-out) | **24 of 44** |
| dictionary keys with no call site | 462 | **145**, pinned |
| counted phrases reading "1 items" | 72 | **48**, pinned |

**What is still Hebrew on an English screen is no longer extraction work.** Eleven strings on
`/settings/subscription` and `/pricing` are plan labels and entitlement labels living in the
database (`#303`); the exception titles are `#302`; and the date picker is Chrome's own and cannot
be reached from here at all.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, now
including `check:plurals` and `check:orphan-keys` · Vitest **1953/1954**, the one failure being
`p2Reliability` at `Test timed out in 5000ms`, which passes in isolation.
