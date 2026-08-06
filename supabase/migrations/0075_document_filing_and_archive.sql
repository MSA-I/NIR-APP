-- 0075 — The archive becomes a real filing target, and a filing decision becomes a record.
--
-- Until now the archive existed only on screen: `/documents/archive` (0d237b9) reads
-- entity_type='archive' and nothing anywhere could write it. This migration makes the target
-- real, and records WHO decided a document's category, WHY, and at what confidence.
--
-- THREE gates refused an archived row, not one. A2's review found the first; the other two
-- were found by reading the live catalogue, because the repo text is stale for both:
--
--   1. documents_inbox_entity (0014:19-20) -- `entity_id is not null or entity_type='inbox'`.
--      An archive row is null on entity_id AND is not 'inbox', so it violates both arms.
--   2. documents_guard_columns -- whose LIVE body is 0045's, not 0019's. Its `refiling`
--      predicate admits only inbox -> invoice|goods_receipt, so BOTH inbox -> archive and
--      archive -> inbox are rejected by the trigger before any policy is consulted.
--   3. file_document's own target validation.
--
-- WHAT IS DELIBERATELY NOT TOUCHED, and why, so a later reader does not "fix" it:
--
--   * documents_insert is NOT widened to admit 'archive'. It is an INSERT policy;
--     file_document performs an UPDATE, so it is not on this write path at all. Adding
--     'archive' there would create a browser route for uploading straight into the archive --
--     the very path DocumentsInbox.tsx:492-495 states must not exist ("There is no human path
--     into the archive"). The planning note that pointed here cited 0022:662, whose four-value
--     list has been superseded twice (0031, then 0045, which added 'supplier').
--   * docs_storage_read is NOT widened either, and this was checked rather than assumed: it
--     does reference documents.entity_type, but only inside its ACCOUNTANT arm. The
--     owner/office/kitchen arm -- the STAFF roles that can reach /documents/archive
--     (App.tsx:102,248) -- never looks at entity_type, so an archived document's bytes stay
--     downloadable and צפייה במקור keeps working. p11 asserts this rather than trusting it.
--   * Hard delete is NOT invented. Deleting from the archive without a reason is decision #28's
--     existing soft delete (0010: deleted_at/deleted_by, the stored file kept for audit).
--
-- OPEN-DECISIONS #110 records the owner's ruling this implements: a human MAY rescue a
-- document from the archive WITH a reason, and MAY delete from it WITHOUT one.
--
-- Every function this migration changes is read from pg_get_functiondef and patched by
-- anchored substitution. Re-declaring from an older migration's text is how a wave nearly
-- shipped a silent revert (DEBT-REGISTER); here it would have been immediate and real:
-- file_document reads `security invoker` in 0019 but 0022:388 altered it to SECURITY DEFINER,
-- so copying 0019's text forward would have downgraded a live security boundary. Each
-- substitution asserts its anchor first and fails the migration if the live body has moved.

-- ===== 1. The check constraint: narrowed to the new case, not dropped =====
-- Dropping it outright would let entity_type='invoice' carry a null entity, which is exactly
-- the invariant 0014:15-16 exists to hold ("an entity becomes optional -- but ONLY for inbox
-- rows"). The archive is a second row shape with no business entity, so it joins that arm and
-- nothing else moves.

alter table public.documents drop constraint documents_inbox_entity;
alter table public.documents add constraint documents_inbox_entity
  check (entity_id is not null or entity_type in ('inbox', 'archive'));

-- ===== 2. The column guard: two more legitimate transitions =====
-- 0014:22-26 called re-filing "the second legitimate update" after soft delete. These are the
-- third and fourth: a document moving into the archive because nothing fit, and a document a
-- person pulled back out. Everything identity-bearing stays frozen -- org_id, storage_path,
-- file_name, mime_type, uploaded_by, created_at -- so neither can repoint a stored file or move
-- a row between organizations. The GUC fence below the predicate still applies to all four,
-- which is what keeps these transitions reachable ONLY through the reasoned RPCs.

do $$
declare
  v_def text := replace(
    pg_get_functiondef('public.documents_guard_columns()'::regprocedure), e'\r', '');
  v_anchor text := replace($anchor$    refiling := old.entity_type = 'inbox'
                and new.entity_type in ('invoice', 'goods_receipt')
                and new.entity_id is not null;$anchor$, e'\r', '');
  v_replacement text := replace($new$    -- inbox -> invoice/goods_receipt (0014), inbox -> archive and archive -> inbox (0075).
    -- The archive legs are exact about the entity: an archived row carries none, and a rescued
    -- row carries none either -- it returns to the inbox, where the two שיוך actions work.
    refiling := (old.entity_type = 'inbox'
                 and ((new.entity_type in ('invoice', 'goods_receipt')
                       and new.entity_id is not null)
                      or (new.entity_type = 'archive' and new.entity_id is null)))
                or (old.entity_type = 'archive'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$new$, e'\r', '');
begin
  if position(v_anchor in v_def) = 0 then
    raise exception '0075: documents_guard_columns has moved -- the refiling predicate is not where 0045 left it. Re-read the live definition before editing.';
  end if;
  execute replace(v_def, v_anchor, v_replacement);
end
$$;

-- The trigger keeps firing the replaced function; recreated defensively with identical wiring
-- so this migration stands on its own (the 0014:48-53 idiom).
drop trigger if exists documents_guard_columns_trg on public.documents;
create trigger documents_guard_columns_trg
  before insert or update on public.documents
  for each row execute function public.documents_guard_columns();

-- ===== 3. file_document learns the archive =====
-- Two anchored substitutions into the LIVE body. Nothing else about the function changes --
-- not its security, not its search_path, not its grants.

do $$
declare
  v_def text := replace(
    pg_get_functiondef('public.file_document(uuid,text,uuid,text)'::regprocedure), e'\r', '');
  -- The target shape. `(archive) <> (entity is null)` is total: the archive must carry no
  -- entity, and every business target must carry one. Both halves are asserted in p11.
  v_target_anchor text := replace($a$  if p_entity_type is null
     or p_entity_type not in ('invoice', 'goods_receipt')
     or p_entity_id is null then
    raise exception 'document_target_invalid' using errcode = '22023';
  end if;$a$, e'\r', '');
  v_target_new text := replace($a$  if p_entity_type is null
     or p_entity_type not in ('invoice', 'goods_receipt', 'archive')
     or (p_entity_type = 'archive') <> (p_entity_id is null) then
    raise exception 'document_target_invalid' using errcode = '22023';
  end if;$a$, e'\r', '');
  -- Target metadata. The shared `if not found` moves inside the two branches that actually
  -- run a query: the archive branch runs none, and leaving it to inherit `found` from the
  -- preceding row lock would have been correct by accident and unreadable on purpose.
  v_derive_anchor text := replace($b$  if p_entity_type = 'invoice' then
    select i.supplier_id, i.invoice_date
      into v_supplier_id, v_document_date
    from invoices i
    where i.id = p_entity_id and i.org_id = v_org and i.deleted_at is null;
  else
    select po.supplier_id, gr.received_at::date
      into v_supplier_id, v_document_date
    from goods_receipts gr
    join purchase_orders po on po.id = gr.order_id and po.org_id = gr.org_id
    where gr.id = p_entity_id and gr.org_id = v_org;
  end if;

  if not found then
    raise exception 'document_target_unknown' using errcode = 'P0002';
  end if;$b$, e'\r', '');
  v_derive_new text := replace($b$  if p_entity_type = 'archive' then
    -- The archive has no entity to derive from, so the document keeps what is already known
    -- about it. "No business record fits this" is not "nothing is known about this", and
    -- blanking supplier/date here would destroy the uploader's own work on the way in.
    v_supplier_id := v_document.supplier_id;
    v_document_date := v_document.document_date;
  elsif p_entity_type = 'invoice' then
    select i.supplier_id, i.invoice_date
      into v_supplier_id, v_document_date
    from invoices i
    where i.id = p_entity_id and i.org_id = v_org and i.deleted_at is null;

    if not found then
      raise exception 'document_target_unknown' using errcode = 'P0002';
    end if;
  else
    select po.supplier_id, gr.received_at::date
      into v_supplier_id, v_document_date
    from goods_receipts gr
    join purchase_orders po on po.id = gr.order_id and po.org_id = gr.org_id
    where gr.id = p_entity_id and gr.org_id = v_org;

    if not found then
      raise exception 'document_target_unknown' using errcode = 'P0002';
    end if;
  end if;$b$, e'\r', '');
begin
  if position(v_target_anchor in v_def) = 0 then
    raise exception '0075: file_document target validation has moved -- re-read the live definition before editing.';
  end if;
  if position(v_derive_anchor in v_def) = 0 then
    raise exception '0075: file_document target derivation has moved -- re-read the live definition before editing.';
  end if;
  v_def := replace(v_def, v_target_anchor, v_target_new);
  v_def := replace(v_def, v_derive_anchor, v_derive_new);
  execute v_def;
  -- pg_get_functiondef renders the live SECURITY DEFINER that 0022:388 installed, so the
  -- replay above preserves it. Assert it anyway: this is the exact property a re-declaration
  -- from 0019's `security invoker` text would have destroyed without a word.
  if not (select prosecdef from pg_proc
          where oid = 'public.file_document(uuid,text,uuid,text)'::regprocedure) then
    raise exception '0075: file_document lost SECURITY DEFINER -- 0022:388 has been reverted.';
  end if;
end
$$;

-- ===== 4. document_filings: the decision, as an event =====
-- Why a table and not a column on documents: the 0019/0045 guard freezes most of that table's
-- columns, and a filing decision is an EVENT (who, when, from which interpretation, at what
-- confidence), not an attribute of the file.
--
-- Every foreign key is tenant-composite against the (org_id, id) keys the parents already
-- carry, so a filing cannot point at another tenant's document, supplier or interpretation --
-- structurally, before any policy runs. This is the document_extractions /
-- document_processing_jobs convention, not a new one.

create table public.document_filings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null,
  -- A value from the interpretation contract's document_type (0046:45-47), spelled out rather
  -- than merely documented. Five CHECK constraints in the live catalogue already carry this
  -- exact list (smart_document_interpretation_valid, document_learning_rules,
  -- document_type_review_decisions x2, document_export_templates), so a sixth is the
  -- convention, not new duplication -- and category is the field the whole autonomy decision
  -- of C2 turns on. A free-text column would take 'delivery-note' for 'delivery_note' and no
  -- one would find out until an automatic filing went to the wrong place.
  category text not null check (
    category in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    )
  ),
  supplier_id uuid,
  interpretation_id uuid,
  -- null means UNKNOWN. It is never 0 when there is no datum -- zero confidence is a claim
  -- about the model's certainty, and the constitution forbids stating one we do not have.
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  decided_by text not null check (decided_by in ('system', 'user')),
  decided_at timestamptz not null default now(),
  -- Reversal is soft and reasoned: the decision stays readable after it is undone, because
  -- "the system filed this, then a person disagreed" is the history worth having.
  reverted_at timestamptz,
  reverted_reason text,
  constraint document_filings_org_id_id_key unique (org_id, id),
  constraint document_filings_document_tenant_fk
    foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_filings_org_fk
    foreign key (org_id) references public.organizations(id) on delete restrict,
  constraint document_filings_supplier_tenant_fk
    foreign key (org_id, supplier_id)
    references public.suppliers(org_id, id) on delete restrict,
  constraint document_filings_interpretation_tenant_fk
    foreign key (org_id, interpretation_id)
    references public.document_interpretations(org_id, id) on delete restrict,
  -- A reversal is a reason plus a time, or neither. A reverted_at with no reason is the silent
  -- write this whole task exists to prevent, so it cannot be represented at all.
  constraint document_filings_reversal_shape check (
    (reverted_at is null and reverted_reason is null)
    or (reverted_at is not null and length(btrim(coalesce(reverted_reason, ''))) between 1 and 1000)
  )
);

-- One live decision per document. Superseded decisions stay as rows; only the active one is
-- unique, which is what makes archive -> rescue -> archive a legal sequence rather than a
-- conflict.
create unique index document_filings_active_one
  on public.document_filings (org_id, document_id) where reverted_at is null;

create index document_filings_document_idx
  on public.document_filings (org_id, document_id, decided_at desc);

comment on table public.document_filings is
  'Append-only record of who decided a document''s category, from which interpretation and at what confidence. Reversal is soft and always reasoned.';
comment on column public.document_filings.confidence is
  'Model confidence in 0..1, or NULL when unknown. Never 0 as a stand-in for missing data.';

alter table public.document_filings enable row level security;
alter table public.document_filings force row level security;

-- Same readership as document_interpretations (0046:557-559): the people who work the document
-- register. No scope rider -- documents is cross-scope and its children inherit tenant and
-- scope through the composite key (ADR-0004 section 4), which is why this table has no unit_id.
create policy document_filings_select on public.document_filings
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );

revoke all on table public.document_filings from public, anon, authenticated, service_role;
grant select on table public.document_filings to authenticated;
grant select, insert, update, delete on table public.document_filings to service_role;

-- ===== 5. Rescue: the complement of filing, and the reason is structural =====
--
-- Its own command and its own name, deliberately not a flag on the two שיוך actions. Threading
-- a reason through RefileModal would have been wrong twice: it re-points the archive at
-- file_document, whose guard structurally refuses any non-inbox row, and it makes "was a reason
-- required?" depend on a prop rather than on which action the person chose.
--
-- SECURITY DEFINER, matching file_document. The alternative -- invoker -- would require
-- granting UPDATE on document_filings to authenticated, and a plain PostgREST PATCH could then
-- set reverted_at with no reason at all, defeating the requirement this function exists to
-- enforce. The A5 exemption below states that reason so the multi-unit wave can retire it on
-- evidence rather than guesswork.
--
-- The document returns to the INBOX. It is the only coherent destination: the two existing
-- filing actions work from there, and isUnfiled() then tells the truth about the row. A rescued
-- document is one the system could not place and a person has returned to the queue.

create function public.rescue_document_from_archive(
  p_document_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(btrim(p_reason), '');
  v_document documents;
  v_filing_id uuid;
begin
  -- Same authority as filing and removal: owner/office. 0014:55-58 settled that re-filing is
  -- the same clerical responsibility as removal, and pulling a document back out is re-filing.
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_document
  from documents
  where id = p_document_id and org_id = v_org and deleted_at is null
  for update;

  -- The function owner bypasses table RLS, so this predicate is the IDOR boundary: an in-tenant
  -- sibling id and a cross-tenant id are indistinguishable to the caller, and neither is read.
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  if v_document.entity_type <> 'archive' then
    raise exception 'document_not_in_archive' using errcode = 'P0001';
  end if;

  perform set_config('app.document_filing_writer', v_user::text, true);

  update documents
  set entity_type = 'inbox',
      entity_id = null
  where id = v_document.id;

  -- There may be no active filing: 0075 lets file_document archive a document directly, and
  -- the filing ledger only starts being written by apply_document_interpretation. A rescue
  -- with nothing to revert is still a legitimate rescue, so this is not an error.
  update document_filings
  set reverted_at = now(),
      reverted_reason = v_reason
  where org_id = v_org
    and document_id = v_document.id
    and reverted_at is null
  returning id into v_filing_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'document_rescued_from_archive',
    'documents',
    v_document.id,
    jsonb_build_object(
      'entity_type', v_document.entity_type,
      'entity_id', v_document.entity_id,
      'filing_id', v_filing_id
    ),
    jsonb_build_object(
      'entity_type', 'inbox',
      'entity_id', null,
      'filing_reverted', v_filing_id is not null
    ),
    v_reason
  );

  return jsonb_build_object(
    'document_id', v_document.id,
    'entity_type', 'inbox',
    'filing_id', v_filing_id,
    'filing_reverted', v_filing_id is not null
  );
end
$$;

revoke all on function public.rescue_document_from_archive(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rescue_document_from_archive(uuid, text) to authenticated;

comment on function public.rescue_document_from_archive(uuid, text) is
  'Returns an archived document to the inbox with a mandatory reason, reverting its active filing and writing one audit row.';

-- ===== 6. Registration =====
-- A1 fails the migration on an unclassified public table. `derived`/unenforced matches all
-- twelve document_* siblings: this table inherits tenant and scope through its composite key
-- to documents, and a derived table must never receive its own scope column (ADR-0004 s.4).

insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_filings', 'derived', false);

-- A5: rescue is a SECURITY DEFINER function whose body names an enforced table (documents).
-- The reason field states WHY it cannot simply be made invoker, so the multi-unit enablement
-- wave that drains this registry can judge it on the argument rather than re-derive it.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.rescue_document_from_archive(uuid,text)'::regprocedure::text,
  'rls-preread-single-unit -- cannot be invoker: that would require granting UPDATE on '
    || 'document_filings to authenticated, letting a direct PostgREST PATCH set reverted_at '
    || 'with no reason and defeating the mandatory-reason contract this command enforces. '
    || 'Remediate by filtering documents on auth_scopes() once documents carries a meaningful '
    || 'unit_id; today an archived document is unit_id NULL by design (0055:112).',
  'multi-unit enablement wave'
);

-- ===== 7. The re-assert block (DEBT-REGISTER section 9) =====
-- Every migration above 0057 carries this. 0067 forgot; this one does not.

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0075 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$$;
