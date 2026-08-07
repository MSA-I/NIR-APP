-- 0082 -- NULLIF is SQL syntax, not a pg_catalog function. Qualifying it made every cron tick fail.
create or replace function private.dispatch_document_interpretations()
returns bigint[]
language plpgsql
security definer
set search_path = pg_catalog, private, vault, net
as $$
declare
  v_edge_url text;
  v_cron_secret text;
  v_limit integer;
  v_job record;
  v_request_ids bigint[] := array[]::bigint[];
begin
  perform pg_catalog.set_config(
    'app.correlation_id', pg_catalog.gen_random_uuid()::text, true
  );

  select pg_catalog.btrim(c.edge_url), nullif(s.decrypted_secret, ''),
         c.max_starts_per_org_hour
    into v_edge_url, v_cron_secret, v_limit
  from private.document_interpretation_automation_config c
  join vault.decrypted_secrets s on s.id = c.cron_secret_id
  where c.id;
  if not found or v_cron_secret is null then return v_request_ids; end if;

  for v_job in
    select claimed.job_id
    from private.claim_document_interpretation_jobs(10, v_limit) claimed
  loop
    v_request_ids := pg_catalog.array_append(
      v_request_ids,
      net.http_post(
        url := v_edge_url,
        body := pg_catalog.jsonb_build_object('jobId', v_job.job_id),
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'x-interpret-cron-secret', v_cron_secret
        )
      )
    );
  end loop;
  return v_request_ids;
end
$$;
revoke all on function private.dispatch_document_interpretations()
  from public, anon, authenticated, service_role;
