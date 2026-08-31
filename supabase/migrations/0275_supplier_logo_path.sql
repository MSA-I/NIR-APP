-- 0275 — a supplier may carry a logo, and the path is the security boundary.
--
-- `0098` did this for the organisation and this file is deliberately the same shape rather than a
-- better one: same nullable pair, same CHECK on the path, same service-role setter with
-- compare-and-swap, same audit. A second spelling of the same idea is how the two drift until one
-- of them stops enforcing the tenant prefix.
--
-- WHY THE PATH IS A CHECK CONSTRAINT AND NOT A CONVENTION. The storage bucket's own policy reads
-- the first path segment as the organisation id. A row whose `logo_path` began with somebody
-- else's org id would point one tenant's supplier list at another tenant's bucket folder, and no
-- RLS policy on `suppliers` would notice -- the column is just text. The regex is what makes the
-- prefix unforgeable, and it names the supplier id too, so a path cannot be moved between
-- suppliers inside one tenant either.
--
-- AND THE PATH IS NEVER ACCEPTED FROM THE CLIENT. The Edge function builds it from the profile's
-- own org id and the supplier id it verified, then calls the setter below. The CHECK is the second
-- line, not the first.
--
-- WHAT THIS FILE REFUSES TO ENABLE, BY NAME: there is no fetching a logo from the supplier's
-- website, no favicon, and no third-party logo provider. An outbound request per supplier is an
-- SSRF and privacy surface with no proven external destination (`DEBT §5`), third-party trademark
-- licensing is unresolved, and an automatically fetched logo is a fact the system cannot prove.
-- The answer to "without maintaining a logo library by hand" is the monogram `0274`'s sibling
-- PR-19a already shipped: deterministic, accessible, and needing no library at all. A manual
-- upload is the exception a business chooses when it cares.

alter table public.suppliers
  add column if not exists logo_path text,
  add column if not exists logo_updated_at timestamptz;

-- BOTH OR NEITHER. A path with no timestamp cannot be cache-busted and a timestamp with no path is
-- a claim about a file that does not exist.
--
-- `logo_path is not null` IS LOAD-BEARING AND IS NOT REDUNDANT WITH THE REGEX. `0098` wrote this
-- constraint without it and the gap is real: with `logo_path` null the regex evaluates to NULL,
-- `NULL and true` is NULL, the first branch is false, and a CHECK whose result is NULL is
-- SATISFIED rather than violated. So `logo_path = null, logo_updated_at = now()` was accepted --
-- the exact half-state the constraint is named after. The suite writes that row, which is how this
-- was found rather than reasoned about.
--
-- `organizations` still carries the 0098 spelling and the same gap. It is a different table and a
-- different rollout, so it is reported rather than changed here.
alter table public.suppliers
  drop constraint if exists suppliers_logo_shape;
alter table public.suppliers
  add constraint suppliers_logo_shape check (
    (logo_path is null and logo_updated_at is null)
    or (
      logo_path is not null
      and logo_path ~ ('^' || org_id::text || '/suppliers/' || id::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$')
      and logo_updated_at is not null
    )
  ) not valid;
alter table public.suppliers validate constraint suppliers_logo_shape;

comment on column public.suppliers.logo_path is
  'Path inside the `organization-branding` bucket, or null (0275). Constrained to '
  '`{org_id}/suppliers/{supplier_id}/{uuid}.{png|jpg|webp}` so it cannot address another tenant''s '
  'folder or another supplier''s. Written only by set_supplier_branding_reference; the browser '
  'holds no UPDATE privilege on it.';

comment on column public.suppliers.logo_updated_at is
  'When the logo last changed (0275). Paired with logo_path by a CHECK: one without the other is '
  'either an uncacheable file or a claim about a file that is not there.';

-- THE BROWSER CANNOT WRITE EITHER COLUMN. Without this a tenant could PATCH `logo_path` directly
-- to any string matching the regex -- including a path belonging to a supplier it can see but has
-- no business rebranding -- with no reason recorded anywhere.
revoke update (logo_path, logo_updated_at) on public.suppliers from authenticated;

-- AND IT MUST BE GRANTED READ, EXPLICITLY. `suppliers` has COLUMN-level SELECT grants rather than a
-- table-level one -- that is how `0112` hid `bank_details`, because a column privilege is the only
-- thing that can hide a column when RLS cannot. A column added afterwards is NOT covered by the
-- existing grant, so without this line `logo_path` is unreadable, `SUPPLIER_COLUMNS` names it,
-- PostgreSQL refuses the whole statement rather than the one column, and the supplier list returns
-- 403. `supplierColumns.ts` records what that looked like the first time: three browser scenarios
-- timing out on "main heading did not become visible", twenty minutes into CI, with the 403 buried
-- in a network log. The suite asserts the read privilege for exactly that reason.
grant select (logo_path, logo_updated_at) on public.suppliers to authenticated;

-- ===== The setter =====
-- Same contract as `set_organization_branding_reference` (`0098:90-136`), with two differences,
-- both deliberate:
--
--   OWNER OR OFFICE, not owner alone. Supplier records are the office role's daily surface -- it
--   already creates suppliers and edits their details -- and a branding change that only the owner
--   can make would push the work to the wrong person rather than protect anything.
--
--   THE SUPPLIER IS RESOLVED INSIDE THE TENANT. `p_supplier_id` is filtered by the actor's own
--   org, so passing another tenant's supplier id finds nothing rather than writing anything.
create or replace function public.set_supplier_branding_reference(
  p_actor_id uuid,
  p_supplier_id uuid,
  p_expected_logo_path text,
  p_new_logo_path text,
  p_new_logo_updated_at timestamptz,
  p_reason text
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_supplier public.suppliers;
  v_org_id uuid;
  v_reason text := nullif(trim(p_reason), '');
begin
  -- SERVICE ROLE ONLY, and this is the whole reason the function can be INVOKER. The Edge function
  -- is the only caller; a definer version would have to re-derive an actor it was handed anyway.
  if auth.role() is distinct from 'service_role' then
    raise exception 'branding_service_role_required' using errcode = '42501';
  end if;
  if p_actor_id is null or p_supplier_id is null or v_reason is null
     or ((p_new_logo_path is null) is distinct from (p_new_logo_updated_at is null)) then
    raise exception 'branding_reference_invalid' using errcode = '22023';
  end if;

  select p.org_id into v_org_id
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = p_actor_id
    and p.active
    and p.role in ('owner', 'office')
    and o.status in ('trial', 'active');
  if not found then
    raise exception 'branding_actor_forbidden' using errcode = '42501';
  end if;

  select s.* into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id
    and s.org_id = v_org_id
    and s.deleted_at is null
  for update of s;
  if not found then
    raise exception 'branding_supplier_not_found' using errcode = 'P0002';
  end if;

  -- COMPARE AND SWAP. Two people replacing a logo at once would otherwise leave the row pointing
  -- at one file while the other sits orphaned in the bucket, and the caller could not tell which
  -- of the two won. Returning false lets the Edge function delete the file it just uploaded.
  if v_supplier.logo_path is distinct from p_expected_logo_path then
    return false;
  end if;

  perform set_config('app.organization_branding_actor', p_actor_id::text, true);
  perform set_config('app.organization_branding_reason', v_reason, true);
  update public.suppliers
  set logo_path = p_new_logo_path,
      logo_updated_at = p_new_logo_updated_at
  where id = v_supplier.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values,
                          reason)
  values (v_org_id, p_actor_id,
          case when p_new_logo_path is null then 'supplier_logo_removed'
               else 'supplier_logo_set' end,
          'suppliers', p_supplier_id,
          jsonb_build_object('logo_path', v_supplier.logo_path),
          jsonb_build_object('logo_path', p_new_logo_path),
          v_reason);
  return true;
end
$$;

revoke all on function public.set_supplier_branding_reference(
  uuid, uuid, text, text, timestamptz, text
) from public, anon, authenticated;

comment on function public.set_supplier_branding_reference(
  uuid, uuid, text, text, timestamptz, text
) is
  'Points one supplier at an uploaded logo, or clears it (0275). Service role only -- the Edge '
  'function that built the path is the sole caller. Compare-and-swap on the previous path so two '
  'simultaneous replacements cannot leave the row on one file and an orphan in the bucket. '
  'owner/office, actor and reason mandatory, audited either way.';

-- A NEW COLUMN ON AN EXPORTED TABLE DRIFTS ITS FINGERPRINT, and `A6` fails the migration rather
-- than letting the tenant export quietly disagree with the table. The logo belongs to the tenant
-- and leaves with it; the file itself is a separate concern the bucket owns.
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name = 'suppliers';

-- ===== Proof =====
do $verify_0275$
declare
  v_violations text;
  v_org uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'suppliers'
      and column_name = 'logo_path' and is_nullable = 'YES') then
    raise exception '0275: logo_path is missing or not nullable';
  end if;

  -- THE CONSTRAINT IS TESTED AS A PREDICATE, not by inserting a supplier: the assertion is about
  -- the regex, and building a whole tenant here to exercise it would test the fixture instead.
  -- A path under the right tenant and the right supplier is accepted...
  if not ((v_org::text || '/suppliers/' || v_supplier::text || '/'
           || gen_random_uuid()::text || '.png')
          ~ ('^' || v_org::text || '/suppliers/' || v_supplier::text
             || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$'))
  then
    raise exception '0275: a correctly built path was rejected by its own constraint';
  end if;

  -- ...and one that starts with a DIFFERENT organisation is not. This is the failure the column
  -- exists to make impossible, so it is measured rather than described.
  if (gen_random_uuid()::text || '/suppliers/' || v_supplier::text || '/'
      || gen_random_uuid()::text || '.png')
     ~ ('^' || v_org::text || '/suppliers/' || v_supplier::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$')
  then
    raise exception '0275: a path under another tenant matched the constraint';
  end if;

  -- And an extension nobody allowed does not slip through by being appended.
  if (v_org::text || '/suppliers/' || v_supplier::text || '/'
      || gen_random_uuid()::text || '.svg')
     ~ ('^' || v_org::text || '/suppliers/' || v_supplier::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$')
  then
    raise exception '0275: an svg path matched -- the bucket rejects it but the row would not';
  end if;

  if has_column_privilege('authenticated', 'public.suppliers', 'logo_path', 'UPDATE')
     or has_column_privilege('authenticated', 'public.suppliers', 'logo_updated_at', 'UPDATE') then
    raise exception '0275: the browser can write a branding column directly';
  end if;

  if has_function_privilege('authenticated',
       'public.set_supplier_branding_reference(uuid,uuid,text,text,timestamptz,text)', 'execute')
     or has_function_privilege('anon',
       'public.set_supplier_branding_reference(uuid,uuid,text,text,timestamptz,text)', 'execute')
  then
    raise exception '0275: a client role can execute the branding setter';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0275 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$verify_0275$;
