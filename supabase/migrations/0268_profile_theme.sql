-- 0268 -- the appearance a person chose, stored per person.
--
-- Owner ruling #8 of 31.08.2026 (OPEN-DECISIONS #309, ADR-0010): the light/dark choice persists
-- "on the device AND in the account". `localStorage` already covers the device and is what the
-- pre-paint script in index.html reads, so this column is the other half: a person who signs in on
-- a second machine meets the theme they chose rather than the default.
--
-- THIS IS 0253/0255 AGAIN, ON PURPOSE. `profiles.locale` and `profiles.backup_email` are the same
-- shape of thing — a per-person field that grants nothing — and between them they documented the two
-- gates that close a new profile column and the exact way a first version ships half-saved. Walking
-- the same steps is the point; deviating would mean re-learning that lesson.
--
-- WHY PER PERSON AND NOT PER ORGANISATION. Same argument as the language: one tenant employs
-- people who sit under different lighting, at different hours, with different eyes. A theme forced
-- from `organizations` would be wrong for somebody every day with no way to fix it.
--
-- WHY `null` IS NOT `'light'`. Three states, and only two of them are a choice:
--     null     -- never chose. The client uses its own default (light), and stays free to change
--                 that default later without overriding anybody.
--     'light'  -- chose light. Survives a future change of product default.
--     'dark'   -- chose dark.
-- Collapsing null into 'light' would make "the product's default" and "this person's decision"
-- indistinguishable, which is the same distinction 0253 preserved for `locale` and for the same
-- reason: a default nobody set must never look like a preference somebody expressed.
--
-- WHY A CHECK CONSTRAINT AND NOT AN ENUM. CLAUDE.md: `user_role` is embedded in 77 RLS policies and
-- must not be altered, and a `create type` here would teach the next reader that adding enums to
-- this schema is routine. A check constraint carries the same contract and is alterable in place.
--
-- THE TWO GATES, BOTH OF WHICH HAVE TO BE ARGUED (0253's hard-won lesson):
--   (1) `profiles_guard_privileged_columns` (0006:100, redefined 0020:18, again 0253) states "a
--       future profile column is privileged by default" and enforces it by diffing the whole row
--       minus an allow-list. Without joining that list, a browser `update profiles set theme` would
--       raise `profiles_column_not_browser_writable`.
--   (2) `0042_profile_self_service_acl.sql` revoked UPDATE on every column and granted it back to a
--       named few. Satisfying only (1) produces `42501 permission denied for table profiles` at
--       HTTP 403 — and 0253 records that this exact half-fix looked like it worked, because the
--       screen changed and `localStorage` made the choice survive a reload while the column stayed
--       NULL for every row. The same trap is live here: the theme is applied by an attribute and
--       remembered in storage, so a failed column write is invisible until somebody clears storage
--       on another machine.
--
-- WHAT IT DOES NOT JOIN: the `v_access_change` branch. Appearance is not access. It must not
-- require `manage_profile_access`, must not demand owner, and must not write an audit row — a row
-- per theme toggle would be noise in the ledger that records who was granted what.
--
-- ANCHORED REPLACEMENT, AND WHICH ANCESTOR TO COPY. `profiles_guard_privileged_columns` has been
-- redefined five times (0006 -> 0020 -> 0059 -> 0249 -> 0253 -> 0255), so pasting any prior body
-- back would silently revert whatever a later migration changed in it.
--
-- This migration follows **0255**, not 0253, and the difference is not cosmetic. 0253 hardcoded the
-- array literal it expected as its anchor -- and that anchor was ALREADY STALE by the time this
-- migration was written, because 0255 added `backup_email` to the same list in between. Copying
-- 0253 would therefore have failed against the live body. 0255 instead MATCHES the literal with a
-- regex, appends to whatever it finds, and DERIVES the prose that counts the fields from the array
-- it just built. The shape below cannot go stale, because it never states what it expects to find.
--
-- Reading the live body is also why `replace(..., e'\r', '')` is not optional: a body created on
-- Windows carries CRLF and a multi-line anchor built with `e'\n'` would match in CI and fail in
-- production. `check:anchored-replacements` enforces exactly that.

alter table profiles
  add column if not exists theme text;

alter table profiles drop constraint if exists profiles_theme_supported;
alter table profiles add constraint profiles_theme_supported
  check (theme is null or theme in ('light', 'dark'));

comment on column profiles.theme is
  'Light/dark appearance this person explicitly chose. NULL = never chose, and the client uses its '
  'own default -- NULL is not ''light''. Self-service: writable by the person themselves through '
  'profiles_self_update, and listed in profiles_guard_privileged_columns'' browser-writable '
  'allow-list. Grants nothing. Owner ruling #8 of 31.08.2026.';

do $profile_theme$
declare
  v_def text;
  v_array_old text;
  v_array_new text;
  v_self_fields text;
  v_hits int;
begin
  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');

  -- Idempotent: a re-apply, or a later migration that already added the column, must not fail.
  if position('''theme''' in v_def) = 0 then

    -- (1) The allow-list itself, FOUND rather than typed. 0253 hardcoded the array it expected and
    -- that anchor was already stale by the time this migration was written — 0255 added
    -- `backup_email` to the same list in between. 0255's own approach is the one that survives:
    -- match the literal, append to it, and let whatever the previous migration left stand.
    v_array_old := (regexp_match(v_def, 'array\[''full_name''[^\]]*\]'))[1];
    if v_array_old is null then
      raise exception '0268: the browser-writable allow-list is no longer an array literal '
        'beginning with ''full_name'' in profiles_guard_privileged_columns -- the guard was '
        'rewritten and this replacement must be re-read against the live body, not forced';
    end if;
    -- Twice -- once for `new`, once for `old` -- and both must move together, because a difference
    -- between the two would make the diff always true.
    v_hits := (length(v_def) - length(replace(v_def, v_array_old, ''))) / length(v_array_old);
    if v_hits <> 2 then
      raise exception '0268: expected the browser-writable allow-list twice in '
        'profiles_guard_privileged_columns, found % -- the guard was rewritten and this '
        'replacement must be re-read against the live body, not forced', v_hits;
    end if;
    v_array_new := left(v_array_old, length(v_array_old) - 1) || ', ''theme'']';
    v_def := replace(v_def, v_array_old, v_array_new);

    -- (2) The prose that counts the fields. Derived from the array just built rather than typed, so
    -- the sentence cannot disagree with the code three lines below it. 0253 learned this the
    -- expensive way: the next reader trusts the comment before they trust the array.
    select string_agg(btrim(field, ''''), ', ' order by ord)
      into v_self_fields
    from unnest(string_to_array(
           replace(replace(v_array_new, 'array[', ''), ']', ''), ', ')
         ) with ordinality as listed(field, ord)
    where btrim(field, '''') not in ('role', 'active', 'supplier_id');

    v_hits := (select count(*)::int from regexp_matches(
      v_def, 'Browser writers may only touch the', 'g'));
    if v_hits <> 1 then
      raise exception '0268: expected the allow-list comment once, found % -- re-read the live body',
        v_hits;
    end if;

    -- `\1` and `\2` are backreferences and must stay OUT of the E-string: inside one, `\2` is an
    -- octal escape and would put a control character into the function body instead of the tail it
    -- is standing in for.
    v_def := regexp_replace(
      v_def,
      '(Browser writers may only touch the).*?(access fields owned by manage_profile_access\(\)\.)',
      '\1' || e'\n  -- self-service fields (' || v_self_fields
            || ' -- none of which grant anything) plus the three ' || '\2');

    -- The derived list, not the boilerplate around it: the surrounding sentence is already in the
    -- live body, so asserting on it would pass whether or not the replacement took.
    if position(v_self_fields in v_def) = 0 then
      raise exception '0268: the allow-list comment still does not name [%] -- the replacement did '
        'not take and the body would describe a rule it no longer implements', v_self_fields;
    end if;

    execute v_def;
  end if;
end
$profile_theme$;

-- The second gate: 0042's column ACL. Additive and narrow -- UPDATE on `theme` alone, so the
-- self-service surface widens by exactly one column whose only power is which of two grounds a
-- person reads their own screen on.
grant update (theme) on table public.profiles to authenticated;

-- A6: a tenant export knows the exact shape of every table it copies, and adding a column is schema
-- drift until someone says what the export does with it. `theme` is EXPORTED, not excluded: it is
-- the person's own stated preference, part of what "everything we hold about this tenant" means,
-- and neither a secret nor a credential. Re-derived rather than typed (0149/0137): a hand-written
-- hash is a hash that drifts.
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
where registry.table_name = 'profiles';

do $assert_0268$
declare
  v_violations text;
  v_def text;
  v_granted text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'theme'
  ) then
    raise exception '0268: profiles.theme was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_theme_supported'
  ) then
    raise exception '0268: the supported-theme constraint is missing';
  end if;

  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');
  if position('''theme''' in v_def) = 0 then
    raise exception '0268: the column guard still treats theme as privileged, so no browser could '
      'ever write it -- the anchored replacement did not take';
  end if;

  -- The second gate, asserted separately from the first, because passing one and failing the other
  -- is the exact state 0253 was written in before it was measured. `has_column_privilege` rather
  -- than a probe as the wrong role: reading as a denied role segfaults this backend.
  if not has_column_privilege('authenticated', 'public.profiles', 'theme', 'update') then
    raise exception '0268: authenticated cannot UPDATE profiles.theme -- 0042''s column ACL still '
      'closes it, so the switch would change the screen and save nothing to the account';
  end if;

  -- ...and nothing else was granted along the way. The EXACT list, following 0255 rather than a
  -- count: a count passes when one column is swapped for another, which is the failure that would
  -- matter most on this table.
  select string_agg(column_name, ', ' order by column_name)
    into v_granted
  from information_schema.column_privileges
  where table_schema = 'public' and table_name = 'profiles'
    and grantee = 'authenticated' and privilege_type = 'UPDATE';
  if v_granted is distinct from
     'active, backup_email, full_name, locale, phone, role, supplier_id, theme' then
    raise exception '0268: the profiles self-service ACL is now [%], not 0042''s five columns plus '
      'locale, backup_email and theme -- something else was granted along the way', v_granted;
  end if;

  -- The constraint really refuses an unsupported value, tested rather than trusted.
  begin
    begin
      update profiles set theme = 'sepia' where id = (select id from profiles limit 1);
      if found then
        raise exception '0268: the constraint accepted an unsupported theme';
      end if;
      raise exception '0268_probe_rollback';
    exception when check_violation then
      raise exception '0268_probe_rollback';
    end;
  exception when others then
    if sqlerrm <> '0268_probe_rollback' then raise; end if;
  end;

  -- 0058:207-218: a migration that touches a definer proves the scope contract here rather than
  -- three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0268 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0268 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0268$;
