# The SQL gate spends 22 of its 28 minutes rebuilding the same database

Measured 01.09.2026 from a passing `quality-gate.yml` SQL job. Written down so the next
session starts from the measurement rather than from the guess.

## Where the time goes

| step | time | count |
|---|---|---|
| `supabase db reset` | 323s | **3** |
| `supabase start` (migrations + seed) | 380s | 1 |
| **all 118 suites together** | **~60s** | — |

The slowest single suite is 21s; most are under three. So the obvious idea — shard the
suites across parallel jobs — would have saved almost nothing, and would have cost each
shard its own 380s stack. **Measure before optimising** is not a slogan here; it changed
the answer.

## Why the three resets exist, and why they are not the problem

Each follows a concurrency suite that must COMMIT to prove anything and therefore cannot
roll its fixtures back:

* after `p18_price_list_concurrency` + `p20_invoice_approval_concurrency`
* after `p59_supplier_order_portal_concurrency`
* after `p1_price_submissions_concurrency`

They are necessary. What is gratuitous is rebuilding a schema from 272 migrations to
delete a handful of committed rows.

## The approach, and exactly where it stalled

Build the schema once, then copy it: `CREATE DATABASE … TEMPLATE` is a file copy inside one
Postgres instance and the migrations do not run again. Branch: `perf/fast-db-reset`.

Three attempts, three DIFFERENT causes — worth knowing so they are not re-hit:

1. **`pg_dump` is not on PATH** in the Supabase image. Rewritten to fingerprint the catalogs
   instead, which is also a stricter comparison than diffing two dumps, because pg_dump's
   text output is not order-stable. The fingerprint works and reports **11,098 catalog facts**.
2. **`source database "postgres" is being accessed by other users`.** Terminating connections
   loses a race: Supabase's own services reconnect between the terminate and the CREATE.
3. **Same error after blocking connections** with `ALTER DATABASE … ALLOW_CONNECTIONS false`.
   Not diagnosed. Most likely a window where a backend has been signalled but has not exited,
   so the CREATE still sees it. A retry loop around the CREATE is the obvious next thing to try.

## The rule that matters more than the fix

**Do not debug a timing race through a 25-minute feedback loop.** All three attempts above
cost a full CI cycle each. This needs a LOCAL stack where an attempt takes seconds. CI
confirms; it does not diagnose.

## Two safety properties already built, and worth keeping

* **Fallback**: if the snapshot cannot be taken or a restore fails, the runner falls back to
  the real `supabase db reset` and says so. Speed can regress; correctness cannot.
* **Proof**: `scripts/check-fast-reset-equivalence.mjs` fingerprints the database, snapshots,
  commits a probe table, restores, and requires the fingerprints to be identical and the probe
  gone. It is wired into the SQL job BEFORE the suites, so a divergence fails the job rather
  than quietly poisoning every later suite. It caught its own broken first version.

## Before running it

`supabase db reset` wipes the SHARED `supplyflow-p0` stack. Per the project constitution:
one run at a time on this machine, and `npm run demo:restore` afterwards. On 01.09 a second
agent was editing documents in the same tree, which is why this was deferred rather than run.
