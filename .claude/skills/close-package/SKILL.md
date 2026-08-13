---
name: close-package
description: Close a work package — run the local check, update PROGRESS.md and DEBT-REGISTER.md, and prepare the commit. Use when a package, wave or campaign step is finished.
disable-model-invocation: true
---

# Closing a package

Packages 1, 2, 5, 6 and 7 each ended with the same ritual, and each time a step was done from
memory. The steps that get skipped are always the documentation ones — which is why
`docs/DEBT-REGISTER.md` exists at all. Repository counts are intentionally not copied into prose.

Work through this in order. Do not batch, do not reorder, and do not report a step as done that
you did not run.

## 1. Establish what actually changed

```
git status --porcelain
git diff --stat
```

Name the package out loud before continuing: what it set out to do, and what of that shipped. If
part of the scope did not ship, that is not a failure to hide — it is a DEBT-REGISTER row in
step 4.

## 2. Run the gate and read its output

```
npm run check
```

That is the production build plus `verify` (Knip, the four narrow static guards and the shared
Vitest runner). The heavy integration gate is separate in CI.

- **Green** → continue.
- **Red** → stop. Fix, re-run, and do not proceed to the documentation steps with a red gate. A
  package closed on a red gate is not closed.
`npm run quality` is the Windows-coupled integration implementation and is not part of ordinary
local work. Trigger `quality-gate.yml` in GitHub when integration evidence is required; its path
classifier starts only the relevant contracts, SQL and browser jobs. A skipped job is not a PASS.

## 3. Update `docs/PROGRESS.md`

Add a section at the **top** of the log, following the existing shape:

```
## <what closed> (<DD.MM.YYYY>) — <gate state; deployment state>
```

Absolute dates, never "today" or "last week". State three things:

- What now works that did not work before, in the user's terms.
- The gate state as a fact: which gate ran, when, and its result.
- What is deliberately still open, with a pointer to the DEBT-REGISTER row.

Do not claim a visual change works without a screenshot, and do not claim a feature works without
having exercised it. An unverified claim here is worse than no claim: the next agent builds on it.

## 4. Update `docs/DEBT-REGISTER.md`

Two directions, both required:

- **Added:** anything this package deferred, worked around, or discovered and did not fix. Each
  row needs *what* (the fact, unsoftened), *why it was deferred*, *where the evidence is*, and
  *the next cheap step*.
- **Drained:** anything this package actually fixed. Find the row, mark it resolved, and point at
  the commit or test that proves it. A debt row that stays open after its fix shipped sends the
  next agent to redo the work.

## 5. Check for shell junk before committing

```
git status --porcelain
```

Files named `$p`, `{`, `0)`, `` `${c.id} `` are redirect artifacts, not work. Delete them:

```
rm -f -- '<name>'                      # Git Bash
Remove-Item -LiteralPath '<name>'      # PowerShell
```

## 6. Prepare the commit

Message in English, body in the repo's existing voice: what changed and why, not a file list.
Reference the package number.

**Do not commit or push without being asked.** Show the message, show `git status`, and stop.

## Report

Close with a short, factual summary:

- Gate: which one ran, when, result.
- PROGRESS.md: what was added.
- DEBT-REGISTER.md: rows added / drained.
- What is left open, and why.

If any step was skipped, say which and why. A close that omits a step and does not say so is the
thing this skill exists to prevent.
