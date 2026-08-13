---
name: new-migration
description: Scaffold a new numbered migration in supabase/migrations/ with the org_id, RLS, soft-delete and audit rules already in place, plus the exact commands to run and verify it. Use when adding or changing schema.
disable-model-invocation: true
---

# A new migration

89 migrations precede yours, and they run against the **remote** project. A migration that ships
without RLS exposes a tenant; one that ships with a stored balance goes stale; one that edits an
already-committed file diverges local from remote in a way no gate catches.

## 1. Pick the number

```
ls supabase/migrations/ | tail -3
```

Next integer, four digits, `_snake_case_intent.sql`. The name says what it *does*, not what it
touches: `0090_supplier_bank_stepup.sql`, not `0090_alter_suppliers.sql`.

**Never edit an existing file.** A committed migration has run. The fix for a shipped migration is
a new one. A `PreToolUse` hook blocks this, and the block is correct.

## 2. Write the header first

Every migration in this repo opens with prose explaining *why*, in the voice of `0089`:

```sql
-- Package N (<decision + date>) — <the one-sentence reason this exists>.
--
-- Shape: <how it works, and the non-obvious choice you made>.
--
-- What this deliberately does not cover: <the scope you left out, and where it is recorded>.
```

If you cannot write the "deliberately does not cover" line, the scope is not settled yet.

## 3. The rules that must be in this file, not the next one

**New table:**

```sql
create table <name> (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  -- … columns …
  deleted_at timestamptz,          -- financial rows are retired, never deleted
  created_at timestamptz not null default now()
);

alter table <name> enable row level security;

create policy <name>_tenant on <name>
  for select using (org_id = auth_org());
```

`enable row level security` goes in the **same migration** as `create table`. A table created now
and secured later is exposed in between.

Every policy filters `org_id = auth_org()`. Filtering only on `auth.uid()` lets a user read their
own rows inside someone else's tenant.

**Never:**
- a `payment_id` column on an invoice — payment↔invoice is `payment_allocations` (N:M), bank↔
  invoice/payment is `bank_allocations` (N:M) (`ARCHITECTURE.md:158`);
- a stored balance — balances come from `p0_invoice_balance_rows()` /
  `p0_supplier_balance_rows()`, which are **functions**, not views, since `0022`
  (`ARCHITECTURE.md:159`, and note `CLAUDE.md`'s summary still says "views");
- a hard `delete from` on a financial table — `deleted_at` or a cancelled status
  (`ARCHITECTURE.md:171`);
- an `alter type user_role` — the enum is embedded in 77 RLS policies. Display labels change in
  `src/lib/status.ts`;
- a storage path that does not begin with `{org_id}/` — the bucket policy parses that prefix.

**Command RPCs** write their audit row **with a reason**, inside the same transaction as the
mutation. The browser may never insert into `audit_logs` (`ARCHITECTURE.md:172`).

**SECURITY DEFINER** that reads a scope-enforced table without filtering on `auth_scopes()` must
be added to `private.scope_definer_exemptions` **and** the pin in
`supabase/tests/p9_five_domains.sql` must move. `npm run check:exemptions` fails otherwise — by
design, so that widening the hole is argued rather than absorbed.

## 4. Review before running

```
Use the migration-reviewer agent on this migration.
```

It reads the diff against every rule above and returns a verdict. Cheaper than a failed gate, far
cheaper than a bad remote schema.

## 5. Run it

Locally first, against the container the suites use:

```
docker exec -i supabase_db_supplyflow-p0 psql -U postgres -d postgres -f - < supabase/migrations/00NN_name.sql
```

Then the remote project, via the Management API. Both parameters are mandatory:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."
.\scripts\db-query.ps1 -SqlFile supabase\migrations\00NN_name.sql -ProjectRef <20-char-ref>
```

The script **refuses** the known production ref without `-AllowProduction`. That refusal is a
safety rail — ask the owner before adding the flag, do not add it to get past an error.

Paths on this machine live under `D:\משה פרוייקטים\...` — Hebrew and a space. Always quote the
absolute path; in PowerShell use `-LiteralPath` for any delete or move.

## 6. Prove it

- Add or extend the suite in `supabase/tests/` that covers the new behaviour — including the
  negative case: a user from another `org_id` must not see the row.
- `npm run check` — build, static guards (including `check:exemptions`) and Vitest.
- Trigger `quality-gate.yml` when the package closes: the SQL job is where an RLS mistake surfaces.
  Do not run `npm run quality` locally as part of ordinary work.

Report the migration number, what it changed, where it ran, and which suite proves it. Not "the
migration is done".
