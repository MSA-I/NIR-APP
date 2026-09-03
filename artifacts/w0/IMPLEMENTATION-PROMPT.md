# Implementation brief — InPlace remediation, Waves 1 onward

Paste everything below the line into the implementing agent.

---

You are implementing an approved remediation plan for **InPlace**, a Hebrew RTL
procurement-to-payment SaaS. The planning is finished and survived seven adversarial review
rounds; your job is to build, not to re-plan.

## Read these first, in this order

1. `docs/plans/2026-09-03-qa-remediation-plan.md` — the plan. Waves, gates, verified root causes, and every owner decision.
2. `artifacts/w0/RESULTS.md` — Wave 0's measurements. **These are facts, not estimates**, and
   three of them shrank the work. Do not redo them.
3. `docs/plans/2026-09-03-qa-remediation-review-log.md` — the argument that produced the plan, including every claim that was
   refuted. Read it to avoid repeating a refuted assumption.
4. `CLAUDE.md` — the project constitution. It overrides your habits, and its rollout matrix
   decides what must run before a merge.

## The base

`origin/main == main == HEAD == b12d387d44a2d5991bdb42f72b86543fa75cf626`, migration head
`0290`, **zero open PRs**. Re-run `git fetch` and re-check before you branch: other agents work
on this machine. Work in an isolated worktree created from the locked SHA.

## The one law of this repository

**The first definition of anything is almost never the live one.** Nine separate times during
planning, a claim about "what the code does" was made from the migration that created a function
and was wrong, because a later migration had replaced the body through an anchored patch.

So: **before you touch any database function, print its live body** —
`pg_get_functiondef('public.fn(args)'::regprocedure)` — and work from that. A `grep` finds
candidates; only the live body is evidence. The same applies to columns: `0217` widened price
columns that `0001` declared narrower, and a plan written from `0001` was wrong.

## Order of work

Waves 1, 1b, 2, 3, 4, 4b, 5, 6, 7, 8, 9 as written in `docs/plans/2026-09-03-qa-remediation-plan.md`. Wave 1 and Wave 1b may run in
parallel — they share no file. Do not start a wave whose `Needs:` line is unmet.

## Use a team, and split it along the real seam

Run as many agents in parallel as the work genuinely allows, and expect that to be **most of
it**. But this repository has three measured hazards that make naive parallelism slower, not
faster, because the recovery costs more than the saving:

**Serialise anything that touches the database.** The local Supabase stack
(`supabase_db_supplyflow-p0`) is a single shared instance, and the quality gate demands exclusive
use of it. Two agents running SQL suites at once corrupt each other's fixtures. **One
database-writing agent at a time**, and it holds the stack until its gate finishes.

**Serialise migration authorship.** Numbers are not reserved by anything. A previous campaign
produced six collisions in one day — three agents each read the highest number, each added one,
and git merged all three silently. **One agent writes migrations**, it runs
`npm run next-number -- migration` immediately before writing, and it pushes the file at once to
claim the number.

**Never let a subagent run a state-changing git command.** A subagent once reverted another
agent's verified commit. Subagents may read, build, test and edit files; `git commit`, `git
reset`, `git checkout`, `git rebase`, `git push` and `git merge` belong to you alone.

Everything else parallelises well: frontend work, Edge functions, translations, contrast and
accessibility, report surfaces, tests, and every read-only investigation. Fan those out widely.

## Standing rules

- **Forward-only migrations that patch live bodies through unambiguous anchors.** Never edit
  `0023`, `0032`, `0048` or any applied migration in place — an installed database will not
  change. Update pinned body hashes when you move a pinned body.
- **`npm run verify` locally before every handoff.** It is broader than what CI runs: 13 of its
  27 guards have no CI step, so a green pipeline is not proof they passed.
- **Never `git add -A`.** The tree carries permanent litter — `__pycache__`, brand assets, tool
  output. One such command swept 313 files into a one-line commit. Stage by name.
- **Any tool you write that rewrites the repo must exclude its own guards by name.** A conversion
  script once rewrote the map that declared what the conversion should be, producing a guard that
  passed by asserting nothing.
- **A failed gate is a measurement.** Read the whole message, reproduce the specific failure
  locally, and form a new hypothesis before retrying. Two consecutive failures of the same gate
  (three if environmental): stop and report the full error, what was tried, and why each attempt
  failed. Never re-run hoping.
- **Report honestly.** A gate that did not run is not a gate that passed. If you skip something,
  say so and say why.

## What "done" means per wave

Each wave in `docs/plans/2026-09-03-qa-remediation-plan.md` carries its own gate. A wave is done when its gate produces the stated
evidence — a screenshot, a query result, a suite name, a token — and not when the code looks
right. Visual changes need a screenshot of the rendered result, not a claim.

## Owner decisions — settled, do not reopen

- Bank matching is **both** paying and recording. Distinguish the two; do not block recording.
- Per-organisation numbering starting at 1 for every new tenant; existing numbers preserved.
- The accountant sees **only approved invoices**, and the export **says nothing** about what was
  omitted. Payments are filtered too, and report **only the approved-invoice portion**.
- "No open obligations" is a **sentence with no figure** — not `0 ILS`, not an em dash.
- **Every password change writes an audit row.**
- Product names are fixed at the extraction root, not patched once.

## Two things the plan does not yet cover, and you must not silently skip

- **The sign-up success path has never been exercised.** The organisation is created before the
  permission user, and the unwind uses a rollback already proven broken. It is the front door for
  new customers and the owner is selling within weeks. Wave 3 needs both a failure-injection gate
  proving zero leftovers immediately, and an end-to-end success run.
- **Prompt-injection and cross-role leakage were never probed live** — the demo organisation's
  monthly assistant allowance ran out after 18 questions. Unit coverage exists
  (`provider.test.ts:396-430`, `business.test.ts:185-194`); the live probe does not. Wave 1b needs
  an authorised test allowance, not an open wait.

## When you are unsure about a business rule

`docs/OPEN-DECISIONS.md` holds the documented defaults. If the answer is not there, **ask the
owner** — do not invent one and do not bury the assumption in code. The owner is not a
programmer: ask in plain language, in Hebrew, with the options laid out and the consequence of
each stated in one line.

Start with Wave 1 and Wave 1b in parallel. Report what each gate returned.
