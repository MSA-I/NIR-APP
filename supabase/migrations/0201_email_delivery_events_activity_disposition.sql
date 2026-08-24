-- 0201: classify email_delivery_events as activity evidence.
--
-- 0196 sweeps every public table carrying org_id and demands a disposition for each, because an
-- unreviewed table must block an organization's deletion rather than be missed by it. 0190 added
-- email_delivery_events after that registry was written, so p75's C1 assertion refused -- correctly.
--
-- EVIDENCE, and the parent settles it. A row here exists only because a supplier order was emailed
-- and the provider reported back on that specific message. Its parent, email_order_messages, is
-- already registered as evidence for the same reason, and a delivery callback is a stronger signal
-- than the send it describes: the send could in principle be a draft the system produced, the
-- callback means a real provider handled a real message for this tenant.
--
-- The registry lives in private and is written only by migrations, so this is an insert with no
-- command, no grant and no new surface. on conflict do nothing keeps the migration replayable
-- without letting it silently overwrite a disposition someone later reconsidered.

insert into private.org_activity_evidence_registry (table_name, disposition, rationale)
values (
  'email_delivery_events',
  'evidence',
  'A provider delivery callback for a supplier order this tenant actually sent; its parent '
  || 'email_order_messages is evidence for the same reason.'
)
on conflict (table_name) do nothing;

-- The sweep must now be quiet for this table specifically. Asserting the whole sweep is empty would
-- couple this migration to every other branch in flight; asserting this one row is what 0201 owns.
do $assert_email_delivery_events_classified$
begin
  if exists (
    select 1 from private.org_activity_registry_violations() violation
    where violation.table_name = 'email_delivery_events'
  ) then
    raise exception '0201: email_delivery_events is still unclassified after its own migration';
  end if;
end
$assert_email_delivery_events_classified$;

-- Mandatory after 0057. This migration adds no SECURITY DEFINER surface and moves no scope, and the
-- assertion runs anyway rather than being skipped on the author's say-so.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0201 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
