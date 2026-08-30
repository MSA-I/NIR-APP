# Stage 8 — result

Plan: `docs/PLAN-english-completion-20260830.md`. No code changed in this stage, deliberately: it
is the one stage whose work is a decision, not an edit.

## The plan said three decisions. Two are real; the third was answered by measuring it.

`docs/OPEN-DECISIONS.md` now carries **#302**, **#303** and **#304**.

### #302 — exception and alert titles written by the database (OPEN)

`exceptions.title` is written in Hebrew by four migrations that create exceptions;
`notifications.title` likewise by the alert generators — `0142` is the clearest, writing
`עיבוד המסמכים אינו מתקדם` and the paragraph under it.

Half the mechanism is already built: all eight exception types have `exceptionType_*` keys in both
dictionaries, which is why `/reports` prints `Possible duplicate invoice — חשד לחשבונית כפולה —
בשר והבן #7702` — English type, Hebrew stored title.

The decision to make is whether a stored title is **evidence** (stays as written; the screen leans
on the translated type) or **display** (the generator stores `type` + parameters and the screen
composes the sentence). The second is expensive and not quietly reversible: it needs a migration
over existing rows, and it takes away the generator's ability to write a detail no key covers.
Default recorded: **evidence**, because an exception is a historical record someone already read
and acted on, and rewording it afterwards changes what the next reader thinks was written.

### #303 — plan names and entitlement labels (OPEN)

Six rows in `subscription_plans.label` and **twenty** in `private.entitlement_definitions.label`,
all Hebrew. **This is the entirety of what is left on `/settings/subscription` and `/pricing`** —
the same eleven strings on both screens, after Stage 4 translated everything the code holds. The
reader sees `The פרימיום plan was given to this organisation…` and `Move to חינם`.

Three routes are recorded with their prices: a `label_en` column, a `label_key` the screen resolves
against the dictionary (consistent with `EXCEPTION_TYPE` and `status.ts`), or accepting that the
Hebrew word is the product's name and is not translated, like a supplier's name.

The third has a complication worth stating, and it is recorded in the decision: **`#295` already
settled that English shows the USD catalogue**, so this screen already changes *numbers* by
language. "A plan name is a name, not a translation" has to stand against the price beside it
changing.

### #304 — the audit log (CLOSED, and the finding that closed it was mine)

The audit recorded `/supplier-log` as *"26 hardcoded, 47 Hebrew strings"* and I wrote in FINDINGS.md
that *"today the reader cannot read their own audit trail"*. **Measuring the screen directly after
Stage 6 gives six Hebrew strings in total, and four of them are supplier and product names.**

`SupplierLog.tsx` already maps every `audit_logs.action` value to a dictionary key, so rows read
`Created · <product> · <supplier>`. What stays Hebrew is the stored `reason`, and that is not an
open question — the iron rule in `HANDOFF-english-language-20260827.md §9` already answers it.

There was no decision here. The original number was the loose classifier counting tenant data, and
the sentence I wrote from it overstated the problem.

## What this stage did not do

No screenshots, no dictionary keys, no migration. Both open decisions are the owner's, and
implementing either before it is made would be exactly the "quiet guess in code" that
`OPEN-DECISIONS.md:3` forbids.

Both are recorded with a default that ships today, so nothing is blocked while they wait.

## Where that leaves the eleven strings

`/settings/subscription` and `/pricing` will keep showing eleven Hebrew words until **#303** is
decided. That is not remaining extraction work and no further stage will move it — which is worth
being plain about, because those two screens are the ones a reader would point at first.
