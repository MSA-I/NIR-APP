# Standing brief — QA-sweep-20260904 remediation agents

You are one agent in a parallel campaign. Read this whole file before your first command.

## 0. Bootstrap — do this FIRST, before anything else

Your worktree was cut from `origin/main`, which is far behind the campaign. Run, in your own
worktree only:

```
git reset --hard worktree-qa-sweep-20260904
```

Verify with `git log --oneline -1` that you are on a commit whose message is one of the campaign's
`fix(...)` commits. If the reset fails, STOP and report — do not work on `origin/main`.

`node_modules` is a junction to the main checkout. Do not run `npm ci` or `npm install`. It is
sometimes MISSING in a fresh agent worktree — if so, create the junction yourself; still no `npm ci`.

**Four environment facts measured on this machine, each of which has cost an agent time:**
- A fresh worktree has **no `.env` / `.env.local`**. Copy both from the main checkout before
  running a dev server, or it cannot reach the local stack. They are gitignored — never commit them.
- **Port 5199 is held by another worktree's dev server** that has been running since 03.09. Do not
  kill it. Use another port with `--strictPort`, say which one you used, and stop yours afterwards.
- **Vite binds the IPv6 loopback here.** `http://127.0.0.1:<port>` is refused; use
  `http://localhost:<port>`.
- **Playwright's bundled Chromium fails to spawn** (`spawn UNKNOWN`). Use system Edge with an
  explicit `executablePath`. Port 6000 is `ERR_UNSAFE_PORT` in every Chromium.

## 1. Rules that have already cost this campaign time

- **All git goes through the PowerShell tool.** The Bash tool's hook refuses `git status`,
  `git worktree list` and friends. Use `PowerShell` for every git command.
- **If `git reset --hard` and every other tree-changing git command is REFUSED** by this session's
  auto-mode classifier, you cannot bootstrap your assigned worktree. That happened on 05.09.2026.
  Do NOT fight it and do NOT work on `origin/main`. Instead work **in the worktree of the branch
  you were told to continue** — it is already checked out at the right commit, which is the state
  the reset was meant to produce. `git add` and `git commit` still work there. If the Edit/Write
  tools are isolation-locked to a different directory, make file changes with a Node script, and
  make it **refuse unless its anchor matches exactly one line** so a silent double-edit is
  impossible. Say in your report that you did this.
- **Never `git add -A`.** Stage files by name. The repo carries permanent dirt
  (`__pycache__`, brand assets, tool output); one `-A` swept 313 files into a one-line commit.
- **Zero-byte junk files appear at the repo root** whenever a `=>` reaches the shell — from your
  own commands and from tools. Before EVERY commit run, in PowerShell:
  `Get-ChildItem -File | Where-Object Length -eq 0 | Remove-Item`
  and confirm `git status` is clean of them.
- **Never `Set-Content -Encoding utf8`** on a file containing Hebrew — it writes a BOM and turns
  the file to mojibake, and `git status` will show only "1 file modified". Edit Hebrew files with
  the Edit/Write tools or a Node script.
- **Never run a git command that changes another branch's state.** No `git reset` outside your own
  worktree, no `git checkout` of the campaign branch, no `git stash pop` (the stash stack is shared
  — if you must stash, `git stash push -u -m "<unique-tag>"`, capture the SHA, `apply` it, drop it
  by tag).
- **No `/tmp`.** Windows has none. Temporary files go in your worktree under an ignored path, or in
  the session scratchpad.
- **Do not draw numbers.** Ruling, debt-section, migration and SQL-suite numbers are assigned by
  the coordinator in `.claude/locks/numbers` of the campaign worktree
  (`D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\qa-sweep-20260904\.claude\locks\numbers`).
  Your assignment is in your task prompt. If you find you need a number you were not given, STOP
  and ask the coordinator.

## 2. The serialised resource

Read
`D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\qa-sweep-20260904\.claude\locks\supabase`
before any command that touches the LOCAL stack. That file names the holder and the queue.
Read-only queries against the REMOTE production project through
`scripts/db-query.ps1 -ProjectRef rkftlbctohswhbbiaqin` need no grant and you should use them
freely for diagnosis.

If you are not the holder: do every other part of your work — diagnosis, the migration text, the
suite text, the client change, the component oracle and its red/green — then STOP and report
**"ready for the stack"**, listing exactly the commands you intend to run. The coordinator will
message you when the lock is yours. Do not poll. Do not take it yourself.

Also do not run `npm run verify` whole or `npm run quality`. Run the individual `check:*` guards
your change touches. The campaign runs one baseline `verify` on an idle machine.

## 3. Verification discipline — this is the point of the campaign

- **Show the red.** Every oracle must be SEEN FAILING on the unfixed tree before the fix, and the
  failure output saved. If you write the test after the fix, revert only the behavioural lines,
  record the red, restore, and say in the evidence header exactly what you reverted.
- **If you correct an oracle mid-flight, re-run BOTH sides against the corrected version.** A red
  recorded against a different assertion is not this finding's red.
- **Include a control** that passes in both runs, so a red that is really a broken harness is
  visible as such.
- **Assert per row, never by count.** A count passes for the wrong reason.
- **A metric with no data shows `—`, never `0`.** Zero is also a claim about reality.
- **Never widen a query, a role, or a permission to make two numbers agree.** That is a privilege
  leak, not a fix. If two numbers disagree because their populations differ, the fix is that the
  LABEL states its scope.
- **Never invent a business answer in code.** An open business question goes to
  `docs/OPEN-DECISIONS.md` as a documented default, or the row goes to `BLOCKED` with the question
  written out.
- **Financial rows are soft-deleted only.** No `payment_id` on an invoice — N:M allocation tables
  only. Balances are computed per currency and never summed across currencies.
- **`SECURITY DEFINER` bodies are patched ANCHORED against the LIVE body**, never re-declared from
  the creating migration — re-declaring silently reverts the security properties a later migration
  established. Find the true ancestor with `pg_get_functiondef` against the live database, not by
  grepping migrations. `check:anchored-replacements` guards this.
- **Prove on the guarded path.** A proof run as `postgres` skips RLS and the financial command
  guard and proves nothing. Use role `authenticated` with a real JWT subject.
- **A visual change is not done without a screenshot you have READ.** 1440x900, system Edge, the
  compiled stylesheet. Headless screenshots miss injected CSS on this machine — render headed.
- Environmental failures (5000 ms vitest fork timeouts under CPU contention) are re-run in
  isolation and recorded as environmental, never waved at.

## 4. The ledger

`docs/GATES.md` has one row per finding. When your work is done, set YOUR rows only to `FIXED`
(or `BLOCKED` with the reason written out, or `ABANDON:` with the reason — never a blank).

**No agent marks its own row `MET`.** `MET` is a second agent reproducing the transition. Say so
explicitly in the row.

Edit `docs/GATES.md` with the Edit tool. Do not rewrite the file. Do not touch rows that are not
yours — the coordinator resolves conflicts per row and a whole-file rewrite destroys that.

## 5. Deliverable

- Commit on your own branch. Do NOT push and do NOT open a PR — the coordinator cherry-picks.
- Evidence files go under `docs/qa/2026-09-04/evidence/` with a `.txt` extension (`.log` is
  gitignored and the campaign requires evidence checkable from the tree).
- Write the commit message to a FILE and use `git commit -F <file>`. PowerShell here-strings are
  mangled by this session's hook.
- End the commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Your final report to the coordinator states: the branch and commit SHAs, what the root cause
  actually turned out to be (say so plainly if it was NOT what the finding claimed), the red and
  the green with their numbers, which guards you ran, what you did NOT run and why, and every
  residual you recorded rather than silently fixed.
