-- InPlace — remove the demo tenant.
--
-- Deletes every row belonging to the demo organization and nothing else. Scoped strictly
-- by org_id, so it is safe to run on a database that also holds real tenants: a row that
-- does not carry the demo org id is never touched.
--
-- Run this before re-loading supabase/demo/demo_seed.sql (the seed refuses to load twice
-- rather than silently duplicating data). scripts\seed-demo.ps1 does both in one command.
--
-- The demo auth.users rows survive on purpose — profiles are resolved from them by email,
-- so create-users.ps1 only ever has to run once per project.
--
-- ===== Why this file no longer carries its own delete order =====
-- It used to name every table in foreign-key order. That hand-written list covered 32 tables
-- while 132 carry org_id, and it went stale the moment a migration added a child with a
-- non-cascading foreign key: on 26.08.2026 it died on invoice_three_way_overrides, a table added
-- long after the list was written, and another blocked table stood right behind it. A list
-- maintained by hand for every future migration is a list that goes stale again.
--
-- The product already owns this problem. `private.delete_tenant_rows` (0196) derives the stage
-- order from the live foreign-key graph, breaks reference cycles, repeats until a pass removes
-- nothing, and refuses to return while a single tenant row survives. It is what
-- `public.execute_organization_purge_batch` (0197) runs to remove a real tenant. The demo tenant is
-- a tenant; removing it is the same operation, so this file calls the same code instead of keeping
-- a second, weaker copy that only this file's users would find broken.
--
-- ===== KNOWN LIMIT, MEASURED 26.08.2026 — read this before reporting a bug =====
-- That shared teardown does not currently finish for a tenant that has used the product. It is
-- refused by immutability triggers that predate it and never got a teardown window:
--
--     ERROR:  invoice_three_way_evidence_immutable
--     CONTEXT: SQL statement "delete from public.invoice_three_way_approval_snapshots ..."
--              PL/pgSQL function private.delete_tenant_rows(uuid) line 57 at EXECUTE
--
-- 0175 gave the raw audit ledger exactly this kind of immutability WITH a declared-purge window
-- (`app.audit_purge = 'organization_teardown'`), and 0196 satisfies two more guards the same way,
-- by name rather than by weakening them. Thirty-one further guard functions never received that
-- window, so the teardown — and with it the production purge in 0197 — stops at the first evidence
-- ledger a real tenant has written. Completing that window is a security-surface decision across
-- every evidence ledger in the system, not a demo fixture change, so it is not made here.
--
-- UNTIL THEN, THE WORKING WAY TO RELOAD THE DEMO LOCALLY IS A FULL REBUILD:
--     supabase db reset            -- migrations + seed.sql, no demo tenant
--     npm run demo:restore         -- demo auth users + demo_seed.sql + proof
--
-- This file is kept pointed at the shared teardown rather than at a fresh hand-written list: when
-- the window is completed, it starts working with no edit, and until then it fails naming the guard
-- that refused rather than an arbitrary foreign key.

do $$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_name text;
  v_removed jsonb;
begin
  select name into v_name from organizations where id = v_org;

  -- Safety: never let this file delete something that is not the demo tenant.
  if v_name is not null and v_name <> 'עסק לדוגמה' then
    raise exception 'Organization % is named "%" — that is not the demo tenant. Refusing to delete.', v_org, v_name;
  end if;

  if v_name is null then
    raise notice 'Demo organization % is not present; nothing to remove.', v_org;
    return;
  end if;

  -- The three private tables that hang off an event rather than off an organization. They carry no
  -- org_id, so the derived teardown cannot see them. The demo's only webhook subscription is
  -- deliberately INACTIVE (OPEN-DECISIONS #98), so nothing is ever enqueued and these are no-ops
  -- today — written anyway, so a demo tenant someone switched a subscription on for is still
  -- removable without hand-editing SQL.
  delete from private.integration_deliveries
   where outbox_id in (select id from private.integration_outbox where org_id = v_org);
  delete from private.dead_letter_records
   where event_id in (select id from domain_events where org_id = v_org);
  delete from private.idempotency_keys
   where event_id in (select id from domain_events where org_id = v_org);

  -- The GUC is the one 0175 defined: transaction-local, one value, a name test rather than a role
  -- test. delete_tenant_rows needs it for the audit ledger.
  perform set_config('app.audit_purge', 'organization_teardown', true);

  begin
    v_removed := private.delete_tenant_rows(v_org);
    perform private.delete_tenant_organization_row(v_org);
  exception when insufficient_privilege or others then
    -- Re-raise with the working alternative attached. Without this the operator gets a bare
    -- condition name from a trigger three call levels down and no way to know what to do next.
    raise exception 'Demo teardown refused by a tenant immutability guard: %', sqlerrm
      using detail = 'The shared tenant teardown (0196) has no declared-purge window on this guard. '
                     'Rebuild instead: supabase db reset, then npm run demo:restore.',
            errcode = sqlstate;
  end;

  perform set_config('app.audit_purge', '', true);

  raise notice 'Demo organization % removed: % rows across % tables.',
    v_org,
    (select coalesce(sum(value::bigint), 0) from jsonb_each_text(v_removed)),
    (select count(*) from jsonb_object_keys(v_removed));
end $$;
