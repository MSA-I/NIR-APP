-- SupplyFlow — neutral baseline seed.
--
-- What a REAL new tenant gets: an organization row and a generic starter category set.
-- Nothing else. No suppliers, no products, no invoices, no fictional business data —
-- a new customer opening the app should see their own empty system, not someone else's.
--
-- The demo data that used to live in this file (15 suppliers, 46 products and the seeded
-- financial edge cases for the former single-tenant demo) moved to supabase/demo/demo_seed.sql. It is a
-- separate tenant, loaded on demand, and never part of a customer install.
--
-- ===== When you actually need this file =====
-- The normal path for a new customer is the admin provisioning flow (Edge Function
-- `admin-provision`), which creates the organization and its first user, followed by the
-- in-app onboarding wizard, which imports the tenant's real suppliers and products.
-- This file is the manual fallback: bootstrapping a tenant straight from SQL, e.g. during
-- the pilot or when reproducing an install locally.
--
-- ===== Usage =====
--   1. Edit the two values in the `params` block below (business name, VAT rate).
--   2. .\scripts\db-query.ps1 -SqlFile supabase\seed.sql
--   3. Create the first user with scripts\create-users.ps1 (or the admin screen) and give
--      it a profiles row with the org_id this file returns.
--
-- Re-running is safe: an organization with the same name is not created twice, and the
-- starter categories are guarded by their unique (org_id, name) constraint. Because it is
-- keyed on the business name, two genuinely different customers must not share one.

with params as (
  select
    'העסק שלי'::text          as org_name,   -- <- the customer's business name
    18.00::numeric(5,2)       as vat_rate    -- <- 18% is the Israeli rate for 2026 (docs/OPEN-DECISIONS.md row 1)
),
new_org as (
  insert into organizations (name, vat_rate)
  select p.org_name, p.vat_rate
  from params p
  where not exists (select 1 from organizations o where o.name = p.org_name)
  returning id, name
),
-- The org this run targets, whether it was just created or already existed. A CTE cannot
-- see rows inserted by a sibling CTE, so the new row has to be carried across explicitly.
target_org as (
  select id, name from new_org
  union all
  select o.id, o.name from organizations o join params p on o.name = p.org_name
),
-- Generic, industry-neutral starting point. These are meant to be renamed and extended
-- by the tenant — the onboarding wizard offers the same set, and because of the
-- `on conflict` below the two can never fight over it.
starter_categories as (
  insert into categories (org_id, name, sort)
  select t.id, c.name, c.sort
  from target_org t
  cross join (values
    ('חומרי גלם',        1),
    ('ציוד',             2),
    ('חומרי ניקיון',     3),
    ('אריזה וחד-פעמי',   4),
    ('ציוד משרדי',       5),
    ('תחזוקה ותיקונים',  6),
    ('שירותים',          7)
  ) as c(name, sort)
  on conflict (org_id, name) do nothing
  returning org_id
)
-- Exactly one row comes back either way: the org id to hand to the first user's profile.
select n.id as org_id, n.name as org_name, 'created' as result
from new_org n
union all
select o.id, o.name, 'already existed'
from organizations o
join params p on o.name = p.org_name;
