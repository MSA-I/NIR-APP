-- 0067_barcode_lookup_index.sql
-- Wave 8 (PLAN-09 §2): ONE index, so that scanning a barcode is a tenant-scoped lookup
-- instead of a sequential scan over the whole catalogue.
--
-- products.barcode exists since 0001:94 and is already read by global search (0011:63)
-- and writable through the 0036 column grants. Nothing about the column changes here.
-- The only thing missing was an access path for the one new question the scanner asks:
-- "which product in THIS organization answers this code".
--
-- WHY THE INDEX IS NOT UNIQUE -- a product decision, not an oversight:
-- matchDeliveryLineProduct (src/components/document-review/model.ts:358-363) treats
-- ambiguity as a NON-match on purpose -- "two products answering to the same code means
-- the catalogue cannot say which one arrived, and picking either would be a guess about
-- goods and money". A unique index would make that rule unreachable by forbidding the
-- very state it exists to handle, and it would reject a legitimate catalogue (the same
-- EAN on a product and its re-packaged twin) at INSERT time with a Postgres string
-- instead of a Hebrew sentence. The scanner therefore stays honest about ambiguity and
-- the database stays a lookup, not a uniqueness authority. The demo seed carries a
-- deliberate pair sharing one barcode so the ambiguity path is provable end to end.
--
-- Partial (`where barcode is not null`): most rows carry no barcode, and a NULL is never
-- a search key. Column order (org_id, barcode) matches every other tenant lookup and
-- lets the org_id prefix serve the RLS predicate.

create index if not exists products_org_barcode_idx
  on products (org_id, barcode)
  where barcode is not null;

comment on index public.products_org_barcode_idx is
  'Tenant-scoped barcode lookup for the wave-8 receiving scanner (PLAN-09 SS2). '
  'Deliberately NOT unique: model.ts:358-363 treats two products answering one code as '
  'a non-match rather than a guess, and uniqueness would forbid the state that rule '
  'exists to handle. Partial on barcode is not null -- a NULL is never a search key.';

-- Re-assert block, the 0064 ancestry idiom (0064:546-566): a migration that claims to
-- have created an access path fails the reset if the path is not actually there and
-- shaped as described. Without this, a `create index if not exists` that no-ops against a
-- drifted catalogue -- an index of the same name on other columns, or a UNIQUE one added
-- out of band -- would be indistinguishable from success.
do $$
declare
  v_def text;
  v_unique boolean;
begin
  select pg_get_indexdef(i.indexrelid), i.indisunique
    into v_def, v_unique
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indexrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'products_org_barcode_idx';

  if v_def is null then
    raise exception 'barcode_lookup_index_missing: products_org_barcode_idx was not created';
  end if;
  if v_unique then
    raise exception 'barcode_lookup_index_unique: uniqueness contradicts the ambiguity rule (model.ts:358-363)';
  end if;
  if position('org_id' in v_def) = 0 or position('barcode' in v_def) = 0 then
    raise exception 'barcode_lookup_index_shape: expected (org_id, barcode), got %', v_def;
  end if;
  if position('barcode IS NOT NULL' in v_def) = 0 then
    raise exception 'barcode_lookup_index_not_partial: expected a partial index, got %', v_def;
  end if;
end
$$;
