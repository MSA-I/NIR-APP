-- notification_event_states is internal Push-delivery state. Browser roles reach it only
-- through the service-only SECURITY DEFINER notification commands.

revoke all on table public.notification_event_states from public, anon, authenticated;
grant select, insert, update, delete on table public.notification_event_states to service_role;
