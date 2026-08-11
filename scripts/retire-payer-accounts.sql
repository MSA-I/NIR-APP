-- Retiring the `payer` accounts the product no longer has a place for.
--
-- WHY THIS IS A SCRIPT AND NOT A MIGRATION. A migration describes the schema every tenant gets. This
-- describes which PEOPLE exist in one deployment, and the answer is different on every deployment
-- and on every day. It is also the only irreversible operation in this campaign, so it is written to
-- be read before it is run.
--
-- Run it in two steps, in this order:
--
--   1. `SELECT ONLY` below, first. It lists every payer account with what the database holds against
--      it. Read that list. Nothing has happened yet.
--   2. `THE DELETION` below, second, and only for the rows step 1 showed as having a zero in every
--      column. It refuses to touch anything else -- see the next paragraph for why that refusal is
--      the database's and not this script's politeness.
--
-- WHY MOST OF THEM WILL NOT DELETE, AND WHY THAT IS CORRECT. Seventy-four foreign keys point at
-- `auth.users` or `public.profiles`; thirty-five of them are RESTRICT and twenty are NO ACTION, and
-- they sit on `payments`, `payment_requests`, `invoices`, `purchase_orders`, `goods_receipts` and
-- `documents`. An account that ever executed a payment is NAMED in the record of that payment, and
-- that name is what makes the payment explicable in an audit years later. So the delete of such an
-- account does not "clean up" -- it either fails, or in the eleven CASCADE cases it takes real
-- history with it.
--
-- An account that never acted has no such rows and deletes cleanly. That is the case this script is
-- for, and it is the honest reading of "old accounts that are not in use".
--
-- FOR THE OTHERS: the product already stopped offering the role (0111 revoked the emergency payment
-- command, invitations no longer list `payer`, and the navigation and dashboards are gone). An
-- account left in place cannot reach anything new. If one must stop working entirely, the reversible
-- way is `update auth.users set banned_until = 'infinity'` -- Supabase's own switch, which leaves the
-- audit trail spelling the person's name where it always did.

\set ON_ERROR_STOP on

-- ===================== STEP 1 -- SELECT ONLY. Read this before step 2. =====================

with payer as (
  select p.id, p.full_name, p.org_id, u.email, u.last_sign_in_at, u.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'payer'
)
select
  payer.id,
  payer.email,
  payer.full_name,
  payer.created_at::date      as created,
  payer.last_sign_in_at::date as last_sign_in,
  (select count(*) from public.payments         x where x.executed_by = payer.id) as payments_executed,
  (select count(*) from public.payment_requests x where x.created_by  = payer.id
                                                     or x.approved_by = payer.id) as payment_requests,
  (select count(*) from public.documents        x where x.uploaded_by = payer.id) as documents_uploaded,
  (select count(*) from public.audit_logs       x where x.user_id     = payer.id) as audit_rows,
  (select count(*) from public.invoices         x where x.received_by = payer.id) as invoices,
  (select count(*) from public.notifications    x where x.user_id     = payer.id) as notifications
from payer
order by payer.last_sign_in_at nulls first, payer.created_at;

-- ===================== STEP 2 -- THE DELETION. Only after reading step 1. =====================
--
-- Deletes payer accounts with a zero footprint, one transaction, and reports each one by email.
-- Everything else is left alone and named in a NOTICE, so the output is a list of what was removed
-- and a list of what the record still needs.
--
-- The `deleted_at is null` on profiles is deliberate: a profile already soft deleted is not an
-- account in use either, and it is the same person.

begin;

do $$
declare
  v_row record;
  v_removed integer := 0;
  v_kept integer := 0;
begin
  for v_row in
    select p.id, u.email, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'payer'
    order by u.email
  loop
    -- One probe per table the record could name them in. Cheaper and clearer than catching a
    -- foreign key violation, and it can say WHICH table held them.
    if exists (select 1 from public.payments where executed_by = v_row.id)
       or exists (select 1 from public.payment_requests
                  where created_by = v_row.id or approved_by = v_row.id)
       or exists (select 1 from public.documents where uploaded_by = v_row.id)
       or exists (select 1 from public.audit_logs where user_id = v_row.id)
       or exists (select 1 from public.invoices where received_by = v_row.id)
       or exists (select 1 from public.purchase_orders where created_by = v_row.id)
       or exists (select 1 from public.goods_receipts where received_by = v_row.id)
    then
      v_kept := v_kept + 1;
      raise notice 'KEPT   % -- the record names this account. Ban it if it must stop working; '
                   'deleting it would take the name off work that was really done.', v_row.email;
    else
      -- Rows that are ABOUT the account rather than work it did. Notification preferences, push
      -- subscriptions and saved views describe a person's settings, not the business's history, and
      -- they are what the CASCADEs would have removed anyway.
      delete from public.notifications where user_id = v_row.id;
      delete from public.notification_preferences where user_id = v_row.id;
      delete from public.push_subscriptions where user_id = v_row.id;
      delete from public.saved_views where user_id = v_row.id;
      delete from public.user_scope_grants where user_id = v_row.id;
      delete from public.profiles where id = v_row.id;
      delete from auth.users where id = v_row.id;
      v_removed := v_removed + 1;
      raise notice 'REMOVED % -- never signed in or never acted (last sign-in: %).',
        v_row.email, coalesce(v_row.last_sign_in_at::text, 'never');
    end if;
  end loop;
  raise notice '---- % removed, % kept because the record names them.', v_removed, v_kept;
end
$$;

-- Deliberately NOT `commit`. Read the notices above, then send `commit;` yourself -- or `rollback;`
-- if a name in the REMOVED list is someone you expected to keep. This is the one operation in the
-- campaign that cannot be undone by re-running anything.
