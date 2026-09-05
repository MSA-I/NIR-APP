# Cross-verification brief — gate G13, QA-sweep-20260904

You are a **verifier**. You did not write any of the fixes you are checking, and that is the whole
point: **no agent marks its own work.** Read `.claude/locks/agent-brief.md` first for the machine
rules (git through PowerShell, no `git add -A`, the zero-byte junk sweep, the Hebrew/BOM trap, the
four environment facts). Then read this.

## What `MET` means, and what it does not

A row reaches `MET` only when **you** have seen **both sides**:

1. **GREEN** — the row's oracle passes on the current tree.
2. **RED** — the same oracle **fails** when the fix is taken away.

**A green alone is worth nothing.** It does not tell you whether the fix caused it, whether the
oracle asserts the finding, or whether the test would pass on an empty repository. The red is the
entire evidence. If you only got the green, the row **stays `FIXED`** and you say so.

You must also check the third thing, which is cheap and catches the worst failure:

3. **The oracle actually asserts the finding.** Read the row's "what is wrong" and its oracle
   column, then read the spec. If the test would pass for a reason unrelated to the finding — a
   count that happens to match, an assertion on a string the fix did not change, a locator that
   finds nothing and is therefore trivially satisfied — say so. **Three oracles in this campaign
   were caught demanding the opposite of what their finding asked for.** You are the last check.

## How to produce the red

Each row's status cell names its evidence files under `docs/qa/2026-09-04/evidence/`. Those files
record what the original agent reverted to get its own red. **Prefer the honest route, in this
order:**

- **Best:** find the commit that fixed it (`git log --oneline -- <the file the row names>`), and
  run the oracle against the tree **at that commit's parent** — a fresh worktree or
  `git stash`-free checkout of just the product files. That is the genuinely unfixed tree.
- **Acceptable:** revert exactly the behavioural lines the evidence header names, run, restore.
  Restore from a byte-for-byte backup, and verify the restore with `git status`.
- **Never:** edit the oracle to make it fail. That proves nothing.

**Do not modify product code or any spec permanently.** You are reading, running and reporting. If
you believe a fix or an oracle is wrong, **report it — do not repair it.** A verifier who edits
becomes an author and cannot verify their own edit.

## Recording the result

For each row, in `docs/GATES.md` (Edit tool, one row at a time, **never a whole-file rewrite** —
the coordinator resolves conflicts per row and a rewrite destroys that):

- **`MET`** — you saw red and green. The cell must name: the oracle command you ran, the red count
  and the green count, how you produced the red, and **your branch name** so a reader can tell the
  two agents apart. Keep the original agent's text; append yours.
- **`FIXED`** (unchanged) — you could not reproduce the red, or the oracle does not assert the
  finding, or the row's proof was a measurement rather than a test. Append **why**, in one or two
  sentences. This is not a failure; an honest "not reproduced" is worth more than a green rubber
  stamp.
- Never downgrade a row, never touch a row that is not yours, never invent a status.

Rows that are `BLOCKED`, `NOT A DEFECT` or `ANSWERED` are **not yours** — skip them.

## What you may and may not run

- Run the individual specs and `check:*` guards you need. **Do not run `npm run verify` whole or
  `npm run quality`.**
- `tsc --noEmit` is fine and cheap.
- Vitest fork timeouts at 5000 ms under CPU load are **environmental** on this machine — several
  verifiers run at once. Re-run the file in isolation before you record a failure, and say that you
  did.
- **The local Supabase stack is single-occupancy.** Read `.claude/locks/supabase`. If you are not
  the holder, do not run `supabase db reset`, `scripts/ci-sql-suites.mjs` without `--list`,
  `npm run demo:restore`, or any `docker exec … psql` against the shared container. A row whose
  proof is an SQL suite is not yours unless your brief says so — leave it `FIXED` and say the
  stack was held.
- Production reads through `scripts/db-query.ps1 -ProjectRef rkftlbctohswhbbiaqin` need no lock.
  **Read-only. Never write to production.**

## Deliverable

- One evidence file per verifier: `docs/qa/2026-09-04/evidence/G13-<your-area>-VERIFY.txt`, listing
  every row you touched, the command, the red and green numbers, and the verdict. `.txt` only.
- One commit on your own branch; message to a file, `git commit -F`. Do not push, no PR.
- Sweep zero-byte junk from the repo root before committing.
- Report: how many rows you took, how many reached `MET`, how many stayed `FIXED` **and why each
  one did**, and every oracle you believe does not assert its finding. **The last list is the most
  valuable thing you can produce — do not leave it empty out of politeness.**
