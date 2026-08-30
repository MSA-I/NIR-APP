-- 0258 -- the setup wizard is an errand that can END.
--
-- WHAT WAS WRONG. `/onboarding` was catalogued for the owner permanently. The sidebar's account
-- group, the desktop avatar menu and the dashboard's first-run banner all offered it, and none of
-- them could ever stop: the banner's only condition is that the supplier count is zero
-- (Dashboard.tsx), and the menu entry is a constant of the role catalogue (Layout.tsx). An owner
-- who had opened an account, named the business, imported a catalogue and started working was
-- still shown "set the system up" every session, beside Settings, for ever. Their words: if I
-- already opened an account and signed in, why am I being shown this a second time.
--
-- The wizard DID record a finish. It wrote `completedAt` into `localStorage`, where no other
-- screen reads it and where a second browser never sees it. So the one fact that could have
-- closed the errand was the one fact the product could not act on.
--
-- OWNER DECISION (30.08.2026): an owner who explicitly presses finish stops being offered the
-- wizard in the navigation. It stays reachable from Settings, because that same screen is also
-- the bulk import path -- a business that buys a new price list in six months needs it again.
--
-- WHY AN EXPLICIT STATEMENT AND NOT DERIVED COUNTS. The wizard already derives PER-STEP
-- completion from live counts, and that stays: it is the honest way to draw a checkmark, and it
-- is why re-opening the wizard on a new device shows true state rather than a remembered claim.
-- But "am I finished setting up" is not a fact about rows. An owner can finish deliberately with
-- no products yet, and an owner can have twenty suppliers imported by a colleague and still not
-- consider themselves set up. The decision recorded here is the owner's own, so it is stored as
-- their statement and not inferred from a count.
--
-- WHY A COLUMN AND NOT A `settings` KEY. The settings screen writes that object wholesale on
-- save, so a key living there would be cleared by an unrelated screen. That is exactly why
-- Onboarding.tsx refused to put wizard state in `settings` and reached for `localStorage`
-- instead; this column is the dedicated home that comment asked for.
--
-- THE TWO GATES ON THIS TABLE, BOTH OF WHICH HAVE TO BE ARGUED (the 0253 lesson):
--   1. `organizations_guard_lifecycle` (0020, redefined by 0098) diffs the whole row minus an
--      allow-list, so a NEW column is platform-controlled by default and a browser write raises
--      `organization_lifecycle_rpc_required`.
--   2. 0036's column ACL grants UPDATE on exactly name, vat_rate and settings. A new column is
--      closed there too, and satisfying only the trigger produces `42501 permission denied`.
-- Passing one and failing the other is a finish button that changes nothing and reports success.
--
-- ANCHORED REPLACEMENT, not a paste of 0020's body: the guard has already been redefined once
-- (0020 -> 0098, which added the branding columns), and re-declaring the original body here would
-- silently lock branding out again.

alter table public.organizations
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.organizations.onboarding_completed_at is
  'When the owner said the setup wizard was finished. NULL = never said so, and /onboarding is '
  'still offered in the navigation. Tenant-owned: the owner writes it themselves through '
  'org_update, it grants nothing, and per-step completion is still derived from live row counts '
  'rather than from this column.';

do $onboarding_finish$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
  v_hits int;
begin
  v_def := replace(pg_get_functiondef(
    'public.organizations_guard_lifecycle()'::regprocedure), e'\r', '');

  -- Idempotent: a re-apply, or a later migration that already added the column, must not fail.
  if position('''onboarding_completed_at''' in v_def) = 0 then
    -- The allow-list appears twice -- once for `new`, once for `old` -- and both must move
    -- together, because a difference between the two would make the diff always true and close
    -- the table to its own tenant.
    v_anchor := 'array[''name'', ''vat_rate'', ''settings'', ''logo_path'', ''logo_updated_at'']';
    v_replacement := 'array[''name'', ''vat_rate'', ''settings'', ''logo_path'', '
      || '''logo_updated_at'', ''onboarding_completed_at'']';
    v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_hits <> 2 then
      raise exception '0258: expected the tenant-owned allow-list twice in '
        'organizations_guard_lifecycle, found % -- the guard was rewritten and this replacement '
        'must be re-read against the live body, not forced', v_hits;
    end if;
    v_def := replace(v_def, v_anchor, v_replacement);
    execute v_def;
  end if;
end
$onboarding_finish$;

-- The second gate: 0036's column ACL. Additive and narrow -- UPDATE on this one column, nothing
-- else touched, and the column's only power is whether a menu entry is offered.
grant update (onboarding_completed_at) on table public.organizations to authenticated;

do $assert_0258$
declare
  v_violations text;
  v_def text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'organizations'
       and column_name = 'onboarding_completed_at'
  ) then
    raise exception '0258: organizations.onboarding_completed_at was not created';
  end if;

  v_def := replace(pg_get_functiondef(
    'public.organizations_guard_lifecycle()'::regprocedure), e'\r', '');
  if position('''onboarding_completed_at''' in v_def) = 0 then
    raise exception '0258: the lifecycle guard still treats the finish statement as '
      'platform-controlled, so an owner pressing finish would be refused -- the anchored '
      'replacement did not take';
  end if;
  if position('''logo_path''' in v_def) = 0 then
    raise exception '0258: the replacement dropped 0098''s branding columns from the tenant-owned '
      'allow-list -- an old body was pasted over the live one';
  end if;

  -- The second gate, asserted separately from the first, because passing one and failing the
  -- other is the exact state a half-finished version of this migration leaves behind.
  -- `has_column_privilege` rather than a probe as the wrong role: reading as a denied role
  -- segfaults this backend.
  if not has_column_privilege('authenticated', 'public.organizations',
                              'onboarding_completed_at', 'update') then
    raise exception '0258: authenticated cannot UPDATE organizations.onboarding_completed_at -- '
      '0036''s column ACL still closes it, so finish would save nothing';
  end if;

  -- ...and 0036's three columns are untouched. A migration that widened the tenant-writable
  -- surface by accident would pass every check above.
  if (select count(*) from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'organizations'
         and grantee = 'authenticated' and privilege_type = 'UPDATE') <> 4 then
    raise exception '0258: the organizations tenant ACL is no longer 0036''s three columns plus '
      'the finish statement -- something else was granted along the way';
  end if;

  -- 0058:207-218: a migration that touches a definer proves the scope contract here, rather than
  -- three hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0258 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0258$;
