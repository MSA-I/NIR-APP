-- 0245 — a business abroad works the way a business here works, without configuring anything.
--
-- `#294` (owner, 30.08.2026) replaces the half of `#288` that required the owner to state a value
-- before a non-shekel currency could be used at all. The reason it can be replaced is a fact nobody
-- had noticed when `#288` was decided:
--
--   **THE SHEKEL NUMBERS WERE NEVER SHEKEL NUMBERS.** `1` is not "one shekel" chosen against
--   anything — it is ONE HUNDRED MINOR UNITS of the currency, and `0.05` is FIVE. The shekel has
--   two decimals, so a hundred agorot is 1.00 and five agorot is 0.05. Those two constants are an
--   instance of a rule, and the rule reads perfectly well in any currency.
--
-- `#288` was right about the only alternative on the table at the time, which was to apply the
-- shekel FIGURE to dollars: "within 1" in dollars is roughly 3.7 times wider than "within 1" in
-- shekels, and that is a silent change to how carefully money is checked. Deriving from the
-- currency's own units is the opposite of that. There is no rate here, nothing is converted, and
-- no amount is computed from another currency (`#287`, `#290`). A dollar tolerance of $1.00 is not
-- "a shekel in dollars" — it is a hundred cents.
--
-- WHAT EACH CURRENCY GETS, and it is identical to what the shekel already had:
--
--   bank match / payment request / invoice total   100 minor units   ILS 1.00 · JPY 100 · KWD 0.100
--   invoice line                                     5 minor units   ILS 0.05 · JPY   5 · KWD 0.005
--
-- `minor_units` comes from the `currencies` table `0217` seeded with all 157 ISO codes, so JPY
-- (zero decimals) and KWD (three) are already right and no list has to be maintained here.
--
-- WHAT THIS DOES NOT DO. It does not touch a value an organisation has actually stated: a
-- configured amount still wins, for the currency it names, in both the old scalar shape and the
-- per-currency map. And it does not remove the null path — an inactive or unknown currency still
-- answers null, so `0232`'s refusal and `0244`'s finding remain reachable and remain correct.

create or replace function private.money_tolerance(p_org_id uuid, p_currency text, p_key text)
returns numeric
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    case
      -- What the organisation actually said, for the currency it said it about.
      when jsonb_typeof(organization.settings -> p_key) = 'object'
        then (organization.settings -> p_key ->> p_currency)::numeric
      -- The old shape: one number, which every organisation that has one wrote when the product
      -- was shekels only. It answers for ILS and for nothing else.
      when jsonb_typeof(organization.settings -> p_key) = 'number' and p_currency = 'ILS'
        then (organization.settings ->> p_key)::numeric
    end,
    -- Otherwise the currency's own threshold (#294). A line is small change; the rest are one
    -- ordinary unit. Both are counted in the currency's minor units, never converted from another.
    (select case p_key when 'invoice_line_amount_tolerance' then 5 else 100 end
              * power(10::numeric, -currency.minor_units)
     from public.currencies currency
     where currency.code = p_currency and currency.active))
  from public.organizations organization
  where organization.id = p_org_id
$$;

comment on function private.money_tolerance(uuid, text, text) is
  'The tolerance for one currency: what the organisation stated, or else the currency''s own '
  'threshold — 100 minor units, or 5 for an invoice line (0245, OPEN-DECISIONS #294). Derived '
  'from currencies.minor_units and NEVER from another currency: there is no rate here. NULL '
  'survives for a currency this database does not recognise or has deactivated, and null still '
  'means "cannot compare" rather than some number.';

-- ===== Proof =====
do $assert_0245$
declare
  v_org         uuid;
  v_violations  text;
begin
  -- The shekel does not move. This is the assertion that matters most: an existing Israeli
  -- business must not be able to tell that this migration ran.
  create temp table v0245_org on commit drop as
  select id from public.organizations order by created_at, id limit 1;
  select id into v_org from v0245_org;

  if v_org is not null then
    if private.money_tolerance(v_org, 'ILS', 'invoice_line_amount_tolerance') <> 0.05 then
      raise exception '0245: the shekel line tolerance moved from 0.05';
    end if;
    if private.money_tolerance(v_org, 'ILS', 'invoice_document_amount_tolerance') <> 1 then
      raise exception '0245: the shekel document tolerance moved from 1';
    end if;
    if private.money_tolerance(v_org, 'ILS', 'payment_request_amount_tolerance') <> 1 then
      raise exception '0245: the shekel request tolerance moved from 1';
    end if;

    -- The currency that used to stop the bank screen now answers, and answers in dollars.
    if private.money_tolerance(v_org, 'USD', 'bank_match_amount_tolerance') <> 1 then
      raise exception '0245: USD did not derive 1.00 for the bank tolerance';
    end if;
    if private.money_tolerance(v_org, 'USD', 'invoice_line_amount_tolerance') <> 0.05 then
      raise exception '0245: USD did not derive 0.05 for the line tolerance';
    end if;

    -- Zero-decimal and three-decimal currencies are the whole reason this reads `minor_units`
    -- rather than assuming two.
    if private.money_tolerance(v_org, 'JPY', 'invoice_document_amount_tolerance') <> 100 then
      raise exception '0245: JPY did not derive 100 for the document tolerance';
    end if;
    if private.money_tolerance(v_org, 'JPY', 'invoice_line_amount_tolerance') <> 5 then
      raise exception '0245: JPY did not derive 5 for the line tolerance';
    end if;
    if private.money_tolerance(v_org, 'KWD', 'invoice_document_amount_tolerance') <> 0.100 then
      raise exception '0245: KWD did not derive 0.100 for the document tolerance';
    end if;

    -- A currency this database does not recognise still answers null, so the refusal in 0232 and
    -- the finding in 0244 stay reachable. "Cannot compare" has not been replaced by a number.
    if private.money_tolerance(v_org, 'ZZZ', 'bank_match_amount_tolerance') is not null then
      raise exception '0245: an unrecognised currency was handed a derived tolerance';
    end if;
  end if;

  -- An organisation that does not exist answers nothing, exactly as 0219 asserted.
  if private.money_tolerance('00000000-0000-0000-0000-000000000000'::uuid, 'USD', 'nope') is not null then
    raise exception '0245: money_tolerance answered for an organisation that does not exist';
  end if;

  if (select prosecdef from pg_proc
      where oid = 'private.money_tolerance(uuid,text,text)'::regprocedure) then
    raise exception '0245: money_tolerance became SECURITY DEFINER';
  end if;
  if has_function_privilege('authenticated', 'private.money_tolerance(uuid,text,text)', 'execute') then
    raise exception '0245: money_tolerance is reachable by a client role';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0245 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0245 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0245$;
