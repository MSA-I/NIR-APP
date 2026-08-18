-- 0145 -- Drafts become searchable, for the two roles that can resume them.
--
-- THE GAP, measured on the live project (18.08.2026): an owner typing "טיוטה" or a product
-- name that only appears inside their unfinished order gets "לא נמצאו תוצאות". A draft is a
-- purchase_requests row (status='draft', 0018), resumed at /orders/new?draft=<id>; the order
-- branch of global_search reads only purchase_orders (0069:107-116), so the one document a
-- buyer is actively working on is the one document the search cannot find.
--
-- WHO RECEIVES DRAFT HITS: owner and office -- the roles that reach /orders/new. accountant
-- does not (route is STAFF), and the fail-closed else arm stays. WITHIN those roles the branch
-- is fenced to created_by = auth.uid(): the resume screen loads only the caller's own draft
-- (NewOrder.tsx queries status='draft' AND created_by = profile.id), and 0117's rule holds --
-- a result that links somewhere the caller cannot open is worse than no result. The fence is
-- explicit in the branch, not delegated to RLS, because p9 exercises this function as the
-- table owner, where RLS does not bind.
--
-- ANCHORED REPLACEMENT, not create-or-replace (the 0117/0137 pattern): the live body already
-- carries 0117's kitchen narrowing, 0133's persona retirement and 0137/0139's payable fence.
-- Writing any migration's full text back would erase whichever of those came later. Every
-- anchor is single-line on purpose -- a multi-line anchor breaks if the stored body's line
-- endings differ from this file's (the CRLF trap docs/DEBT-REGISTER.md knows).

do $$
declare
  v_def text;
  -- Gate rows: append 'draft' to the two roles that can open /orders/new.
  v_owner_old constant text :=
    'when ''owner''      then array[''supplier'', ''product'', ''invoice'', ''order'', ''payment'', ''credit'']';
  v_owner_new constant text :=
    'when ''owner''      then array[''supplier'', ''product'', ''invoice'', ''order'', ''payment'', ''credit'', ''draft'']';
  v_office_old constant text :=
    'when ''office''     then array[''supplier'', ''product'', ''invoice'', ''order'', ''credit'']';
  v_office_new constant text :=
    'when ''office''     then array[''supplier'', ''product'', ''invoice'', ''order'', ''credit'', ''draft'']';
  -- The derived-table close is the single ') hits' in the body; the draft branch goes right
  -- before it, as the last UNION ALL arm.
  v_close_old constant text := ') hits';
  v_branch constant text := $draft$union all
    -- טיוטות הזמנה (0145): רק היוצר יכול להמשיך טיוטה, ולכן רק הוא מקבל אותה כתוצאה.
    (select 'draft'::text, r.id, '#' || r.number::text,
            nullif(concat_ws(' · ', 'טיוטת הזמנה', r.notes), ''),
            'draft'::text, null::numeric(12,2), r.updated_at::date,
            (case when r.number::text like like_pre then 1 else 2 end)::int
     from purchase_requests r
     where 'draft' = any(v_types)
       and r.org_id = auth_org() and r.status = 'draft' and r.created_by = auth.uid()
       and (r.number::text like like_pre
            or r.notes ilike like_any
            -- "טיוטה" is how the searcher actually asks for this list.
            or 'טיוטה' ilike like_any
            or exists (select 1 from purchase_request_items ri
                       join products p2 on p2.id = ri.product_id
                       where ri.request_id = r.id and p2.name ilike like_any))
     order by (case when r.number::text like like_pre then 1 else 2 end), r.updated_at desc
     limit per_type)
  ) hits$draft$;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'global_search';
  if v_def is null then
    raise exception '0145: public.global_search is gone.';
  end if;

  -- Idempotent (the 0117:44-50 lesson): re-running must recognise ITS OWN result — the exact
  -- owner row it writes, not any 'draft' literal a later patch might introduce for another
  -- reason (a bare-literal probe would then skip this migration silently).
  if position(v_owner_new in v_def) > 0 then
    return;
  end if;

  if position(v_owner_old in v_def) = 0 then
    raise exception
      '0145: the owner row of the search type gate matches neither its anchor nor its own '
      'result. Fix the anchor deliberately rather than letting this migration guess.';
  end if;
  if position(v_office_old in v_def) = 0 then
    raise exception '0145: the office row of the search type gate does not match its anchor.';
  end if;
  if position(v_close_old in v_def) = 0 then
    raise exception '0145: the derived-table close '') hits'' is not where 0069 left it.';
  end if;

  v_def := replace(v_def, v_owner_old, v_owner_new);
  v_def := replace(v_def, v_office_old, v_office_new);
  v_def := replace(v_def, v_close_old, v_branch);
  execute v_def;
end
$$;

comment on function public.global_search(text, integer) is
  'Cross-entity search whose reachable result TYPES are decided here, from auth_role(), not in '
  'the browser (0069, narrowed 0117, drafts added 0145). owner and office also receive their '
  'OWN purchase-request drafts (created_by fence -- a draft resumes only for its creator at '
  '/orders/new?draft=). accountant and every unresolvable role keep failing closed.';

-- ===== A1/A3/A5 re-assertion (the 0058:207-218 idiom) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0145 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'global_search';

  -- (a) The draft branch exists and carries its personal fence.
  if position('r.created_by = auth.uid()' in v_src) = 0 then
    raise exception
      '0145: the draft branch lost its created_by fence -- a draft hit would link to a resume '
      'screen that loads someone else''s work or nothing.';
  end if;

  -- (b) 0137''s payable fence survived the round trip through pg_get_functiondef.
  if position('financial_role' in v_src) = 0 then
    raise exception
      '0145: the invoice branch lost the financial_role fence 0137 installed -- supporting '
      'evidence would surface as ordinary invoices.';
  end if;

  -- (c) accountant did not gain drafts, and the gate still fails closed.
  if position('when ''accountant'' then array[''invoice'', ''payment'', ''credit'']' in v_src) = 0 then
    raise exception '0145: the accountant row changed -- that role has no /orders/new.';
  end if;
  if position('else ''{}''::text[]' in v_src) = 0 then
    raise exception '0145: the search no longer fails closed for an unrecognised role.';
  end if;
end
$$;
