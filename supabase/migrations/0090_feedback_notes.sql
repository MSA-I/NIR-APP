-- Feedback notes — the design-partner customer writes a note inside the product and it reaches
-- the vendor within seconds, or the screen says it did not.
--
-- Why a table and not a webhook call from the browser: the Discord webhook URL is a bearer
-- capability (whoever holds it can post to the channel), so it lives only in the Edge Function.
-- And a note that a person took the trouble to write must survive a failed send — the ROW is the
-- record, the Discord message is a notification about it. That ordering is what lets the UI say
-- "נשמר, לא נשלח" instead of a comfortable lie (PRODUCT.md:62, "אמת מעל נוחות").
--
-- Append-only for the browser, and enforced at PRIVILEGE level, not only by a missing policy:
-- `authenticated` receives INSERT on the author's columns and nothing else. It cannot write
-- `sent_at` or `send_error`, so "delivered" is a fact the server recorded, never a claim the
-- client made. Same column-grant discipline as 0061/0088 on suppliers.bank_details.
--
-- Who sees the button is a FLAG, not a permission (SECURITY-MODEL §8 and the flag law in 0059):
-- `feedback.notes` gates the UI surface only. It is deliberately absent from the policies below —
-- p4_flags_identity.sql asserts structurally that no policy reads the flag resolver, and a flag
-- that granted access would be exactly the fragility that law exists to prevent. The consequence
-- is stated rather than hidden: a member of a non-flagged organization who calls the REST API
-- directly can still insert a note about their own organization. That writes a row in a table
-- holding no secrets and grants nothing; it is not a permission boundary and is not treated as one.
--
-- No audit trigger and no soft delete: a note is a message to the vendor, not a financial record.
-- Nothing here is derived from money, and nothing downstream reads it.

create table feedback_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  user_id uuid not null references profiles(id) on delete cascade,
  note text not null,
  -- The context that turns "זה לא עובד" into something fixable without asking the customer
  -- where they were. Captured by the client at submit time.
  route text not null,
  role user_role not null,
  viewport_width int,
  -- Named for what it actually holds: VITE_RELEASE, the same build identifier the app already
  -- reports to Sentry (src/lib/observability.ts:15). No new build-time plumbing was added.
  app_release text,
  created_at timestamptz not null default now(),
  -- Written by send-feedback alone (see the column grant below).
  sent_at timestamptz,
  send_error text,
  -- 1500, not Discord's 2000: the composed message also carries the context header, and the
  -- limit belongs where the text is stored, not only where it is formatted.
  constraint feedback_notes_note_length check (char_length(btrim(note)) between 1 and 1500),
  constraint feedback_notes_route_length check (char_length(route) between 1 and 200),
  constraint feedback_notes_viewport_sane check (viewport_width is null or viewport_width between 200 and 10000)
);

comment on table feedback_notes is
  'Design-partner feedback. The row is the record; send-feedback posts it to Discord and stamps '
  'sent_at or send_error. The browser cannot write either column.';

-- The two reads that exist: the vendor''s newest-first list and a tenant seeing its own notes.
create index feedback_notes_org_created_idx on feedback_notes (org_id, created_at desc);

-- ===== RLS =====
-- Tenancy only, flag-free (see the flag note in the header). Insert is additionally pinned to the
-- author: a member may report what they saw, not file a note as somebody else.
-- No update and no delete policy, on purpose — append-only, matching the privileges below.
alter table feedback_notes enable row level security;

create policy feedback_notes_select on feedback_notes for select to authenticated
  using (org_id = auth_org());

-- The vendor reads every tenant's notes — that is the whole point of the channel. Mirrors
-- org_platform_select (0006:127) rather than introducing a SECURITY DEFINER: a definer would buy
-- the same read and cost a row in the exemption registry (DEBT-REGISTER §7).
create policy feedback_notes_platform_select on feedback_notes for select to authenticated
  using (is_platform_admin());

create policy feedback_notes_insert on feedback_notes for insert to authenticated
  with check (org_id = auth_org() and user_id = auth.uid());

-- ===== Privileges =====
-- Shape: browser reads its own tenant and appends; the trusted server holds full CRUD (asserted
-- for every public table by p0_client_dml_acl.sql, which allows exactly one exception and this is
-- not it). `anon` gets nothing — an unauthenticated caller has no organization to write about.
revoke all on table feedback_notes from public, anon, authenticated;
grant select on table feedback_notes to authenticated;
grant insert (org_id, user_id, note, route, role, viewport_width, app_release)
  on table feedback_notes to authenticated;

-- ===== The flag that shows the button =====
-- Born off for every organization, like every flag in 0059. Turning it on for the design partner
-- is platform_set_org_flag (platform admin + reason + audit) — no schema change, no deploy.
insert into private.flag_definitions (flag_key, description, risk_level, default_state, kill_switch)
values ('feedback.notes', 'In-product feedback note surface for design-partner organizations', 'low', false, false);

-- ===== Registry + re-assertion (the 0058:207-218 idiom) =====
-- org_global: one org_id column, no unit focus, nothing scope-enforced. `enforced = false` — a
-- feedback note carries no unit meaning, so A5 has nothing to require of it.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('feedback_notes', 'org_global', false);

-- Re-assert the 0057 scope-enforcement invariants (DEBT-REGISTER §9).
do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0090 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
