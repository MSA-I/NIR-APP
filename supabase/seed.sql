-- SupplyFlow — neutral baseline seed.
--
-- A real tenant receives one organization and generic starter categories only. Demo business
-- data lives under supabase/demo and is loaded explicitly. The tenant is addressed by an
-- operator-chosen UUID; organization names are intentionally not treated as unique identity.
--
-- Manual use:
--   1. Replace org_id, org_name and vat_rate in both parameter blocks below.
--   2. Run scripts/db-query.ps1 with an explicit non-production ProjectRef.
--   3. Provision the first owner through the platform admin flow.

do $$
declare
  v_org_id constant uuid := '00000000-0000-4000-8000-000000000001';
  v_org_name constant text := 'העסק שלי';
  v_vat_rate constant numeric(5,2) := 18.00;
begin
  if exists (
    select 1 from organizations o
    where o.id = v_org_id
      and (o.name is distinct from v_org_name or o.vat_rate is distinct from v_vat_rate)
  ) then
    raise exception 'seed org_id already belongs to a different organization; choose a new UUID';
  end if;
end
$$;

with params as (
  select
    '00000000-0000-4000-8000-000000000001'::uuid as org_id,
    'העסק שלי'::text as org_name,
    18.00::numeric(5,2) as vat_rate
), new_org as (
  insert into organizations (id, name, vat_rate)
  select p.org_id, p.org_name, p.vat_rate from params p
  on conflict (id) do nothing
  returning id
), target_org as (
  select o.id, o.name
  from organizations o join params p on p.org_id = o.id
), starter_categories as (
  insert into categories (org_id, name, sort)
  select t.id, c.name, c.sort
  from target_org t
  cross join (values
    ('חומרי גלם', 1),
    ('ציוד', 2),
    ('חומרי ניקיון', 3),
    ('אריזה וחד־פעמי', 4),
    ('ציוד משרדי', 5),
    ('תחזוקה ותיקונים', 6),
    ('שירותים', 7)
  ) as c(name, sort)
  on conflict (org_id, name) do nothing
  returning org_id
)
select t.id as org_id,
       t.name as org_name,
       case when exists (select 1 from new_org) then 'created' else 'already existed' end as result,
       (select count(*) from starter_categories) as categories_created
from target_org t;
