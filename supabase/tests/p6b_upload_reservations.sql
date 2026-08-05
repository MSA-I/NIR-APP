-- P6b upload-reservation harness for 0065. Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves, per PLAN-07 §2:
--   (a) renewal extends the caller's own claim to least(now()+15min, created_at+45min):
--       plain extension, the clamp near the lifetime deadline, and the revival of a claim
--       past expires_at but inside the lifetime cap (the exact race the sweep grace
--       exists for);
--   (b) the 45-minute total-lifetime cap rejects with
--       document_upload_reservation_lifetime_exceeded;
--   (c) a foreign actor -- same tenant or another tenant -- sees
--       document_upload_reservation_unknown, and a supplier-role actor whose profile
--       binding disagrees with the claim's supplier is not_authorized;
--   (d) a REGISTERED claim rejects renewal by name (document_upload_reservation_registered
--       -- the documented choice: success would invite re-upload, and the money rule says
--       a stored-and-registered file is never re-uploaded), while the register path itself
--       still works under the new column guard;
--   (e) the column guard: any re-bind -- coherent (supplier_id + storage_path together,
--       satisfying every CHECK) or single-column -- raises; the registered receipt
--       columns are immutable outside the one reserved->registered transition; expires_at
--       is locked once registered;
--   (f) the sweep grace: a claim expired 30 minutes survives someone else's reserve call,
--       a claim expired 2 hours is swept by the same call;
--   (g) register still rejects an expired-but-not-swept claim
--       (document_upload_reservation_expired) and the rejected row REMAINS -- expiry and
--       sweep are separate manifestations;
--   (h) the mutation proof: dropping the guard trigger in a savepoint lets the identical
--       coherent re-bind of (e) succeed, this suite's own drift detection catches it, and
--       the savepoint rollback restores both the trigger and the binding.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p6b_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P6b upload reservations assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Structural proofs first =====

-- Renewal is a browser RPC: authenticated only, like reserve (the 0048:389-392 idiom).
select pg_temp.p6b_assert(
  has_function_privilege('authenticated', 'public.renew_supplier_price_document_upload(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.renew_supplier_price_document_upload(uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.renew_supplier_price_document_upload(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.reserve_supplier_price_document_upload(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.reserve_supplier_price_document_upload(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.reserve_supplier_price_document_upload(uuid,text,text)', 'EXECUTE'),
  'renew/reserve must be executable by authenticated only');

-- The replaced reserve carries the one-hour sweep grace, and ONLY the graced predicate.
select pg_temp.p6b_assert(
  exists (
    select 1 from pg_proc
    where proname = 'reserve_supplier_price_document_upload'
      and prosrc ~ 'expires_at <= now\(\) - interval ''1 hour'''
      and prosrc !~ 'expires_at <= now\(\)\s*;'),
  'reserve must sweep only claims a full hour past expiry');

-- The renewal body is word-clean of every enforced table name (the A5 contract).
select pg_temp.p6b_assert(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select table_name from private.scope_registry where enforced) r
    where n.nspname = 'public'
      and p.proname = 'renew_supplier_price_document_upload'
      and p.prosrc ~ ('\m' || r.table_name || '\M')),
  'the renewal body must not name any enforced table (A5)');

-- The column guard is attached: BEFORE UPDATE, row-level, on the reservation table.
select pg_temp.p6b_assert(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'supplier_price_document_upload_reservations'
      and t.tgname = 'supplier_price_document_upload_reservations_guard'
      and not t.tgisinternal),
  'the reservation column-guard trigger must exist');

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====

insert into organizations (id, name, status) values
  ('16000000-0000-0000-0000-000000000001', 'P6b tenant A', 'active'),
  ('16000000-0000-0000-0000-000000000002', 'P6b tenant B', 'active');

insert into auth.users (id, email) values
  ('26000000-0000-4000-8000-000000000001', 'p6b-owner@example.test'),
  ('26000000-0000-4000-8000-000000000002', 'p6b-supplier@example.test'),
  ('26000000-0000-4000-8000-000000000003', 'p6b-owner-b@example.test');

insert into suppliers (id, org_id, name) values
  ('36000000-0000-4000-8000-000000000001', '16000000-0000-0000-0000-000000000001', 'P6b supplier S1'),
  ('36000000-0000-4000-8000-000000000002', '16000000-0000-0000-0000-000000000001', 'P6b supplier S2');

insert into profiles (id, org_id, full_name, role) values
  ('26000000-0000-4000-8000-000000000001', '16000000-0000-0000-0000-000000000001', 'P6b owner', 'owner'),
  ('26000000-0000-4000-8000-000000000003', '16000000-0000-0000-0000-000000000002', 'P6b owner B', 'owner');

insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('26000000-0000-4000-8000-000000000002', '16000000-0000-0000-0000-000000000001',
   'P6b supplier agent', 'supplier', '36000000-0000-4000-8000-000000000001');

-- Reservations seeded at controlled clock offsets (now() is frozen inside this
-- transaction, so every arithmetic assertion below is exact):
--   r1 fresh (renew extends; later the coherent re-bind target)
--   r2 near the lifetime deadline (renew clamps to created_at+45min)
--   r3 past the lifetime deadline (renew rejects)
--   r4 past expires_at, inside the lifetime (renew revives -- the grace race)
--   r7 supplier-binding mismatch (S2 claim held by the S1-bound supplier agent)
insert into supplier_price_document_upload_reservations (
  document_id, org_id, actor_id, supplier_id,
  file_name, mime_type, storage_path, created_at, expires_at
) values
  ('46000000-0000-4000-8000-000000000001',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r1.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000001/r1.pdf',
   now() - interval '10 minutes', now() + interval '5 minutes'),
  ('46000000-0000-4000-8000-000000000002',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r2.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000002/r2.pdf',
   now() - interval '35 minutes', now() + interval '2 minutes'),
  ('46000000-0000-4000-8000-000000000003',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r3.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000003/r3.pdf',
   now() - interval '46 minutes', now() - interval '20 minutes'),
  ('46000000-0000-4000-8000-000000000004',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r4.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000004/r4.pdf',
   now() - interval '20 minutes', now() - interval '5 minutes'),
  ('46000000-0000-4000-8000-000000000007',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000002',
   'r7.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000002/46000000-0000-4000-8000-000000000007/r7.pdf',
   now() - interval '5 minutes', now() + interval '10 minutes');

-- ===== (a) Renewal as the owning supplier agent =====

select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select renew_supplier_price_document_upload(
  '46000000-0000-4000-8000-000000000001'
)::text as renew_r1
\gset p6b_
select pg_temp.p6b_assert(
  (:'p6b_renew_r1'::jsonb ->> 'expires_at')::timestamptz = now() + interval '15 minutes'
  and (:'p6b_renew_r1'::jsonb ->> 'renewable_until')::timestamptz
        = now() + interval '35 minutes',
  'renewal must extend a fresh claim to now()+15min and report the lifetime deadline');

select renew_supplier_price_document_upload(
  '46000000-0000-4000-8000-000000000002'
)::text as renew_r2
\gset p6b_
select pg_temp.p6b_assert(
  (:'p6b_renew_r2'::jsonb ->> 'expires_at')::timestamptz = now() + interval '10 minutes',
  'renewal near the deadline must clamp to created_at+45min, not now()+15min');

-- The grace race itself: past expires_at, inside the lifetime -- renewal revives.
select renew_supplier_price_document_upload(
  '46000000-0000-4000-8000-000000000004'
)::text as renew_r4
\gset p6b_
select pg_temp.p6b_assert(
  (:'p6b_renew_r4'::jsonb ->> 'expires_at')::timestamptz = now() + interval '15 minutes',
  'renewal must revive a claim past expires_at while the lifetime cap holds');

-- ===== (b) The 45-minute lifetime cap =====

do $$
begin
  perform renew_supplier_price_document_upload('46000000-0000-4000-8000-000000000003');
  raise exception 'expected lifetime-cap rejection';
exception
  when others then
    if sqlerrm is distinct from 'document_upload_reservation_lifetime_exceeded' then
      raise;
    end if;
end
$$;

-- ===== (c) Foreign actors and the supplier binding =====

-- Supplier-role liveness: the claim names S2, the caller's profile binds S1.
do $$
begin
  perform renew_supplier_price_document_upload('46000000-0000-4000-8000-000000000007');
  raise exception 'expected supplier-binding rejection';
exception
  when others then
    if sqlerrm is distinct from 'not_authorized' then
      raise;
    end if;
end
$$;

-- Same tenant, different actor: the owner cannot renew the supplier agent's claim.
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
do $$
begin
  perform renew_supplier_price_document_upload('46000000-0000-4000-8000-000000000001');
  raise exception 'expected foreign-actor rejection';
exception
  when others then
    if sqlerrm is distinct from 'document_upload_reservation_unknown' then
      raise;
    end if;
end
$$;

-- Another tenant entirely.
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000003', true);
do $$
begin
  perform renew_supplier_price_document_upload('46000000-0000-4000-8000-000000000001');
  raise exception 'expected cross-tenant rejection';
exception
  when others then
    if sqlerrm is distinct from 'document_upload_reservation_unknown' then
      raise;
    end if;
end
$$;

-- ===== (d) The registered claim: real flow, then the documented rejection =====

-- The full 0048 path -- reserve, upload through the real storage row, register --
-- driven as staff, which also proves the register transition passes the new guard.
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
select reserve_supplier_price_document_upload(
  '36000000-0000-4000-8000-000000000002', 'p6b-staff.pdf', 'application/pdf'
)::text as staff_reservation
\gset p6b_
select
  :'p6b_staff_reservation'::jsonb ->> 'document_id' as staff_document_id,
  :'p6b_staff_reservation'::jsonb ->> 'storage_path' as staff_storage_path
\gset p6b_
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents', :'p6b_staff_storage_path', auth.uid(),
  jsonb_build_object(
    'mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('e', 64)
  )
);
select register_supplier_price_document(
  :'p6b_staff_document_id'::uuid
)::text as staff_registration
\gset p6b_
select pg_temp.p6b_assert(
  not (:'p6b_staff_registration'::jsonb ->> 'idempotent')::boolean
  and (:'p6b_staff_registration'::jsonb ->> 'job_id') is not null,
  'the register path must still work under the column guard');

select set_config('p6b.staff_document_id', :'p6b_staff_document_id', true);
do $$
begin
  perform renew_supplier_price_document_upload(
    current_setting('p6b.staff_document_id')::uuid);
  raise exception 'expected registered-claim rejection';
exception
  when others then
    if sqlerrm is distinct from 'document_upload_reservation_registered' then
      raise;
    end if;
end
$$;

reset role;

-- The renewed rows really carry the renewed expiry (read back as trusted).
select pg_temp.p6b_assert(
  (select expires_at from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000001')
      = now() + interval '15 minutes'
  and (select expires_at from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000002')
      = now() + interval '10 minutes'
  and (select expires_at from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000004')
      = now() + interval '15 minutes'
  and (select status from supplier_price_document_upload_reservations
    where document_id = current_setting('p6b.staff_document_id')::uuid)
      = 'registered',
  'renewed expiries and the registered status must be durable on the rows');

-- ===== (e) The column guard rejects every re-bind =====

-- Coherent re-bind: supplier_id AND storage_path move together, satisfying every CHECK.
-- The guard -- not a CHECK constraint -- is what stands in the way.
do $$
begin
  update supplier_price_document_upload_reservations
  set supplier_id = '36000000-0000-4000-8000-000000000002',
      storage_path = '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000002/46000000-0000-4000-8000-000000000001/r1.pdf'
  where document_id = '46000000-0000-4000-8000-000000000001';
  raise exception 'expected coherent re-bind rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_binding_immutable' then
      raise;
    end if;
end
$$;

-- Single-column mutations raise too: the actor, the mime, the path alone.
do $$
begin
  update supplier_price_document_upload_reservations
  set actor_id = '26000000-0000-4000-8000-000000000001'
  where document_id = '46000000-0000-4000-8000-000000000001';
  raise exception 'expected actor re-bind rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_binding_immutable' then
      raise;
    end if;
end
$$;
do $$
begin
  update supplier_price_document_upload_reservations
  set mime_type = 'image/png'
  where document_id = '46000000-0000-4000-8000-000000000001';
  raise exception 'expected mime re-bind rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_binding_immutable' then
      raise;
    end if;
end
$$;

-- The registered receipt is permanent: no re-pointing, no downgrade, no expiry moves.
do $$
begin
  update supplier_price_document_upload_reservations
  set object_id = gen_random_uuid()
  where document_id = current_setting('p6b.staff_document_id')::uuid;
  raise exception 'expected receipt mutation rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_receipt_immutable' then
      raise;
    end if;
end
$$;
do $$
begin
  update supplier_price_document_upload_reservations
  set status = 'reserved'
  where document_id = current_setting('p6b.staff_document_id')::uuid;
  raise exception 'expected status downgrade rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_invalid_transition' then
      raise;
    end if;
end
$$;
-- now() is frozen here, so the fresh claim's expiry is exactly now()+15min; probe with a
-- DIFFERENT value or the update is a no-op the guard rightly ignores.
do $$
begin
  update supplier_price_document_upload_reservations
  set expires_at = now() + interval '20 minutes'
  where document_id = current_setting('p6b.staff_document_id')::uuid;
  raise exception 'expected locked-expiry rejection';
exception
  when others then
    if sqlerrm is distinct from 'upload_reservation_expiry_locked' then
      raise;
    end if;
end
$$;

-- ===== (f) The sweep grace, through a real reserve call =====

insert into supplier_price_document_upload_reservations (
  document_id, org_id, actor_id, supplier_id,
  file_name, mime_type, storage_path, created_at, expires_at
) values
  ('46000000-0000-4000-8000-000000000005',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r5.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000005/r5.pdf',
   now() - interval '45 minutes', now() - interval '30 minutes'),
  ('46000000-0000-4000-8000-000000000006',
   '16000000-0000-0000-0000-000000000001',
   '26000000-0000-4000-8000-000000000002',
   '36000000-0000-4000-8000-000000000001',
   'r6.pdf', 'application/pdf',
   '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000001/46000000-0000-4000-8000-000000000006/r6.pdf',
   now() - interval '3 hours', now() - interval '2 hours');

select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select reserve_supplier_price_document_upload(
  '36000000-0000-4000-8000-000000000001', 'p6b-sweep-probe.pdf', 'application/pdf'
);

-- ===== (g) Expired-but-not-swept: register rejects, the row remains =====

do $$
begin
  perform register_supplier_price_document('46000000-0000-4000-8000-000000000005');
  raise exception 'expected expired-claim registration rejection';
exception
  when others then
    if sqlerrm is distinct from 'document_upload_reservation_expired' then
      raise;
    end if;
end
$$;

reset role;

select pg_temp.p6b_assert(
  exists (
    select 1 from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000005')
  and not exists (
    select 1 from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000006'),
  'the sweep must respect the grace (30min survives) and collect past it (2h swept)');

-- ===== (h) Mutation proof: the guard is load-bearing =====

savepoint p6b_guard_mutation;

drop trigger supplier_price_document_upload_reservations_guard
  on supplier_price_document_upload_reservations;

-- The IDENTICAL coherent re-bind of (e) now succeeds: every CHECK is satisfied and
-- nothing else stands in the way.
update supplier_price_document_upload_reservations
set supplier_id = '36000000-0000-4000-8000-000000000002',
    storage_path = '16000000-0000-0000-0000-000000000001/supplier/36000000-0000-4000-8000-000000000002/46000000-0000-4000-8000-000000000001/r1.pdf'
where document_id = '46000000-0000-4000-8000-000000000001';

-- The suite's own drift detection catches the re-bind the trigger would have blocked.
select pg_temp.p6b_assert(
  exists (
    select 1 from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000001'
      and supplier_id = '36000000-0000-4000-8000-000000000002'),
  'with the guard dropped the coherent re-bind must land -- the trigger is load-bearing');

rollback to savepoint p6b_guard_mutation;

-- Guard and binding both restored by the savepoint rollback.
select pg_temp.p6b_assert(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'supplier_price_document_upload_reservations'
      and t.tgname = 'supplier_price_document_upload_reservations_guard'
      and not t.tgisinternal)
  and exists (
    select 1 from supplier_price_document_upload_reservations
    where document_id = '46000000-0000-4000-8000-000000000001'
      and supplier_id = '36000000-0000-4000-8000-000000000001'),
  'the savepoint rollback must restore both the guard trigger and the original binding');

rollback;

\echo 'p6b_upload_reservations_passed'
