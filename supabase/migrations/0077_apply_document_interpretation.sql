-- 0077 -- The decision layer: what a model may write without a human (wave 11, task C2).
--
-- ==========================================================================================
-- THIS IS THE FUNCTION THAT LETS A LANGUAGE MODEL AUTHOR A FINANCIAL RECORD.
--
-- The owner was asked one gate question -- what the system may do without human approval when
-- it identifies a supplier charge -- and chose the most permissive of three options: above a
-- confidence threshold the system may create the record, link it to the order, and act on a
-- missing item. The risk was stated before the choice and reaffirmed after. This file builds
-- that scope. 0076 built the SWITCH and the NUMBER; nothing here turns anything on anywhere,
-- and with the switch in its shipped state (off, for every tenant that exists) this migration
-- changes no observable behaviour at all.
--
-- THE ONE DOCUMENTED EXCEPTION, NOT OVERRIDDEN: purchase_order_items is never written. CLAUDE.md
-- makes unit_price a price snapshot at order time and price_history derives from it, so adding a
-- line retroactively is not an update -- it is a rewrite of history the manager has already been
-- shown, and it re-derives savings analyses after the fact. The unordered item goes onto the
-- exception instead (a new record -- a write, not a rewrite), which surfaces at /exceptions as
-- "a decision is needed" rather than as an order that changed in silence.
-- ==========================================================================================
--
-- ==========================================================================================
-- FIVE THINGS THAT LOOK LIKE STYLE AND ARE NOT. Read before "simplifying" any of them.
--
--   1. SECURITY DEFINER OWNED BY postgres, GRANTED TO service_role ONLY. Not defensiveness --
--      a measured requirement. private.autonomy_policy_for_org is granted to postgres alone and
--      service_role has NO USAGE on schema `private` (verified false in C1's review). An invoker
--      function granted to service_role would fail at the SCHEMA, not at the grant, and the
--      failure would surface as "autonomy is off" rather than as a bug.
--
--   2. IT READS private.autonomy_policy_for_org, NEVER evaluate_autonomy_policy. The public
--      evaluator resolves through auth_org(), which is NULL for the trusted server -- so it
--      ALWAYS answers "off" to the only caller this command has. That is a silent failure that
--      reads exactly like a correctly-disabled feature. A C2 that read the public door would
--      pass review and never fire in production. p14 asserts the source text of this function
--      for both names, because the difference is invisible at runtime until it matters.
--
--   3. THE NUMBER COMPARED IS min(document_type_confidence, supplier.confidence), AND THE
--      MINIMUM IS NULL-PROPAGATING. SQL's least() IGNORES NULLS: least(0.99, null) is 0.99.
--      Written the obvious way, a confident guess about the document TYPE would have carried an
--      unknown SUPPLIER over the bar -- and the supplier is the half that decides whose money
--      moves. C1's review named this requirement and nothing enforced it; this file is where it
--      becomes real, and p14 asserts the null case specifically.
--
--   4. FILINGS ARE INSERTED PLAINLY. No ON CONFLICT. B1's review found the live footgun: an
--      `INSERT ... ON CONFLICT ... DO UPDATE` against document_filings_active_one, intending a
--      fresh filing, took the conflict branch and REVERTED the document's existing active filing
--      -- leaving it with a reverted filing and no active one. Every guard held (a legal,
--      reasoned, one-time reversal), so nothing detected it. The collision is therefore handled
--      BEFORE any write, by refusing to act on a document someone already decided; the plain
--      insert that follows is a backstop that fails loudly under a concurrent second caller
--      rather than quietly destroying a person's decision.
--
--   5. NO ROW IS EVER ATTRIBUTED TO A HUMAN. Every audit row this file writes carries
--      user_id = NULL. The temptation is real -- file_document and every sibling command need
--      auth.uid(), and stamping the uploader's id would make them all callable. It would also
--      make the machine indistinguishable from the person in the only record that could ever
--      tell them apart. audit_row_change permits a null actor precisely for trusted-server
--      writes, and that is the door this file uses.
-- ==========================================================================================
--
-- ==========================================================================================
-- WHY file_document IS NOT CALLED, THOUGH THE ARCHIVE OUTCOME IS ITS JOB.
--
-- Measured against the LIVE definition, not the migration text: file_document opens with
-- `v_org uuid := auth_org()` and immediately raises not_authorized when it is null or when
-- auth_role() is not owner/office. This command runs as the trusted server with no user JWT, so
-- auth_org() is NULL and EVERY call would raise. The archive branch below therefore performs the
-- same UPDATE itself -- it is a definer owned by postgres, documents_guard_columns already
-- admits inbox -> archive since 0075, and that guard's GUC fence is gated on
-- `auth.uid() is not null` so it never evaluates for this caller.
--
-- The alternative -- stamping request.jwt.claims with the uploader's id so file_document would
-- accept the call -- was rejected. It would write a human's user_id, a human-shaped action name
-- and a human-shaped reason for a decision no human made. That is the precise lie the reason
-- contract in this file exists to prevent.
-- ==========================================================================================

-- ===== 0. Ancestry anchors: three live contracts this file consumes =====
-- None of these are re-declared here. Each is read from the live catalogue and asserted, because
-- the repo text is stale for at least one of them (file_document reads `security invoker` in
-- 0019 while 0022:388 altered it to definer) and because a silent move in any of the three turns
-- this command into a machine that writes financial records under the wrong rules.
do $anchor$
declare
  v_body text;
begin
  -- (a) The trusted-server door. If a later migration ever collapsed the two doors into one
  -- tenant-scoped reader, this command would silently stop firing -- the worst possible failure
  -- mode, because "no invoices were created" is indistinguishable from "autonomy is off".
  if to_regprocedure('private.autonomy_policy_for_org(uuid,text)') is null then
    raise exception '0077 ancestry: private.autonomy_policy_for_org(uuid,text) is missing -- '
      'the trusted-server door this command reads does not exist (0076 section 4).';
  end if;
  select prosrc into v_body from pg_proc
  where oid = 'private.autonomy_policy_for_org(uuid,text)'::regprocedure;
  if v_body !~ 'min_confidence is not null' then
    raise exception '0077 ancestry: autonomy_policy_for_org lost its null-threshold guard. '
      'An unconfigured tenant would answer enabled-with-no-threshold (0076:356-367).';
  end if;

  -- (b) The filing ledger and its partial unique index -- the object whose conflict semantics
  -- this file is written around.
  if to_regclass('public.document_filings') is null then
    raise exception '0077 ancestry: public.document_filings is missing (0075 section 4).';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'document_filings'
      and indexname = 'document_filings_active_one') then
    raise exception '0077 ancestry: document_filings_active_one is missing -- the one-live-'
      'decision-per-document rule this command refuses to collide with is gone.';
  end if;

  -- (c) The audit escape for a trusted-server write. audit_row_change rejects a write whose
  -- org_id does not match auth_org() UNLESS the actor is null or a platform operator. Every
  -- audited write below has a null actor and relies on that first arm.
  select prosrc into v_body from pg_proc
  where oid = 'public.audit_row_change()'::regprocedure;
  if v_body !~ 'v_actor is not null' then
    raise exception '0077 ancestry: audit_row_change no longer exempts a null actor. Every '
      'trusted-server write in this file would die as audit_source_org_mismatch.';
  end if;
end
$anchor$;

-- ===== 1. Reading the model's numbers, in SQL, without guessing =====
--
-- These mirror src/components/document-review/model.ts:225-229 deliberately and the duplication
-- is stated rather than hidden: the browser prefills a FORM a person then checks, and this
-- prefills a RECORD nobody checks. They must agree, and there is no shared source between
-- Deno/TypeScript and PL/pgSQL to make them agree structurally. If one list grows, grow both.
--
-- Every one of these returns NULL rather than a fallback. A field the model did not offer, or
-- offered in a shape that will not parse, is UNKNOWN -- and unknown is a hard stop upstream, not
-- a zero. The constitution's rule about dashes instead of zeros is a rule about dashboards; here
-- it is a rule about whether an invoice gets written at all.

-- ==========================================================================================
-- THE INVISIBLE CHARACTERS. This is an RTL product, so this is a first-class hazard.
--
-- WHAT WENT WRONG BEFORE THIS EXISTED, stated plainly because the comment below it claims
-- "paying twice is the worst damage this system can do" and that sentence was NOT true of the
-- code beneath it. The duplicate stop compared `lower(btrim(...))` on both sides. btrim with one
-- argument strips SPACES ONLY. Against a tenant enabled at 0.900 with a live invoice `pz-dup-1`
-- already on file, four transcriptions of the same human-readable number were measured:
--
--     "  PZ-DUP-1 "            -> queued_for_review / duplicate_invoice_number   (caught)
--     "PZ-DUP-1" + U+200F RLM  -> auto_applied                                   (NOT caught)
--     "PZ-DUP-1" + TAB         -> auto_applied                                   (NOT caught)
--     U+00A0 + "PZ-DUP-1"      -> auto_applied                                   (NOT caught)
--
-- Four live invoices under one number for one supplier, written with no human in the loop, and
-- invoices_org_live_duplicate_key_idx is a PLAIN index -- there is no database backstop. Worse,
-- the stored number kept the invisible character, so the duplicate was also unfindable by
-- search. The file already knew this class of bug existed: interpretation_number below strips
-- bidi marks from the AMOUNT. It did not strip them from the key that decides whether the
-- business pays twice.
--
-- TWO functions, not one, because storing and comparing want different things:
--
--   SANITIZE is what gets STORED. It preserves case and legible content -- `PZ-DUP-1` stays
--   `PZ-DUP-1` -- and only removes what cannot be seen. Lower-casing the stored number would
--   destroy what the document actually says.
--
--   KEY is what gets COMPARED. Lower-cased with all whitespace removed, so `PZ DUP 1`,
--   `pz-dup-1` and an RLM-suffixed twin all collide. Collisions here are the SAFE direction:
--   a false match queues the document for a person, a missed match writes a second invoice.
--
-- Code points are named via chr(), NEVER embedded literally. A literal RLM in this file is
-- invisible in every editor, and the first person to tidy the line would delete it unknowingly.
-- Both groups below were MEASURED on this database rather than assumed:
--
--   Unicode SPACES -- NBSP(160), NNBSP(8239), MMSP(8287), ideographic(12288). Postgres `\s`
--   DOES match all four here, so they are mapped to a plain space rather than deleted: that is
--   what keeps a stored number findable by an ordinary search.
--
--   FORMATTING marks -- ZWSP/ZWNJ/ZWJ/LRM/RLM(8203-8207), bidi embeddings and overrides
--   (8234-8238), isolates(8294-8297), BOM(65279). Postgres `\s` matches NONE of these:
--   `regexp_replace(chr(8207), '\s', '', 'g')` returns the RLM unchanged. They are deleted
--   outright -- they carry no width and no meaning inside an identifier.
--
-- WHERE THE LINE IS DRAWN, AND THAT IT WAS DRAWN ON PURPOSE. What is removed is exactly the
-- characters with NO VISUAL FORM -- things a person cannot see, cannot type deliberately, and
-- cannot tell apart on a printed page. What is NOT removed is anything a person CAN see:
-- full-width `１` stays distinct from `1`, Cyrillic `А` stays distinct from Latin `A`, and a
-- combining acute accent stays part of the number it sits on. Those are visibly different
-- strings, so treating them as the same number would start REFUSING genuinely different
-- invoices -- a false duplicate blocks a real supplier payment, which is a different and equally
-- real harm. (U+034F COMBINING GRAPHEME JOINER is in the delete list and a combining ACCENT is
-- not, and that is the same rule applied consistently: the joiner has no visual form, the accent
-- does.) A future reader finding homoglyphs unnormalised should know this was decided, not
-- missed.
--
-- PLACED IN `private` SO create_invoice CAN REACH IT -- AND THE ASYMMETRY IS REAL TODAY. The
-- human path still compares with a bare `trim` (0023:1800-1804), so a person pasting an invoice
-- number that carries an RLM can still create the exact pair this command now refuses to create.
-- The machine is, on this one point, stricter than the human. That is P1's contract and its own
-- suite, not this task's to change, but the helper is deliberately placed where that fix can
-- call it without moving anything.
-- ==========================================================================================
create or replace function private.document_text_sanitize(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(
    btrim(regexp_replace(
      translate(
        translate(p_text,
          chr(160) || chr(8239) || chr(8287) || chr(12288),
          '    '),
        -- Bidi controls -- ALL TWELVE. The first version of this list carried eleven and a
        -- review found the gap by exhibiting it: U+061C ARABIC LETTER MARK produced a second
        -- live invoice under an existing number. This is a CLOSED, ENUMERABLE set, so eleven of
        -- twelve is not a judgement call, it is an omission -- and in a product that handles
        -- Arabic-language supplier paperwork it is the same hazard as the RLM that started this.
        chr(1564)                                                       -- U+061C  ALM
          || chr(8206) || chr(8207)                                     -- U+200E-200F LRM, RLM
          || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)  -- U+202A-202E
          || chr(8294) || chr(8295) || chr(8296) || chr(8297)           -- U+2066-2069 isolates
        -- Zero-width joiners and the invisible operators. U+2060 WORD JOINER is the
        -- Unicode-designated REPLACEMENT for U+FEFF-as-zero-width-no-break-space: the BOM was
        -- already deleted here and its successor was not. U+2061-2064 are its immediate
        -- neighbours and every one of them was measured surviving, so the whole 2060-2064 range
        -- goes rather than the single character the review happened to exhibit.
          || chr(8203) || chr(8204) || chr(8205)                        -- U+200B-200D ZWSP/NJ/J
          || chr(8288) || chr(8289) || chr(8290) || chr(8291) || chr(8292)  -- U+2060-2064
          || chr(65279)                                                 -- U+FEFF  BOM
        -- Formatting marks with no visual form that arrive from real documents rather than from
        -- an attacker. U+00AD SOFT HYPHEN is what a PDF text layer carries for hyphenation, and
        -- this pipeline feeds that text layer to a model that reproduces what it sees.
          || chr(173)                                                   -- U+00AD SOFT HYPHEN
          || chr(847)                                                   -- U+034F CGJ
          || chr(6158),                                                 -- U+180E MONGOLIAN VS
        ''),
      '\s+', ' ', 'g')),
    '')
$fn$;

create or replace function private.document_text_key(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(
    lower(regexp_replace(
      coalesce(private.document_text_sanitize(p_text), ''), '\s', '', 'g')),
    '')
$fn$;

revoke all on function private.document_text_sanitize(text)
  from public, anon, authenticated, service_role;
revoke all on function private.document_text_key(text)
  from public, anon, authenticated, service_role;

create or replace function private.interpretation_field(p_payload jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select f.value -> 'value'
  from jsonb_array_elements(p_payload -> 'fields')
    with ordinality as f(value, ord)
  where lower(btrim(f.value ->> 'key')) = any (p_keys)
  order by array_position(p_keys, lower(btrim(f.value ->> 'key'))), f.ord
  limit 1
$fn$;

-- "1,392.00", "₪ 31.90" and the bare number 31.9 all become numbers; anything else becomes NULL.
-- The character class strips currency, thousands separators and the bidi marks that survive RTL
-- transcription -- the same cleanup model.ts:180 performs, for the same reason.
create or replace function private.interpretation_number(p_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) = 'number' then
    return (p_value #>> '{}')::numeric;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  v_text := regexp_replace(p_value #>> '{}', '[\s,₪‎‏‪-‮]', '', 'g');
  if v_text !~ '^-?\d+(\.\d+)?$' then
    return null;
  end if;
  return v_text::numeric;
end
$fn$;

-- dd/mm/yyyy (and dd.mm.yyyy / dd-mm-yyyy) or an already-ISO date. Day-first is the Israeli
-- convention these documents are printed in (model.ts:239-249). Anything else is NULL: a date
-- that is merely PROBABLY right is worse than none, because it lands on a financial record and
-- an empty required field is visible while a plausible wrong date is not.
create or replace function private.interpretation_date(p_value jsonb)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v_text text;
  v_parts text[];
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  v_text := btrim(p_value #>> '{}');
  if v_text ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      return v_text::date;
    exception when others then
      return null;
    end;
  end if;
  v_parts := regexp_match(v_text, '^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$');
  if v_parts is null then
    return null;
  end if;
  begin
    return make_date(v_parts[3]::int, v_parts[2]::int, v_parts[1]::int);
  exception when others then
    return null;
  end;
end
$fn$;

revoke all on function private.interpretation_field(jsonb, text[])
  from public, anon, authenticated, service_role;
revoke all on function private.interpretation_number(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.interpretation_date(jsonb)
  from public, anon, authenticated, service_role;

-- ===== 2. document_auto_actions -- the idempotency key and the reversal key, one row =====
--
-- WHY ONE TABLE AND NOT TWO COLUMNS SOMEWHERE. An automatic write needs two things that a
-- business record cannot carry: proof that this exact interpretation has already been acted on
-- (so a retried Edge Function does not buy the supplier twice), and a handle to undo everything
-- the decision did in ONE reasoned action (C5). Both are properties of the DECISION, not of the
-- invoice, and the invoice already refuses to carry them -- CLAUDE.md forbids a payment_id on an
-- invoice for the same reason: a financial record states what is true of itself, not how it came
-- to exist.
--
-- WRITTEN ONLY ON auto_applied. A queued document has nothing to undo (the filing is the whole
-- record) and an archived one already has rescue_document_from_archive. A row here means "a
-- machine wrote money", and it should mean nothing else -- so /exceptions and any future review
-- screen can read this table and see exactly the set of writes that had no human behind them.
create table public.document_auto_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  -- Only one value is storable today. The CHECK is not future-proofing -- it is the same fence
  -- document_filings.category carries: a free-text column would take 'auto-applied' for
  -- 'auto_applied' and nobody would find out until a reversal screen came up empty.
  outcome text not null check (outcome in ('auto_applied')),
  invoice_id uuid,
  exception_id uuid,
  filing_id uuid,
  order_id uuid,
  -- The decision, as the machine saw it: model, prompt version, both confidences, the minimum
  -- that was actually compared, and the threshold it was compared against. This is what makes a
  -- reversal reviewable a year later without re-running anything.
  decision jsonb not null check (jsonb_typeof(decision) = 'object'),
  created_at timestamptz not null default now(),
  -- Reversal is soft and reasoned, the document_filings shape exactly (0075, decision #110).
  reverted_at timestamptz,
  reverted_reason text,
  reverted_by uuid,
  constraint document_auto_actions_org_id_id_key unique (org_id, id),
  constraint document_auto_actions_org_fk
    foreign key (org_id) references public.organizations(id) on delete restrict,
  constraint document_auto_actions_document_tenant_fk
    foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_auto_actions_interpretation_tenant_fk
    foreign key (org_id, interpretation_id)
    references public.document_interpretations(org_id, id) on delete restrict,
  constraint document_auto_actions_invoice_tenant_fk
    foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint document_auto_actions_filing_tenant_fk
    foreign key (org_id, filing_id)
    references public.document_filings(org_id, id) on delete restrict,
  -- order_id was the one pointer with no key behind it, which also made the "every FK leads with
  -- org_id" assertion in p14 pass vacuously for it. purchase_orders carries
  -- p0_purchase_orders_org_id_id_key, so there was never a reason for the gap.
  constraint document_auto_actions_order_tenant_fk
    foreign key (org_id, order_id)
    references public.purchase_orders(org_id, id) on delete restrict,
  -- A reversal is a reason plus a time, or neither -- and the actor comes with them. A
  -- reverted_at with no reason is the silent write this wave exists to prevent, so it cannot be
  -- represented at all (the document_filings_reversal_shape idiom).
  constraint document_auto_actions_reversal_shape check (
    (reverted_at is null and reverted_reason is null and reverted_by is null)
    or (reverted_at is not null and reverted_by is not null
        and length(btrim(coalesce(reverted_reason, ''))) between 1 and 1000)
  ),
  -- An auto-applied row without the invoice it applied is a reversal handle that undoes nothing.
  constraint document_auto_actions_applied_shape check (
    outcome <> 'auto_applied' or invoice_id is not null
  ),
  -- B1 finding 3, which 0075 left open on document_filings and this table repeated verbatim:
  -- there is no temporal bound on the reversal, and the guard trigger is BEFORE UPDATE OR
  -- DELETE, not INSERT. Measured accepted before this constraint existed:
  -- `created_at = now() + 400 days` with `reverted_at = now() - 900 days` -- a row reverted
  -- nine hundred days before it was created. A row can also be born already reverted, which is
  -- worse than untidy: it does not consume the partial unique slot it exists to hold, so the
  -- idempotency key silently stops keying.
  constraint document_auto_actions_reversal_order check (
    reverted_at is null or reverted_at >= created_at
  )
);

-- IDEMPOTENCY IS AN INDEX, NOT A CODE PATH. A key enforced only inside the function body is
-- defeated by any concurrent second call, and "one retry must not buy the supplier twice" is a
-- claim about concurrency. Two keys, because there are two ways to ask twice:
--
--   * the SAME interpretation replayed -- the Edge Function retried, or C4's fire-and-forget
--     call ran again after a timeout;
--   * a DIFFERENT interpretation of the same document -- a person re-ran interpretation on a
--     document that already produced an invoice. A key on interpretation_id alone misses this
--     entirely, and it is the more likely of the two.
create unique index document_auto_actions_one_per_interpretation
  on public.document_auto_actions (org_id, interpretation_id);
create unique index document_auto_actions_one_live_per_document
  on public.document_auto_actions (org_id, document_id) where reverted_at is null;
create index document_auto_actions_document_idx
  on public.document_auto_actions (org_id, document_id, created_at desc);

comment on table public.document_auto_actions is
  'One row per financial record a machine wrote without a human: the idempotency key that stops a retry buying the same goods twice, and the handle that undoes the whole decision in one reasoned action. Written only for auto_applied outcomes.';
comment on column public.document_auto_actions.decision is
  'The decision as the machine saw it -- model, prompt version, both confidences, the minimum actually compared and the threshold it was compared against -- so a reversal is reviewable without re-running anything.';

alter table public.document_auto_actions enable row level security;
alter table public.document_auto_actions force row level security;

-- Same readership as document_filings (0075): the people who work the document register. No
-- scope rider -- documents is cross-scope and its children inherit tenant and scope through the
-- composite key (ADR-0004 section 4), which is why this table has no unit_id.
create policy document_auto_actions_select on public.document_auto_actions
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );

revoke all on table public.document_auto_actions
  from public, anon, authenticated, service_role;
grant select on table public.document_auto_actions to authenticated;
-- Full CRUD to service_role is the project's ACL contract, not a statement of intent:
-- p0_client_dml_acl.sql fails if any public server table is missing DELETE for it. The table's
-- integrity therefore lives in the guard below, exactly as document_filings' does (0075:291-297).
grant select, insert, update, delete on table public.document_auto_actions to service_role;

-- The integrity claim, enforced rather than asserted in a comment. This row is the evidence that
-- a machine wrote money. Deleting it or rewriting it destroys the only record of that, so
-- neither is possible for any role including the trusted server. The one permitted mutation is
-- recording a reversal, once -- `old.reverted_at is not null` makes it a one-way door.
create function public.document_auto_actions_guard_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_auto_action_immutable' using errcode = '42501';
  end if;
  -- INSERT is guarded too, and that is the half B1 found missing. A row born already reverted
  -- passes every UPDATE guard by never being updated, and -- because both unique indexes that
  -- make this table an idempotency key are partial on `reverted_at is null` -- it occupies no
  -- slot at all. The key would still be there and would simply stop keying.
  if tg_op = 'INSERT' then
    if new.reverted_at is not null
       or new.reverted_reason is not null
       or new.reverted_by is not null then
      raise exception 'document_auto_action_born_reverted' using errcode = '22023';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.interpretation_id is distinct from old.interpretation_id
     or new.outcome is distinct from old.outcome
     or new.invoice_id is distinct from old.invoice_id
     or new.exception_id is distinct from old.exception_id
     or new.filing_id is distinct from old.filing_id
     or new.order_id is distinct from old.order_id
     or new.decision is distinct from old.decision
     or new.created_at is distinct from old.created_at
     or old.reverted_at is not null then
    raise exception 'document_auto_action_immutable' using errcode = '42501';
  end if;
  return new;
end
$fn$;

revoke all on function public.document_auto_actions_guard_columns()
  from public, anon, authenticated, service_role;

create trigger document_auto_actions_guard_columns_trg
  before insert or update or delete on public.document_auto_actions
  for each row execute function public.document_auto_actions_guard_columns();

-- ===== 3. The command =====
--
-- THREE OUTCOMES, PLUS ONE REFUSAL THAT IS NOT AN OUTCOME.
--
--   auto_applied       the invoice, its order link when the document names one, the filing, the
--                      audit row and the auto-action row -- one transaction, all or nothing.
--   archived           document_type = 'other'. The document moves to the archive and the
--                      decision is filed. ZERO financial writes.
--   queued_for_review  everything else. One filing row with decided_by = 'system', naming the
--                      reason, and nothing else. The document waits for a person.
--
--   already_decided    NOT a fourth decision -- a precondition refusal, like not_authorized. It
--                      means a person or an earlier run already decided this document, and the
--                      machine does not overrule them. It writes NOTHING. It exists because B1
--                      proved that "archived" and "has a filing" are independent facts: a human
--                      can archive through file_document without any filing row at all, so a
--                      command that only checked document_filings would happily invoice a
--                      document somebody had already thrown away.
--
-- ORDER OF THE GUARDS IS THE CONTRACT, not an implementation detail:
--   organization status  -> the system may not act for a suspended tenant at all
--   autonomy switch      -> OFF MEANS ZERO, including zero archiving. Archiving is a write.
--   document_type=other  -> archive (the owner's diagram, second arm)
--   confidence           -> min(type, supplier) against the tenant's threshold
--   the named stops      -> supplier, total, amounts, duplicate, allocation conflict
create or replace function public.apply_document_interpretation(
  p_job_id            uuid,
  p_interpretation_id uuid,
  p_actor_id          uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $cmd$
declare
  v_i               public.document_interpretations;
  v_doc             public.documents;
  v_org             uuid;
  v_org_status      org_status;
  v_policy          record;
  v_payload         jsonb;
  v_type            text;
  v_type_conf       numeric;
  v_supplier_conf   numeric;
  v_decision_conf   numeric;
  v_supplier_id     uuid;
  v_number          text;
  v_number_key      text;
  v_date            date;
  v_total           numeric;
  v_before          numeric;
  v_vat             numeric;
  v_order_number    numeric;
  v_order           public.purchase_orders;
  v_outcome         text;
  v_reason_code     text;
  v_reason          text;
  v_existing_action public.document_auto_actions;
  v_existing_filing public.document_filings;
  v_replay          boolean := false;
  v_filing_id       uuid;
  v_invoice_id      uuid;
  v_exception_id    uuid;
  v_unordered       jsonb;
  v_triggered_by    uuid;
  v_decision        jsonb;
  v_result          jsonb;
begin
  if p_job_id is null or p_interpretation_id is null then
    raise exception 'interpretation_arguments_required' using errcode = '22023';
  end if;

  -- The job and the interpretation must be the SAME job. Passing a mismatched pair is how a
  -- caller would apply one document's conclusions to another document's row, and the tenant
  -- composite keys below would not catch it because both belong to the same tenant.
  select * into v_i
  from public.document_interpretations
  where id = p_interpretation_id and job_id = p_job_id;
  if not found then
    raise exception 'interpretation_unknown' using errcode = 'P0002';
  end if;
  v_org := v_i.org_id;
  v_payload := v_i.payload;

  -- The policy is read through the PRIVATE door, taking the organization explicitly. The public
  -- evaluate_autonomy_policy resolves through auth_org(), which is NULL here, so it would answer
  -- "off" for every call this command will ever make. autonomy_policy_unknown is RAISED by the
  -- resolver and deliberately not caught: an unknown policy key is a broken deployment, and
  -- swallowing it into a default is how a broken deployment becomes a silent one.
  select * into v_policy
  from private.autonomy_policy_for_org(v_org, 'document.interpretation');

  -- A resolver that returns NO ROWS leaves v_policy entirely NULL and does NOT raise -- `select
  -- ... into` is silent about zero rows. Every test below would then run against a policy of
  -- all-NULLs, and three-valued logic turns that into auto-apply (see the coalesce note below).
  -- Fail closed and by name instead.
  if not found then
    raise exception 'autonomy_policy_unresolved' using errcode = 'P0002';
  end if;

  -- C1 finding 7, refused independently of the resolver that also refuses it. Never 0, never a
  -- default: a caller comparing `confidence >= 0` auto-applies everything, and the whole point
  -- of the threshold is that it is a number somebody chose.
  --
  -- THE coalesce IS THE POINT, not defensive noise. Written as a bare
  -- `if v_policy.autonomy_enabled and v_policy.min_confidence is null`, a NULL autonomy_enabled
  -- makes the whole condition NULL, plpgsql skips the branch, `not v_policy.autonomy_enabled` is
  -- NULL so THAT branch is skipped too, and `0.99 < null` is NULL so the threshold test is
  -- skipped as well -- and the chain falls all the way through to auto_applied for a tenant
  -- nobody enabled, with no threshold ever compared. The switch failed OPEN, in the file whose
  -- stated thesis is that it refuses independently of the resolver. This is the same hole review
  -- already found once in 0076's baseline_enabled, wearing three-valued logic instead of a
  -- missing constraint. Unknown means ENABLED here (so the threshold is demanded) and DISABLED
  -- below (so nothing is written): both directions of unknown fail closed.
  if coalesce(v_policy.autonomy_enabled, true) and v_policy.min_confidence is null then
    raise exception 'autonomy_threshold_missing' using errcode = '22023';
  end if;

  select * into v_doc
  from public.documents
  where id = v_i.document_id and org_id = v_org and deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  -- ---- The collision, handled BEFORE any write (see note 4 in the header) ----
  select * into v_existing_action
  from public.document_auto_actions
  where org_id = v_org and document_id = v_doc.id and reverted_at is null;
  if found then
    if v_existing_action.interpretation_id = p_interpretation_id then
      -- The same interpretation, replayed. Return what was decided; write nothing.
      -- Same SHAPE as the first call, not merely the same outcome. A replay that omitted
      -- order_id and filing_id made `result -> 'order_id'` SQL NULL on the second call and JSON
      -- null on the first, so a caller comparing the two -- or a test asserting on either --
      -- would read a difference that does not exist in the record.
      return v_existing_action.decision
        || jsonb_build_object(
             'outcome', v_existing_action.outcome,
             'invoice_id', v_existing_action.invoice_id,
             'exception_id', v_existing_action.exception_id,
             'filing_id', v_existing_action.filing_id,
             'order_id', v_existing_action.order_id,
             'auto_action_id', v_existing_action.id,
             'document_id', v_doc.id,
             'idempotent', true);
    end if;
    -- A DIFFERENT interpretation of a document that already has a live automatic write. Acting
    -- would buy the same goods twice.
    return jsonb_build_object(
      'outcome', 'already_decided', 'reason_code', 'auto_action_exists',
      'document_id', v_doc.id, 'auto_action_id', v_existing_action.id, 'idempotent', true);
  end if;

  select * into v_existing_filing
  from public.document_filings
  where org_id = v_org and document_id = v_doc.id and reverted_at is null;
  v_replay := found and v_existing_filing.interpretation_id is not distinct from p_interpretation_id;

  if v_existing_filing.id is not null and not v_replay then
    return jsonb_build_object(
      'outcome', 'already_decided', 'reason_code', 'filing_exists',
      'document_id', v_doc.id, 'filing_id', v_existing_filing.id, 'idempotent', true);
  end if;

  -- A document a person moved out of the inbox has been decided, whether or not that left a
  -- filing row behind. B1 finding 1: file_document archives WITHOUT writing one.
  --
  -- NO `and not v_replay` HERE, and that is a correction, not an omission. The replay escape is
  -- only ever safe while the document is STILL IN THE INBOX. With it, this sequence reopened the
  -- refusal completely: an unconfigured tenant queues the document (leaving an active filing from
  -- this interpretation) -> a person archives it through file_document, which writes no filing
  -- row at all -> an operator enables autonomy -> the same interpretation replays -> v_replay is
  -- true, BOTH guards are skipped, and the invoice is inserted. Nothing persisted only because
  -- documents_guard_columns happens to forbid archive -> invoice, so the command died on a raw
  -- unnamed 42501 and the caller retried forever. If that transition is ever widened -- and
  -- rescue_document_from_archive already exists -- a replay would silently overrule a person and
  -- write a financial record. The escape stays on the filing-collision guard above, where the
  -- document is by definition still unfiled.
  if v_doc.entity_type <> 'inbox' then
    return jsonb_build_object(
      'outcome', 'already_decided', 'reason_code', 'document_already_filed',
      'document_id', v_doc.id, 'entity_type', v_doc.entity_type, 'idempotent', true);
  end if;

  -- ---- The decision ----
  v_type := v_payload ->> 'document_type';
  v_type_conf := private.interpretation_number(v_payload -> 'document_type_confidence');
  v_supplier_conf := private.interpretation_number(v_payload #> '{supplier,confidence}');
  -- NULL-PROPAGATING minimum. least() ignores nulls; this must not (see note 3 in the header).
  v_decision_conf := case
    when v_type_conf is null or v_supplier_conf is null then null
    else least(v_type_conf, v_supplier_conf)
  end;
  v_supplier_id := v_i.suggested_supplier_id;

  -- SANITIZED, not btrim'd. btrim strips spaces only, and an RLM survives it invisibly -- into
  -- the stored number, and into both sides of the duplicate comparison below.
  v_number := private.document_text_sanitize(
    private.interpretation_field(v_payload, array[
      'invoice_number', 'document_number', 'מספר חשבונית', 'מספר מסמך']) #>> '{}');
  v_number_key := private.document_text_key(v_number);
  v_date := private.interpretation_date(
    private.interpretation_field(v_payload, array[
      'invoice_date', 'document_date', 'date', 'תאריך חשבונית', 'תאריך המסמך', 'תאריך']));
  v_total := private.interpretation_number(
    private.interpretation_field(v_payload, array[
      'total', 'total_amount', 'grand_total', 'amount_due', 'סכום כולל', 'סה"כ לתשלום']));
  v_before := private.interpretation_number(
    private.interpretation_field(v_payload, array[
      'subtotal', 'amount_before_vat', 'net_amount', 'סכום לפני מעמ', 'סה"כ לפני מע"מ']));
  v_vat := private.interpretation_number(
    private.interpretation_field(v_payload, array[
      'vat_amount', 'vat', 'tax_amount', 'מעמ', 'מע"מ']));

  select status into v_org_status from public.organizations where id = v_org;

  if v_org_status not in ('trial', 'active') then
    -- The precedent is interpret-document/index.ts:356-361: a suspended tenant's pipeline does
    -- not run. A suspended tenant's machine writer must not either, switch or no switch.
    v_outcome := 'queued_for_review'; v_reason_code := 'organization_inactive';
  elsif not coalesce(v_policy.autonomy_enabled, false) then
    -- OFF MEANS ZERO -- including zero archiving. Moving a document to the archive is a write to
    -- documents and takes it out of the manager's inbox; a tenant that never granted the
    -- authority does not get it for the outcomes that happen to be cheap.
    v_outcome := 'queued_for_review'; v_reason_code := 'autonomy_disabled';
  elsif v_type = 'other' then
    -- The owner's diagram, second arm: nothing fits, so the document leaves the queue rather
    -- than sitting in it forever. Reversible in one reasoned action
    -- (rescue_document_from_archive), and financially inert.
    v_outcome := 'archived'; v_reason_code := 'document_type_other';
  elsif v_decision_conf is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'confidence_unknown';
  elsif v_decision_conf < v_policy.min_confidence then
    v_outcome := 'queued_for_review'; v_reason_code := 'below_confidence_threshold';
  elsif v_type <> 'invoice' then
    -- A delivery note above the bar is a confident identification of something that is not a
    -- supplier charge. There is no invoice to create, and inventing one from a delivery note is
    -- how a business pays for goods twice.
    v_outcome := 'queued_for_review'; v_reason_code := 'not_an_invoice';
  elsif v_supplier_id is null then
    -- Stop 1. An unidentified supplier means there is nothing to attach the money to. The
    -- likeliest supplier is still a guess, and this is the one place a guess signs a cheque.
    v_outcome := 'queued_for_review'; v_reason_code := 'supplier_unidentified';
  elsif v_number is null or v_date is null then
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_identity_missing';
  elsif length(v_number) > 100 then
    -- Not truncated -- REFUSED. Truncating would store a DIFFERENT number than the document
    -- shows, silently, on a financial record, and would then compare that invented number
    -- against the duplicate key. A number this long is a transcription failure, not an identity.
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_number_unreasonable';
  elsif v_total is null or v_total < 0 then
    -- Stop 2. An invoice without an amount is not an invoice.
    v_outcome := 'queued_for_review'; v_reason_code := 'total_missing';
  elsif v_before is null or v_vat is null or v_before < 0 or v_vat < 0
        or round(v_before, 2) + round(v_vat, 2) <> round(v_total, 2) then
    -- The breakdown must come FROM THE DOCUMENT and must add up. create_invoice enforces exactly
    -- this for the human path (invoice_amounts_invalid), and the alternative here -- deriving
    -- the split from organizations.vat_rate when the model transcribed only a total -- would
    -- write a VAT figure the document never stated onto a record a tax authority may read.
    -- Storing 0/0/total instead is the same lie in a different column.
    --
    -- Negatives are refused explicitly: create_invoice does (0023:1722-1725) and the claim above
    -- that it "enforces exactly this" was only true of the sum. `before=-1000, vat=2180,
    -- total=1180` reconciles perfectly and was measured auto-applying, leaving the machine path
    -- WEAKER than the human one on the very check this comment cites. Each part is rounded
    -- BEFORE the comparison for the same reason: 1000.004 + 180.004 equals 1180.008, which
    -- passed against a stated total of 1180.01 and then stored 1180.00.
    v_outcome := 'queued_for_review'; v_reason_code := 'amounts_unreconciled';
  elsif exists (
    select 1 from public.invoices i
    where i.org_id = v_org and i.supplier_id = v_supplier_id
      and private.document_text_key(i.invoice_number) = v_number_key
      and i.deleted_at is null
      and exists (select 1 from public.payment_allocations pa where pa.invoice_id = i.id)
  ) then
    -- Stop 4, checked before stop 3 because it is the more specific and more dangerous fact: an
    -- invoice under this key has already had money allocated against it. Writing a second one
    -- moves a computed balance that somebody has already acted on.
    v_outcome := 'queued_for_review'; v_reason_code := 'payment_allocation_conflict';
  elsif exists (
    select 1 from public.invoices i
    where i.org_id = v_org and i.supplier_id = v_supplier_id
      and private.document_text_key(i.invoice_number) = v_number_key
      and i.deleted_at is null
  ) then
    -- Stop 3: the 0053 key -- org_id + supplier_id + the normalised number on a live row --
    -- STRENGTHENED past `lower(trim(...))`, which an invisible character walks straight through.
    -- Paying twice is the worst damage this system can do, and that sentence has to be true of
    -- the code under it.
    --
    -- Not sargable against invoices_org_live_duplicate_key_idx, deliberately and cheaply: that
    -- index is built on lower(trim(...)), the exact expression this stop exists to distrust.
    -- The predicate still narrows on (org_id, supplier_id) through invoices_supplier_idx, and
    -- this runs once per document rather than in any list path.
    v_outcome := 'queued_for_review'; v_reason_code := 'duplicate_invoice_number';
  else
    v_outcome := 'auto_applied'; v_reason_code := null;
  end if;

  -- THE REASON IS A CONTRACT, NOT DECORATION. A person reading audit_logs a year from now must
  -- be able to reconstruct why a machine created this record: which model, which prompt version,
  -- which interpretation, and the confidence that justified it. All four, or the row is an
  -- unexplained financial write.
  v_reason := format(
    'שיוך אוטומטי לפי פירוש מסמך. מודל: %s, גרסת פרומפט: %s, פירוש: %s, ביטחון: %s',
    v_i.model, v_i.prompt_version, v_i.id,
    coalesce(v_decision_conf::text, 'לא ידוע'));

  -- WHO SET THE PIPELINE RUNNING -- which is NOT who decided. p_actor_id is recorded here, in
  -- the decision record, and NOWHERE ELSE: audit_logs.user_id stays NULL for every row this
  -- command writes. "This ran because Moshe uploaded a document" and "Moshe decided to create
  -- this invoice" are different claims, and only the first one is true. Resolved against
  -- profiles in this tenant first, so a caller cannot stamp an arbitrary uuid onto the record.
  select p.id into v_triggered_by
  from public.profiles p
  where p.id = p_actor_id and p.org_id = v_org;

  v_decision := jsonb_build_object(
    'triggered_by', to_jsonb(v_triggered_by),
    'model', v_i.model,
    'provider', v_i.provider,
    'prompt_version', v_i.prompt_version,
    'interpretation_id', v_i.id,
    'document_type', v_type,
    'document_type_confidence', to_jsonb(v_type_conf),
    'supplier_confidence', to_jsonb(v_supplier_conf),
    'decision_confidence', to_jsonb(v_decision_conf),
    'min_confidence', to_jsonb(v_policy.min_confidence),
    'reason_code', to_jsonb(v_reason_code));

  -- ---- The effects ----
  if v_outcome = 'archived' and v_doc.entity_type = 'inbox' then
    update public.documents
    set entity_type = 'archive', entity_id = null
    where id = v_doc.id;

    -- user_id NULL: no human decided this. audit_row_change's null-actor arm is what makes a
    -- trusted-server write legal here, and it is also the only thing that will let a reader tell
    -- this row apart from a person's archive decision.
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_org, null, 'document_archived_by_interpretation', 'documents', v_doc.id,
      jsonb_build_object('entity_type', v_doc.entity_type, 'entity_id', v_doc.entity_id),
      v_decision || jsonb_build_object('entity_type', 'archive', 'entity_id', null),
      v_reason);
  end if;

  if v_outcome = 'auto_applied' then
    v_invoice_id := gen_random_uuid();

    -- Direct INSERT rather than create_invoice, and the reason is measured, not stylistic:
    -- create_invoice opens with auth_org()/auth.uid()/auth_role() and raises
    -- invoice_create_not_authorized for a caller with no JWT -- which is every caller this
    -- command has. p1_financial_command_guard admits the write because a trusted server job has
    -- no end-user subject (0023:64-67), which is the same door migrations and seeds use.
    insert into public.invoices (
      id, org_id, supplier_id, invoice_number, invoice_date, received_date,
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes
    ) values (
      v_invoice_id, v_org, v_supplier_id, v_number, v_date, current_date,
      null, round(v_before, 2), round(v_vat, 2), round(v_total, 2),
      -- 'received', never 'approved'. The owner granted permission to CREATE the record without
      -- a human, not to approve it: approval is a separate reasoned command with its own role
      -- check, and auto-approving would carry the machine's authority into the payment path.
      'received'::invoice_review_status,
      'נוצר אוטומטית מפירוש מסמך ' || v_i.id::text);

    -- THE ORDER LINK, ON EVIDENCE ONLY. The interpretation contract carries no order reference
    -- of any kind (interpret-document/core.ts:123-174 -- fields[] is free-form), so the only
    -- honest link is one the model actually transcribed off the page and that resolves to
    -- exactly one order of THAT supplier. Matching "the single open order for this supplier"
    -- instead would attach an invoice to the wrong order whenever a supplier has one open order
    -- and the document belongs to another -- corrupting order status and the savings analyses
    -- built on it. No number, or a number that does not resolve, means no link: the invoice is
    -- still created and a person can link it later.
    v_order_number := private.interpretation_number(
      private.interpretation_field(v_payload, array[
        'order_number', 'purchase_order_number', 'po_number', 'reference_order_number',
        'מספר הזמנה', 'הזמנה']));
    -- Bounded to int4 BEFORE the cast. purchase_orders.number is an identity integer, and a
    -- supplier printing a date-shaped reference like 20260403001 raised `22003: integer out of
    -- range` from the cast itself -- aborting the entire command and creating NO invoice, which
    -- directly contradicts the contract stated just above that an unresolvable number still
    -- leaves the invoice written. An out-of-range number is simply not an order of ours.
    if v_order_number is not null
       and v_order_number = trunc(v_order_number)
       and v_order_number between 1 and 2147483647 then
      select * into v_order
      from public.purchase_orders po
      where po.org_id = v_org
        and po.supplier_id = v_supplier_id
        and po.number = v_order_number::int
        and po.status <> 'cancelled';
      if found then
        -- org_id is SPELLED OUT, not left to the column default. That default is auth_org(),
        -- which is NULL for this caller -- every sibling command runs with a user JWT and gets
        -- the right tenant for free, and this one would have died on a not-null violation after
        -- writing the invoice. The same is true of every other table with an auth_org() default
        -- that a trusted-server path ever touches.
        insert into public.invoice_order_links (org_id, invoice_id, order_id)
        values (v_org, v_invoice_id, v_order.id);
      end if;
    end if;

    -- THE UNORDERED ITEM. purchase_order_items is NOT written -- see the header. The gap becomes
    -- an exception the manager must decide, which is what "התקבל פריט שלא הוזמן" actually is.
    --
    -- MATCHED ON IDENTIFIERS ONLY, never on free text. A line the model transcribed with a SKU
    -- or a barcode can be compared to what was ordered; a line with only a description cannot,
    -- because "עגבניות שרי 500 גרם" and "עגבניות שרי" are the same product to a person and
    -- different strings to Postgres. Lines with no identifier are skipped entirely rather than
    -- guessed at: a false "you did not order this" trains the manager to dismiss the exception,
    -- which is worse than not raising it.
    if v_order.id is not null then
      select jsonb_agg(item) into v_unordered
      from (
        select jsonb_build_object(
                 'source_row', li.value -> 'source_row',
                 'sku', li.value #> '{values,sku}',
                 'barcode', li.value #> '{values,barcode}',
                 'description', li.value #> '{values,description}') as item
        from jsonb_array_elements(v_payload -> 'line_items') li
        where coalesce(nullif(btrim(li.value #>> '{values,sku}'), ''),
                       nullif(btrim(li.value #>> '{values,barcode}'), '')) is not null
          and not exists (
            select 1
            from public.purchase_order_items poi
            join public.products p on p.id = poi.product_id
            where poi.order_id = v_order.id
              -- Normalised on BOTH sides, the same as the duplicate key. This comparison had the
              -- identical `lower(btrim(...))` defect and it fails in the more insidious
              -- direction: a line transcribed as `SKU-ORDERED` with a trailing RLM matched
              -- nothing on the order, so the command opened an item_not_ordered exception
              -- naming an item that WAS ordered. The note 200 lines below says a false "you did
              -- not order this" trains the manager to dismiss the exception, "which is worse
              -- than not raising it" -- so a false positive here is not a lesser bug than the
              -- duplicate, it is the bug that particular sentence warns about.
              and (private.document_text_key(p.sku)
                     = private.document_text_key(li.value #>> '{values,sku}')
                or private.document_text_key(p.barcode)
                     = private.document_text_key(li.value #>> '{values,barcode}'))
          )
      ) unordered;

      if v_unordered is not null and jsonb_array_length(v_unordered) > 0 then
        -- receipt_mismatch is the existing vocabulary for "what arrived does not match what the
        -- paperwork says" and its Hebrew label already reads פער קבלה מול חשבונית
        -- (src/lib/status.ts:127). A new enum value would need alter type add value -- unusable
        -- in the transaction that adds it -- plus a label in a file this task does not own.
        insert into public.exceptions (
          org_id, type, severity, status, title, details,
          supplier_id, invoice_id, assigned_role
        ) values (
          v_org, 'receipt_mismatch', 'medium', 'open',
          'התקבל פריט שלא הוזמן — חשבונית ' || v_number,
          jsonb_build_object(
            'code', 'item_not_ordered',
            'order_id', v_order.id,
            'order_number', v_order.number,
            'interpretation_id', v_i.id,
            'items', v_unordered),
          v_supplier_id, v_invoice_id, 'office')
        returning id into v_exception_id;
      end if;
    end if;

    -- The document is filed to the invoice it produced. Without this the gallery keeps showing
    -- it as unfiled while its invoice already exists -- the exact state §12 calls "requires
    -- attention" for a document that requires none.
    update public.documents
    set entity_type = 'invoice',
        entity_id = v_invoice_id,
        supplier_id = v_supplier_id,
        document_date = v_date
    where id = v_doc.id;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_org, null, 'invoice_created_by_interpretation', 'invoices', v_invoice_id, null,
      v_decision || jsonb_build_object(
        'supplier_id', v_supplier_id,
        'invoice_number', v_number,
        'invoice_date', v_date,
        'total_amount', round(v_total, 2),
        'document_id', v_doc.id,
        'order_id', v_order.id,
        'exception_id', v_exception_id),
      v_reason);
  end if;

  -- The filing row, for every outcome. Inserted PLAINLY -- no ON CONFLICT (see note 4). The
  -- collision was already handled above; this insert failing means a concurrent second caller
  -- got there first, and failing loudly is correct.
  if not v_replay then
    insert into public.document_filings (
      org_id, document_id, category, supplier_id, interpretation_id, confidence, decided_by
    ) values (
      v_org, v_doc.id, v_type, v_supplier_id, v_i.id, v_decision_conf, 'system'
    ) returning id into v_filing_id;
  else
    v_filing_id := v_existing_filing.id;
  end if;

  if v_outcome = 'auto_applied' then
    insert into public.document_auto_actions (
      org_id, document_id, interpretation_id, outcome,
      invoice_id, exception_id, filing_id, order_id, decision
    ) values (
      v_org, v_doc.id, v_i.id, 'auto_applied',
      v_invoice_id, v_exception_id, v_filing_id, v_order.id, v_decision);
  end if;

  v_result := v_decision || jsonb_build_object(
    'outcome', v_outcome,
    'document_id', v_doc.id,
    'filing_id', v_filing_id,
    'invoice_id', v_invoice_id,
    'order_id', v_order.id,
    'exception_id', v_exception_id,
    'idempotent', v_replay);
  return v_result;
end
$cmd$;

revoke all on function public.apply_document_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
-- The trusted server and nobody else. A browser role holding EXECUTE here would be a browser
-- role that can author an invoice with no reason and no human -- and revoking from
-- service_role first, then granting, is deliberate: `revoke ... from service_role` alone would
-- leave a default grant in place on some deployments.
grant execute on function public.apply_document_interpretation(uuid, uuid, uuid) to service_role;

comment on function public.apply_document_interpretation(uuid, uuid, uuid) is
  'Acts on one document interpretation inside a single transaction: creates the invoice above '
  'the tenant''s confidence threshold, archives what the model calls "other", and queues '
  'everything else for a person. Reads private.autonomy_policy_for_org -- never '
  'evaluate_autonomy_policy, which always answers "off" to the trusted server because auth_org() '
  'is NULL there. The compared number is min(document_type_confidence, supplier.confidence) with '
  'a null-propagating minimum. Never writes purchase_order_items. Every audit row it writes '
  'carries user_id NULL, because no human decided.';

-- ===== 4. Registry (A1) + the A5 exemption + the re-assert block =====
-- derived/unenforced, matching all thirteen document_* siblings: this table inherits tenant and
-- scope through its composite key to documents, and a derived table must never receive its own
-- scope column (ADR-0004 section 4).
insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_auto_actions', 'derived', false);

-- A5: a SECURITY DEFINER function whose body names enforced tables (documents, invoices,
-- purchase_orders). The reason states WHY it cannot be scope-aware today, so the multi-unit
-- enablement wave that drains this registry can judge it on the argument.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.apply_document_interpretation(uuid,uuid,uuid)'::regprocedure::text,
  'trusted-server-no-scope -- cannot filter on auth_scopes(): this command runs with no user '
    || 'JWT at all (the Edge Function carries the service key), so auth_scopes() is empty and '
    || 'every scoped read would return nothing, silently turning the whole decision layer off. '
    || 'The tenant boundary is pinned EXPLICITLY by the interpretation''s own org_id and by the '
    || 'tenant-composite foreign keys on every row it writes. Remediate by passing the acting '
    || 'unit in from the Edge Function once documents carries a meaningful unit_id; today an '
    || 'inbox document is unit_id NULL by design (0055:112).',
  'multi-unit enablement wave');

do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0077 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
