-- 0294 — every tenant counts its own documents from 1. Wave 4b, owner decision B, RC5.
--
-- WHAT WAS WRONG. Six tables number their rows with `integer generated always as identity`
-- (`0001_init.sql:129-177, 230-274`), and no later migration converts them. An identity sequence
-- is global: the first purchase order of the second customer is numbered 31 because the first
-- customer made thirty. That is two defects wearing one hat.
--
--   * It publishes a CROSS-TENANT ACTIVITY SIGNAL. Watch your own numbers over a month and you
--     have measured everybody else's volume. This local database is the proof: `payments` holds
--     six rows and the highest number is 22, because a sequence counts attempts, not survivors.
--   * It reads as a lie to the customer. A business that joined yesterday sees its first invoice
--     numbered in the thousands and reasonably asks what the other 999 were.
--
-- SEPARATE FROM WAVE 4 ON PURPOSE. A locked six-table transition and a column CHECK share
-- nothing, and bundling them means one rollback takes out both.
--
-- WHAT "STARTS AT 1" MEANS, precisely. Historical numbers are PRESERVED and never reused, so the
-- existing tenant keeps its sequence exactly where it is; the counter is seeded from that tenant's
-- own maximum. "Starts at 1" is a promise to a NEW tenant, and the verify block below proves it on
-- all six tables.
--
-- WHY A COUNTER PER (org_id, entity_kind) AND NOT ONE PER ORG. There are six independent sequences
-- today. One shared organisation counter would let only the first entity kind start at 1 — the
-- first payment of a new tenant would be numbered after its purchase orders.
--
-- WHY THE ALLOCATOR UPSERTS RATHER THAN ASSUMING A SEEDED ROW. An organisation created after this
-- migration has no counter row at all. A plain `update ... returning` would return zero rows and
-- leave `number` null, which the NOT NULL would then refuse — a new customer's first document
-- failing on a technicality. `insert ... on conflict do update` has no such hole, and it is also
-- the lock: the upsert takes a row lock, so two concurrent inserts for one tenant serialise on it
-- and cannot be handed the same number.
--
-- WHY THE ALLOCATOR IS **SECURITY INVOKER**, which is the load-bearing decision in this file.
-- `private` carries no grants to anybody but its owner — the schema's ACL is empty — and this
-- table must stay that way: a readable counter republishes exactly the cross-tenant signal the
-- migration exists to remove. A SECURITY DEFINER trigger would reach `private` from any caller,
-- but four of these six tables are scope-ENFORCED, and A5 catches every definer function that is
-- a trigger on an enforced table, so it would need an exemption row — widening the definer
-- surface to allocate an integer. SECURITY INVOKER needs neither, because every writer is already
-- privileged: `authenticated` holds no INSERT on any of the six, no Edge function inserts into
-- them (`send-push` only reads `payment_requests`), and every product write arrives inside a
-- SECURITY DEFINER command owned by `postgres`. If a future path ever inserts as `service_role`,
-- it fails loudly with "permission denied for schema private" rather than silently skipping the
-- allocation — which is the correct direction for a number that must exist.
--
-- ONE TRANSACTION, explicitly. The lock, the seed, the identity drop and the trigger install are
-- one unit: between dropping the identity and installing the trigger there is a window in which an
-- insert would land with no number, and `0170` is the precedent for a migration that manages its
-- own transaction rather than hoping the runner supplies one.

begin;

-- The lock comes first and is held to commit. EXCLUSIVE blocks every writer while still allowing
-- reads, so a dashboard stays up and no insert can cross the conversion.
lock table
  public.credit_requests,
  public.goods_receipts,
  public.payment_requests,
  public.payments,
  public.purchase_orders,
  public.purchase_requests
in exclusive mode;

create table if not exists private.org_number_counters (
  org_id      uuid    not null references public.organizations(id) on delete restrict,
  entity_kind text    not null,
  next_value  integer not null,
  primary key (org_id, entity_kind),
  constraint org_number_counters_entity_kind_check check (entity_kind in (
    'credit_requests', 'goods_receipts', 'payment_requests',
    'payments', 'purchase_orders', 'purchase_requests')),
  constraint org_number_counters_next_value_check check (next_value >= 0)
);

comment on table private.org_number_counters is
  'One document counter per (organization, entity kind), 0294. It lives in `private` and is '
  'granted to nobody: a readable counter would republish the cross-tenant activity signal that '
  'moving off the global identity sequences exists to remove. `next_value` is the number most '
  'recently handed out, so the allocator adds one and an absent row means "this tenant has not '
  'been numbered yet" — which is why the allocator upserts.';

revoke all on private.org_number_counters from public;

create or replace function private.allocate_org_number()
returns trigger
language plpgsql
as $function$
declare
  v_next integer;
begin
  -- An explicit number is REFUSED, not honoured. The identity these tables used to carry was
  -- `generated always`, which refused one at the storage layer; dropping it without this would
  -- quietly turn a guarantee into a convention, and the first caller to pass a number would
  -- collide with a real one.
  if new.number is not null then
    raise exception 'org_number_is_allocated_not_supplied' using errcode = '22023';
  end if;
  if new.org_id is null then
    raise exception 'org_number_requires_org' using errcode = '22023';
  end if;

  -- The upsert is both the allocation and the lock: concurrent inserts for one tenant serialise
  -- on this row, and a tenant that has never been numbered gets its row and the number 1 in the
  -- same statement.
  insert into private.org_number_counters as counter (org_id, entity_kind, next_value)
  values (new.org_id, tg_table_name, 1)
  on conflict (org_id, entity_kind)
  do update set next_value = counter.next_value + 1
  returning counter.next_value into v_next;

  new.number := v_next;
  return new;
end
$function$;

comment on function private.allocate_org_number() is
  'BEFORE INSERT allocator for the six numbered tables, 0294. SECURITY INVOKER on purpose: every '
  'writer already runs as the owner of a SECURITY DEFINER command, so no grant into `private` is '
  'needed and no A5 definer exemption is spent on allocating an integer. Refuses an explicit '
  'NEW.number, because the identity it replaces refused one too.';

-- Seed from each tenant's OWN maximum, so no historical number is reused and no tenant inherits
-- another's count. `0` for a tenant with no rows yet means its first document is 1.
do $seed_0294$
declare
  v_kind text;
  v_seeded integer;
begin
  foreach v_kind in array array[
    'credit_requests', 'goods_receipts', 'payment_requests',
    'payments', 'purchase_orders', 'purchase_requests'
  ] loop
    execute format(
      'insert into private.org_number_counters (org_id, entity_kind, next_value)
       select t.org_id, %L, max(t.number)
       from public.%I t
       where t.org_id is not null
       group by t.org_id
       on conflict (org_id, entity_kind) do nothing', v_kind, v_kind);
    get diagnostics v_seeded = row_count;
    raise notice '0294: seeded % counter(s) for %', v_seeded, v_kind;

    -- Drop the identity and its sequence, then install the allocator. Both happen under the
    -- EXCLUSIVE lock taken above, so there is no instant at which an insert could land unnumbered.
    execute format('alter table public.%I alter column number drop identity', v_kind);
    execute format('drop trigger if exists aa_allocate_org_number on public.%I', v_kind);
    execute format(
      'create trigger aa_allocate_org_number before insert on public.%I
       for each row execute function private.allocate_org_number()', v_kind);

    -- `unique (org_id, number)` is what makes "never reused" checkable rather than asserted. It
    -- holds trivially over the existing data, because the global identity made every number
    -- unique across all tenants.
    execute format(
      'alter table public.%I add constraint %I unique (org_id, number)',
      v_kind, v_kind || '_org_id_number_key');
  end loop;
end
$seed_0294$;

do $assert_0294$
declare
  v_kind text;
  v_violations text;
begin
  foreach v_kind in array array[
    'credit_requests', 'goods_receipts', 'payment_requests',
    'payments', 'purchase_orders', 'purchase_requests'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = v_kind
        and column_name = 'number' and is_identity = 'YES'
    ) then
      raise exception '0294: % still carries the global identity', v_kind;
    end if;
    -- `drop identity` takes the owned sequence with it. If one survived, a later caller could
    -- still reach it and hand out a number nobody counted.
    if pg_get_serial_sequence('public.' || quote_ident(v_kind), 'number') is not null then
      raise exception '0294: the global sequence for % was not dropped', v_kind;
    end if;
    if not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = v_kind and t.tgname = 'aa_allocate_org_number' and not t.tgisinternal
    ) then
      raise exception '0294: % has no allocator, so its next insert has no number', v_kind;
    end if;
    if not exists (
      select 1 from pg_constraint
      where conrelid = ('public.' || quote_ident(v_kind))::regclass
        and conname = v_kind || '_org_id_number_key' and contype = 'u'
    ) then
      raise exception '0294: % cannot prove a number is unique within its tenant', v_kind;
    end if;
    -- Every tenant that already has rows must have a counter, and it must sit at that tenant's
    -- own maximum. A counter behind the data would re-issue a number that is already in use.
    execute format(
      'select string_agg(t.org_id::text, '','')
       from (select org_id, max(number) as top from public.%I where org_id is not null
             group by org_id) t
       left join private.org_number_counters c
         on c.org_id = t.org_id and c.entity_kind = %L
       where c.next_value is distinct from t.top', v_kind, v_kind)
      into v_violations;
    if v_violations is not null then
      raise exception '0294: % counters disagree with the data for org(s) %', v_kind, v_violations;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'org_number_counters'
      and grantee in ('authenticated', 'anon')
  ) then
    raise exception '0294: the counter table is readable by a client role — that is the signal this migration removes';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0294 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0294$;

commit;
