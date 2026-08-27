-- 0213 -- the interface language a person chose, stored per person.
--
-- WHY PER PERSON AND NOT PER ORGANISATION. One tenant can employ a Hebrew-speaking buyer and an
-- English-speaking accountant. A language forced from `organizations` would be wrong for one of
-- them on every screen, every day, with no way for them to fix it. `role_labels` is the precedent
-- for a tenant-wide vocabulary override and it is deliberately NOT the precedent here: what a
-- tenant calls a role is the tenant's decision, what language a person reads in is theirs.
--
-- WHY `null` IS NOT `'he'`. Three states exist and only two of them are a language:
--     null  -- never chose. The client detects from `navigator.language`, every session.
--     'he'  -- chose Hebrew. Detection is overridden, permanently, including on an English browser.
--     'en'  -- chose English.
-- Collapsing `null` into `'he'` would freeze the first detection for ever: an English speaker who
-- never opened Settings would be pinned to Hebrew by a default nobody set, and would have no way
-- to tell that from a choice they had made. The distinction is the feature.
--
-- WHY A CHECK CONSTRAINT AND NOT AN ENUM. CLAUDE.md: `user_role` is embedded in 77 RLS policies
-- and must not be altered. A migration that reached for `create type` here would teach the next
-- reader that adding enums to this schema is routine. A check constraint carries the same contract,
-- is alterable in place when a third language arrives, and needs no cast anywhere.
--
-- THE PART THAT IS NOT OPTIONAL: 0020's COLUMN GUARD.
-- `profiles_guard_privileged_columns` (0006:100, redefined 0020:18) states its own rule --
-- "A future profile column is privileged by default" -- and enforces it by diffing the whole row
-- minus an allow-list. So `locale` is UNWRITABLE from the browser the moment it exists, and a
-- client `update profiles set locale = 'en'` would raise `profiles_column_not_browser_writable`.
-- That guard working is the reason this migration has to argue for the column rather than just add
-- it. `locale` joins the allow-list because it is genuinely self-service: it decides what the
-- person reading the screen sees, it grants nothing, it is bounded by a check constraint, and it
-- is already reachable through `profiles_self_update` (0020:12), which is scoped to
-- `id = auth.uid() and org_id = auth_org()`.
--
-- What it does NOT join: the `v_access_change` branch. Language is not access. Changing it must
-- not require `manage_profile_access`, must not demand owner, and must not write an audit row --
-- an audit row per language toggle would be noise in the ledger that records who was granted what.
--
-- ANCHORED REPLACEMENT (the 0137/0145/0148/0168/0207 pattern): read the LIVE definition, normalise
-- \r, replace named anchors, fail loudly if an anchor moved or matched a different number of times.
-- `profiles_guard_privileged_columns` has already been redefined once (0006 -> 0020); pasting
-- 0020's body back would silently revert anything a later migration changed in it.

alter table profiles
  add column if not exists locale text;

alter table profiles drop constraint if exists profiles_locale_supported;
alter table profiles add constraint profiles_locale_supported
  check (locale is null or locale in ('he', 'en'));

comment on column profiles.locale is
  'Interface language this person explicitly chose. NULL = never chose, and the client keeps '
  'detecting from the browser every session -- NULL is not Hebrew. Self-service: writable by the '
  'person themselves through profiles_self_update, and listed in '
  'profiles_guard_privileged_columns'' browser-writable allow-list. Grants nothing.';

do $profile_locale$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
  v_hits int;
begin
  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');

  -- Idempotent: a re-apply, or a later migration that already added the column, must not fail.
  if position('''locale''' in v_def) = 0 then

    -- (1) The allow-list itself. It appears twice -- once for `new`, once for `old` -- and both
    -- must move together, because a difference between the two would make the diff always true.
    v_anchor := 'array[''full_name'', ''phone'', ''role'', ''active'', ''supplier_id'']';
    v_replacement := 'array[''full_name'', ''phone'', ''locale'', ''role'', ''active'', ''supplier_id'']';
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 2 then
      raise exception '0213: expected the browser-writable allow-list twice in '
        'profiles_guard_privileged_columns, found % -- the guard was rewritten and this '
        'replacement must be re-read against the live body, not forced', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);

    -- (2) The comment that counts the fields. It said "the two self-service fields"; leaving it
    -- would make the body describe a rule it no longer implements, and the next reader trusts
    -- the comment before they trust the array.
    v_anchor := '  -- A future profile column is privileged by default. Browser writers may only touch the'
      || e'\n' || '  -- two self-service fields plus the three access fields owned by manage_profile_access().';
    v_replacement := '  -- A future profile column is privileged by default. Browser writers may only touch the'
      || e'\n' || '  -- three self-service fields (name, phone, locale -- none of which grant anything) plus the'
      || e'\n' || '  -- three access fields owned by manage_profile_access().';
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 1 then
      raise exception '0213: expected the allow-list comment once, found % -- re-read the live body', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);

    execute v_def;
  end if;
end
$profile_locale$;

-- A6: a tenant export knows the exact shape of every table it copies, and adding a column is
-- schema drift until someone says what the export does with it. `locale` is EXPORTED, not
-- excluded: it is the person's own stated preference, it is part of what "everything we hold
-- about this tenant" means, and it is neither a secret nor a credential. Re-derived here rather
-- than typed, the 0149/0137 pattern -- a hand-written hash is a hash that drifts.
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

do $assert_0213$
declare
  v_violations text;
  v_def text;
begin
  -- The property this migration creates, proved rather than assumed.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'locale'
  ) then
    raise exception '0213: profiles.locale was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_locale_supported'
  ) then
    raise exception '0213: the supported-locale constraint is missing';
  end if;

  v_def := replace(pg_get_functiondef(
    'public.profiles_guard_privileged_columns()'::regprocedure), e'\r', '');
  if position('''locale''' in v_def) = 0 then
    raise exception '0213: the column guard still treats locale as privileged, so no browser '
      'could ever write it -- the anchored replacement did not take';
  end if;

  -- The constraint really refuses an unsupported language, tested rather than trusted.
  begin
    begin
      update profiles set locale = 'de' where id = (select id from profiles limit 1);
      if found then
        raise exception '0213: the constraint accepted an unsupported locale';
      end if;
      raise exception '0213_probe_rollback';
    exception when check_violation then
      raise exception '0213_probe_rollback';
    end;
  exception when others then
    if sqlerrm <> '0213_probe_rollback' then raise; end if;
  end;

  -- 0058:207-218: a migration that touches a definer proves the scope contract still holds here,
  -- rather than three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0213 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0213 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0213$;
