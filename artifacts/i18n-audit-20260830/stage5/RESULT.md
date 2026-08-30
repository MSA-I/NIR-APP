# Stage 5 — result

Plan: `docs/PLAN-english-completion-20260830.md`.

No screenshot comparison for this stage, and that is not an omission: everything here is on a
**failure path**, which a page-load audit cannot reach. The oracles that can see it are the gates,
and all eight of them are now green — including the one that says the phase is over.

## What was wrong

`src/lib/errors.ts` maps a raw Postgres string onto a sentence a business owner can act on. Most
rows in `PATTERNS` pair a pattern with a dictionary **key**. Ten did not: the currency and plan
campaigns added their refusals as raw Hebrew **sentences**, so those ten failures read in Hebrew
whatever the reader had chosen — including the four the campaign existed to make actionable.

`toleranceRefusalMessage` had the same shape: it chose *which* refusal by capability and then
returned the words, because the module has no locale. But the caller has one, and the decision the
function actually makes is which refusal, not which wording.

## What changed

- **Twelve `errors.*` keys** written in both languages — ten refusals plus the two halves of the
  tolerance message, whose wording depends on whether the reader can reach the settings field that
  fixes it. Two more (`plan_limit_unknown`, `document_scan_recovery_unavailable`) already had keys
  with those exact values and simply needed the pattern to name the key instead of repeating the
  sentence.
- **`toleranceRefusalMessage` → `toleranceRefusalKey`.** `Bank.tsx` resolves it through
  `tDynamic('errors.…')` and composes the surrounding note from `bank.toleranceRefusal`.
- **Nine product call sites in four files** moved from `toHebrewError` to `useT().errorText` —
  `DocumentLineMapping`, `Expenses`, `AcceptOperatorInvite`, `PriceListUpload`. The last one is the
  module-level twin of a call that already did it right on the line below; it takes the caller's
  resolver now, the same way it already took `t`.

`errors.ts` carries no Hebrew outside comments. Baseline **968 → 951** across **63 → 62** files.

## `toHebrewError` still exists, and the plan said to delete it

Deliberate. Sixty-four call sites sounded like the substance of this stage; the measurement said
otherwise. Fifty-five are **specs**, which assert the Hebrew wording on purpose — a test that read
the sentence out of the dictionary would pass against a broken dictionary. Two are the **operator
console**, which the owner decided on 27.08.2026 is not translated, so a Hebrew-only failure
sentence is the right answer there rather than a screen left behind.

Deleting the export would have churned 55 spec files and taken something correct away from the
operator console, for no reader-visible gain. What the plan actually wanted — *no reader-facing
surface resolves failures in a fixed language* — is what the gate measures, and it is at **0**.

## Three gates were already red before this stage, and nobody could see them

None of `scripts/gate-i18n.mjs` is part of `npm run verify`, so these had been failing unnoticed.

- **`legacy-errors`** sat at 2 against a pin of 1 — a second operator call had been added. But the
  gate counted `src/operator/`, which contradicted its own sentence ("how many PRODUCT sites"). It
  now skips the operator console with the reason written in, and is pinned at **0**.
- **`extracted`** reported eleven surfaces as offenders because they correctly keep an audit reason
  in Hebrew. It judged a documented file on its count instead of on whether its reason exists, which
  made it contradict the baseline it reads. Documented files are now judged on the reason;
  undocumented Hebrew still fails, which is the case the gate is for.
- **`abandon`** wanted an `ABANDON: P2-G4` line in `GATES.md`. The owner's decision was live in the
  baseline and in `DEBT-REGISTER.md` while `GATES.md` still said no gate had been abandoned. The
  line is written now, and says why it is recorded in three places.

## Two holes the gates found that this stage then closed

- **Two product-help topics had no English row** — `add_a_supplier` and
  `update_supplier_bank_details`, both added by the 27.08.2026 supplier work on the Hebrew side
  only. An English speaker asking either question got Hebrew back. Both are written now; all 26
  topics pair.
- **Four operator files carried the owner's decision without stating it** — `Overview`, `Team`,
  `UserDetail`, `Users`, written after the other twelve were documented. This was Stage 9.2 of the
  plan; doing it here is what let the last oracle go green.

## All eight oracles

```
ratchet               GATE_I18N_RATCHET_OK
extracted             GATE_I18N_EXTRACTED_OK
dictionaries          GATE_I18N_DICTIONARIES_OK
abandon               GATE_I18N_ABANDON_OK
help-registry-paired  GATE_I18N_HELP_PAIRED_OK
currency-untouched    GATE_I18N_CURRENCY_UNTOUCHED_OK
legacy-errors         GATE_I18N_LEGACY_ERRORS_OK
zero                  GATE_I18N_ZERO_OK
```

**`zero` is the end-of-phase oracle**, and its own comment explains why it is not the ratchet: the
ratchet passes while thousands of Hebrew lines remain, so a gate titled "everything is extracted"
that ran the ratchet would have reported the phase complete on its first day. It now reads
*"nothing left to extract; 62 documented exception(s) remain pinned"*.

That is the project's own statement that the extraction campaign is finished. It is not a statement
that the product is fully English — see what remains, below.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed · Vitest
**1952/1952**, green for the first time in this session; the timeouts of stages 1–4 were the machine
load, as measured, and they are gone.

## What is left, and it is not extraction

- **Stage 6** — `fmtMonth` pinned to `he-IL`, still putting `אוגוסט 2026` on two chart axes, the
  `/reports` month picker and the printed accountant heading. One line, four screens.
- **Stage 7** — the counted phrases that need a variable and a plural rule.
- **Stage 8** — three owner decisions about Hebrew that lives in the DATABASE: exception and alert
  titles, plan names and entitlement labels, audit-log display. The eleven strings still on
  `/settings/subscription` and `/pricing` are entirely this, and no amount of extraction will move
  them.
- **Stage 9** — the orphan-key guard, and wiring `gate-i18n.mjs` into something that runs. Three of
  its eight oracles were red for days precisely because nothing runs them.
