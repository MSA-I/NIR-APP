-- Platform administration + org lifecycle.
--
-- Two independent axes of authority now exist:
--   * `user_role` (0001)      -- what a member may do INSIDE their organization.
--   * `platform_admins`       -- who operates the SaaS platform itself, ACROSS organizations.
-- They are deliberately separate tables/functions. Folding "platform operator" into the
-- `user_role` enum would have meant touching the enum that 77 RLS policies are compiled
-- against, which the project constitution forbids.

-- ===== Platform operators =====
create table platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,                 -- who this operator is, for the humans reading the table
  created_at timestamptz not null default now()
);

-- Same shape and rationale as auth_role()/auth_org() (0001_init.sql:42-47): `security definer`
-- so a policy ON platform_admins can call it without recursing into its own RLS, `stable` so
-- the planner evaluates it once per statement, and a pinned search_path so a hostile
-- temp-schema object can't shadow the table name.
create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from platform_admins where user_id = auth.uid()) $$;

alter table platform_admins enable row level security;

-- Operators can see the roster; nobody can change it through the API. Membership is granted
-- out-of-band (SQL console / service_role) on purpose: a table that grants cross-tenant power
-- must not be writable by anything that holds only a user JWT -- including its own members,
-- which would make platform admin self-propagating.
create policy platform_admins_select on platform_admins for select using (is_platform_admin());

-- ===== Organization lifecycle =====
create type org_status as enum ('trial', 'active', 'suspended');

alter table organizations add column status org_status not null default 'trial';
alter table organizations add column trial_ends_at timestamptz;

-- Every organization that exists at migration time is a paying/live customer, not a trial.
update organizations set status = 'active';

-- `trial_ends_at` is recorded but NOT enforced anywhere. How long a trial lasts, and what
-- happens when it lapses (auto-suspend? read-only? nothing?) is an unanswered business
-- question -- see docs/OPEN-DECISIONS.md. Only an explicit 'suspended' blocks access.

-- ===== Suspension enforcement =====
-- REQUIREMENT: a suspended organization must be blocked by the database, not by the UI.
--
-- Two ways to do that:
--
--   (A) Amend all 77 policies from 0001/0004 to add `and org_active()`.
--   (B) Make auth_org() return null for a suspended org, so every existing predicate
--       `org_id = auth_org()` evaluates to NULL -> not true -> row filtered out.
--
-- (B) is chosen. The deciding factor is not that (A) is 77 error-prone edits (though it is)
-- -- it is that (A) is INCOMPLETE. `invoice_balances` and `supplier_balances` (0003) are
-- security-DEFINER views: they carry no RLS policies at all and self-guard by calling
-- auth_org() in their WHERE clause. The storage.objects policies (0005) likewise compare
-- against auth_org()::text. Editing policies would leave both of those paths open, so a
-- suspended tenant would still read every supplier balance in their org. Changing the
-- function closes all three surfaces -- table policies, definer views, storage -- at once.
--
-- The general property being relied on: the entire tenant data plane is reachable only
-- through auth_org(). It is the single chokepoint, so it is the correct place to revoke.
--
-- What this costs, stated plainly:
--   1. A suspended tenant cannot read their own `organizations` or `profiles` row either, so
--      the SPA cannot render a "your account is suspended" screen from tenant data -- it just
--      sees empty results. Failing closed is the right default for a billing/abuse control;
--      the friendly message has to come from somewhere outside the tenant's own data.
--   2. Platform admins must never depend on auth_org(). They do not: their access to
--      `organizations` runs through is_platform_admin() policies below, and the operator
--      listing runs through platform_orgs() -- neither calls auth_org(). A platform admin who
--      also happens to be a member of a suspended org correctly loses tenant access while
--      keeping platform access. The two axes stay independent, which is the point.
--   3. auth_org() gains a join. Both sides are primary-key lookups (profiles.id,
--      organizations.id) and the function is `stable`, so this is an extra index probe per
--      statement, not per row. No new index is warranted for it -- see the index note below.
create or replace function auth_org() returns uuid
language sql stable security definer set search_path = public as
$$ select p.org_id
     from profiles p
     join organizations o on o.id = p.org_id
    where p.id = auth.uid()
      and p.active
      and o.status <> 'suspended' $$;

-- ===== Closing the hole that would have let a tenant walk out of suspension =====
-- `profiles_self_update` (0001_init.sql:496) is `for update using (id = auth.uid())` with no
-- WITH CHECK. Postgres reuses USING as the check when none is given, and USING constrains only
-- the row's identity -- not its contents. Any user could therefore rewrite their own `role`
-- to 'owner' or their own `org_id` to another organization. That is a pre-existing
-- privilege-escalation and tenant-isolation bug, but it also directly defeats the mechanism
-- above: a suspended user could re-point their profile at a non-suspended org and auth_org()
-- would start answering again.
--
-- RLS cannot express "this column may not change" (WITH CHECK has no access to OLD), and
-- column-level GRANTs can't help either because owners and ordinary members are both the
-- `authenticated` role. A BEFORE UPDATE trigger is the mechanism that fits.
create or replace function profiles_guard_privileged_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- service_role / migrations / seed run without a JWT subject; they are already trusted.
  if auth.uid() is null or is_platform_admin() then
    return new;
  end if;
  -- An owner administers members of their own (non-suspended) organization.
  if auth_role() = 'owner' and old.org_id = auth_org() then
    return new;
  end if;
  if new.org_id     is distinct from old.org_id
  or new.role       is distinct from old.role
  or new.active     is distinct from old.active
  or new.supplier_id is distinct from old.supplier_id then
    raise exception 'profiles: org_id, role, active and supplier_id may only be changed by an owner of the organization';
  end if;
  return new;
end $$;

create trigger profiles_guard_privileged_columns
  before update on profiles
  for each row execute function profiles_guard_privileged_columns();

-- ===== Platform admin access to organizations =====
-- Permissive policies are OR-ed, so the tenant-facing org_select/org_update from 0001 keep
-- working unchanged for ordinary members.
create policy org_platform_select on organizations for select using (is_platform_admin());
create policy org_platform_insert on organizations for insert with check (is_platform_admin());
create policy org_platform_update on organizations for update
  using (is_platform_admin()) with check (is_platform_admin());
-- No delete policy: organizations follow the project's soft-lifecycle rule. Ending a customer
-- relationship is `status = 'suspended'`, not a DELETE that would orphan seven years of
-- financial records.

-- The operator console needs a member count per organization. Granting platform admins SELECT
-- on `profiles` across orgs would hand them every tenant's staff roster, phone numbers
-- included, to render one number. This returns the aggregate and nothing else.
create or replace function platform_orgs()
returns table (
  id            uuid,
  name          text,
  status        org_status,
  vat_rate      numeric,
  trial_ends_at timestamptz,
  created_at    timestamptz,
  user_count    bigint
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.status, o.vat_rate, o.trial_ends_at, o.created_at,
         (select count(*) from profiles p where p.org_id = o.id and p.active)
    from organizations o
   where is_platform_admin()   -- non-operators get zero rows, never an error
   order by o.created_at desc
$$;

-- Suspending a tenant is written to that tenant's audit log with a reason (the app does this
-- via src/lib/audit.ts). The operator's org_id is not the target's, so audit_insert
-- (`org_id = auth_org()`) cannot cover it.
create policy audit_platform_insert on audit_logs for insert with check (is_platform_admin());
-- Deliberately NOT granting platform admins SELECT on audit_logs: those rows carry full
-- old/new JSONB of every financial table for every tenant. Write-only is enough to record an
-- operator action; reading tenant books is not part of operating the platform.

-- ===== Indexes =====
-- Nothing new is needed, and adding something would be noise rather than caution:
--   * platform_admins.user_id -- is_platform_admin()'s only filter -- is the primary key.
--   * auth_org()'s new join hits organizations.id, also a primary key.
--   * platform_orgs()'s member count filters profiles.org_id, already covered by
--     profiles_org_idx (0005).
--   * organizations.status is not filtered by any policy; the operator list reads the whole
--     table, which has one row per customer.
-- platform_admins carries no org_id column, so the 0005 self-check block is unaffected.
