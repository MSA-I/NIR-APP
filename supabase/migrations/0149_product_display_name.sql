-- 0149 -- A canonical name for a product, kept apart from the name we match on (owner review, defect 16).
--
-- ==========================================================================================
-- WHAT THIS IS.
--
-- A product has one hand-typed `name`, and every screen renders it raw. The owner asked for a
-- canonical form -- product type, one meaningful size, no brand and no supplier filler. This file
-- adds the column that form lives in. It does not fill it, and it does not change what any screen
-- renders today.
--
-- WHY A SECOND COLUMN RATHER THAN A CLEANED `name`.
--
-- `name` is what MATCHING reads. `nameKey(product.name)` decides which spreadsheet row is which
-- catalogue row on every price-list intake, and the supplier-facing surfaces (the order image, the
-- WhatsApp message) deliberately send `name` too, because the supplier recognises THEIR name for
-- the thing. A canonical name we invented arriving at someone who has never seen it is a worse
-- outcome than an ugly one they recognise. So the raw name stays exactly where it is, keeps its
-- matching role, and keeps the audit trail of what was actually typed; the canonical name is a
-- separate, nullable, additive fact beside it.
--
-- WHY NO BACKFILL. THIS IS THE LOAD-BEARING DECISION IN THIS FILE.
--
-- Part of the live catalogue was imported from Hebrew spreadsheets and OCR in VISUAL order rather
-- than logical order: measured against production, 39 of 271 names have unbalanced parentheses and
-- 8 open with a closing parenthesis, e.g. a microfibre-cloth row whose text begins `)`. Those names
-- cannot be parsed -- their tokens are not in the order they mean -- and a parser fed one produces
-- a confident wrong answer. Backfilling would write that answer into a column that twenty-five
-- screens are meant to read, renaming real catalogue entries everywhere, at a rate of roughly one
-- in seven rows known-malformed before anyone looks at the rest.
--
-- So: nothing is written here. `display_name IS NULL` will mean "render `name`", which makes this
-- migration a strict NO-OP at render time -- doubly so, because no read model or screen reads the
-- column yet at all. Every value that ever lands in it will have been approved by a person, one row
-- at a time, through the command below. `src/lib/productDisplayName.ts` proposes those values and
-- REFUSES the malformed ones rather than guessing at them.
--
-- WHY THE COMMAND, AND WHY NO COLUMN GRANT.
--
-- 0036 put `products` behind COLUMN-level privileges, not a table-level UPDATE:
--   grant update (name, category_id, unit, sku, barcode, notes, min_stock) on products
-- A column added today is therefore ungranted to `authenticated` by construction, and no revoke is
-- needed to keep it that way. That is deliberate and it is asserted below rather than assumed:
-- renaming what every screen shows is a sensitive act, and the constitution requires a reason on
-- every one. The only door is set_product_display_name, which is owner/office, demands a reason,
-- and writes audit_logs -- the shape of set_product_active (0036) and soft_delete_supplier (0146).
--
-- No direct-write guard TRIGGER accompanies it, unlike `active`. A trigger would be guarding a door
-- that does not exist: `active` is ungranted AND has a trigger because the pairing predates the
-- column-privilege audit, whereas here the absence of the grant is the whole enforcement, and the
-- assertion below is what keeps it true.
--
-- No uniqueness constraint either. Two catalogue rows resolving to the same canonical name is a
-- real signal, but it is a signal for the reviewer, not a reason to refuse the write.
--
-- A5 / EXEMPTION PIN -- verified, not assumed.
--
-- set_product_display_name is SECURITY DEFINER and references `products` and `audit_logs`. A5 fires
-- only for a definer whose body names a table registered ENFORCED (0057:326-335). `products` is
-- registered ('org_global', enforced = false) at 0054:133 and `audit_logs` ('cross_scope',
-- enforced = false) at 0054:154; the enforced set is the twelve tables seeded true plus
-- payment_requests, flipped by 0073:249 -- and this function's body names none of them. It is
-- therefore not an A5 case at all, and needs no exemption row: the same footprint and the same
-- conclusion as platform_get_autonomy_policies (0147). The registry pin in p9_five_domains.sql
-- stays at 89, and `npm run check:exemptions` agrees by arithmetic.
-- ==========================================================================================

alter table public.products add column if not exists display_name text;

-- 120 is not a new number: it is the slice the OCR review path already applies to a product name
-- (PriceListReviewConfirmation.tsx) and the maxLength of the field a person types one into. The
-- constraint makes the empty string unrepresentable in the column, so "no canonical name" has
-- exactly one spelling -- NULL -- and no screen has to decide what a blank one means.
alter table public.products drop constraint if exists products_display_name_shape;
alter table public.products add constraint products_display_name_shape
  check (display_name is null or (btrim(display_name) <> '' and length(display_name) <= 120));

comment on column public.products.display_name is
  'The canonical, human-approved name for this product: product type and one meaningful size, with '
  'brand and supplier filler removed. NULL means "no canonical name has been approved" and readers '
  'must fall back to `name`. NEVER used for matching -- nameKey(name) remains the sole matching key '
  '-- and never sent to a supplier, who recognises their own wording. Written only by '
  'set_product_display_name, one reasoned row at a time; never backfilled, because names imported '
  'in visual rather than logical order cannot be parsed and a guess here renames a real catalogue '
  'entry on every screen at once.';

create or replace function public.set_product_display_name(
  p_product_id uuid,
  p_display_name text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_display text := btrim(coalesce(p_display_name, ''));
  v_next text;
  v_product public.products;
begin
  -- owner/office only. set_product_active admits kitchen because marking a line unavailable is a
  -- stock fact a cook owns; naming the catalogue is not, and this door is narrower on purpose.
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office') then
    raise exception 'product_display_name_not_authorized' using errcode = '42501';
  end if;
  if p_product_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- NULL clears the canonical name and returns the row to rendering its raw name -- a real and
  -- reversible act, so it is allowed, and it still costs a reason. A string that is present but
  -- blank is NOT that request: the caller asked to set a name and supplied none. Coercing it to a
  -- clear would silently perform a different action than the one asked for.
  if p_display_name is not null and v_display = '' then
    raise exception 'product_display_name_blank' using errcode = '22023';
  end if;
  v_next := nullif(v_display, '');

  if v_next is not null and length(v_next) > 120 then
    raise exception 'product_display_name_too_long' using errcode = '22023';
  end if;

  select p.* into v_product
  from public.products p
  where p.id = p_product_id and p.org_id = v_org
  for update;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;

  if v_product.display_name is not distinct from v_next then
    return jsonb_build_object(
      'product_id', v_product.id,
      'display_name', v_product.display_name,
      'idempotent', true
    );
  end if;

  update public.products
  set display_name = v_next
  where id = v_product.id and org_id = v_org;

  -- This reasoned row is written IN ADDITION to the generic products_audit trigger row (0063:296),
  -- exactly as set_product_active does: the generic trigger records that a row changed, but it has
  -- no reason to record, and a reason is the part the constitution requires. The two new actions
  -- below are deliberately absent from private.domain_event_map, and the fan-out inner-joins that
  -- map (0063:274-276), so an unmapped action emits no domain event rather than failing -- naming
  -- a product is a catalogue decision, not an event any consumer subscribes to.
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    case when v_next is null then 'product_display_name_cleared' else 'product_display_name_set' end,
    'products',
    v_product.id,
    -- The raw name travels with the record: a year from now, reading why a name was approved is
    -- only possible next to the text it was approved instead of.
    jsonb_build_object('display_name', v_product.display_name, 'name', v_product.name),
    jsonb_build_object('display_name', v_next, 'name', v_product.name),
    v_reason
  );

  return jsonb_build_object(
    'product_id', v_product.id,
    'display_name', v_next,
    'idempotent', false
  );
end
$$;

revoke all on function public.set_product_display_name(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_product_display_name(uuid, text, text) to authenticated;

comment on function public.set_product_display_name(uuid, text, text) is
  'The only door to products.display_name. Owner/office, reason mandatory, audited on every call '
  'including the clear. Passing NULL clears the canonical name and returns the product to rendering '
  'its raw name; passing a blank string is refused, because it is a request to set a name with no '
  'name in it. The column is deliberately absent from the 0036 client column grants, so this '
  'function is not merely the preferred path -- it is the only one a browser session has.';

-- 0036's own idiom (its lines 519-545): assert the privilege shape rather than trusting that no
-- later edit widened it. A `grant update (display_name) ... to authenticated` anywhere would make
-- the reason optional in practice, and that is exactly the kind of change that arrives quietly.
do $display_name_acl$
begin
  if has_column_privilege('authenticated', 'public.products', 'display_name', 'UPDATE')
     or has_column_privilege('authenticated', 'public.products', 'display_name', 'INSERT') then
    raise exception 'product_display_name_column_exposed' using errcode = '42501';
  end if;
  if not has_column_privilege('authenticated', 'public.products', 'display_name', 'SELECT') then
    raise exception 'product_display_name_unreadable' using errcode = '42501';
  end if;
end
$display_name_acl$;

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0149 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
