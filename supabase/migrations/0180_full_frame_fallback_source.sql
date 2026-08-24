-- 0180 -- #247: `automatic` means detected corners; full-frame fallback gets its own value.
--
-- Historical rows are not guessed. Older workers wrote `automatic` for both a detected polygon and
-- the fallback, and their metrics did not persist a source discriminator. New worker evidence uses
-- `full_frame_fallback` plus exact full-frame corners and a numeric metric marker.

alter table public.document_scan_outputs
  drop constraint document_scan_outputs_corners_source_check;
alter table public.document_scan_outputs
  add constraint document_scan_outputs_corners_source_check check (
    corners_source in ('automatic', 'manual', 'full_frame_fallback')
  ),
  add constraint document_scan_outputs_full_frame_source_shape check (
    corners_source <> 'full_frame_fallback'
    or corners = '[[0,0],[1,0],[1,1],[0,1]]'::jsonb
  );

-- Patch only the live validation literal. The function's egress lease, source checksum, Storage
-- proof, immutable output insert and evidence settlement remain byte-for-byte current.
do $patch_scan_source$
declare
  v_signature regprocedure := 'public.service_complete_document_scan_job(
    uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb
  )'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text := $anchor$p_corners_source not in ('automatic', 'manual')$anchor$;
  v_replacement text := $replacement$p_corners_source not in (
       'automatic', 'manual', 'full_frame_fallback'
     )
     or (p_corners_source = 'full_frame_fallback'
         and p_corners is distinct from '[[0,0],[1,0],[1,1],[0,1]]'::jsonb)$replacement$;
begin
  if position(v_anchor in v_definition) = 0
     or position('full_frame_fallback' in v_definition) > 0 then
    raise exception '0180: scan completion source anchor moved or patch already applied';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_scan_source$;

comment on column public.document_scan_outputs.corners_source is
  'automatic = a page polygon was detected; manual = a person supplied corners; '
  'full_frame_fallback = no trustworthy page polygon existed but bounded edge evidence proved the '
  'document filled the frame. Rows written before 0180 remain unchanged when provenance is absent.';

-- A deterministic historical update would require BOTH exact full-frame corners and the worker's
-- `metrics.full_frame_fallback = 1` source marker. Pre-0180 workers never wrote that marker, so the
-- honest backfill set is empty. This assertion blocks a silent missed deterministic row without
-- reclassifying ambiguous `automatic` history.
do $$
begin
  if exists (
    select 1 from public.document_scan_outputs output
    where output.corners_source = 'automatic'
      and output.corners = '[[0,0],[1,0],[1,1],[0,1]]'::jsonb
      and coalesce(output.metrics ->> 'full_frame_fallback', '0')::numeric = 1
  ) then
    raise exception '0180: deterministic full-frame history exists and requires an explicit immutable-ledger backfill';
  end if;
end $$;

do $$
declare
  v_definition text := pg_get_functiondef(
    'public.service_complete_document_scan_job(
      uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb
    )'::regprocedure);
  v_violations text;
begin
  if position('full_frame_fallback' in v_definition) = 0 then
    raise exception '0180: service completion still rejects full-frame fallback evidence';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0180 scope assertions failed:\n%', v_violations; end if;
end $$;
