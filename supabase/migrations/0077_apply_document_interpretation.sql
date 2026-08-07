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

-- ===== The residual denylist, and an honest statement of why it is a denylist =====
--
-- Storage keeps its denylist deliberately (faithfulness is the goal, so "keep unless known bad"
-- is the right default), and that means storage cannot borrow the key's completeness proof. It
-- gets the closest available substitute: Postgres CAN classify most invisible characters --
-- `chr(8207) !~ '[[:graph:]]'` is true for the RLM, the SOFT HYPHEN, U+0600 and the TAG block --
-- and p14 asserts as a PROPERTY that everything this function emits is graphic or a plain space.
--
-- But that classification has holes, MEASURED rather than assumed: U+3164 HANGUL FILLER reports
-- graph=true AND alnum=true, and U+FE0F VARIATION SELECTOR-16 reports graph=true, though neither
-- has any visual form. So the property assertion alone would leave them in a stored number. The
-- three ranges below are exactly the holes -- named because Postgres is wrong about them, not
-- because we are guessing at a set.
--
-- THE RESIDUAL RISK IS STATED, NOT HIDDEN: an invisible character Postgres misclassifies and
-- this list does not name would survive into a stored invoice number and make it harder to find
-- by search. It could NOT cause a double payment, because duplicate detection runs on
-- document_text_key, which is an allowlist and is complete by construction. That asymmetry is
-- the whole reason the two functions have different shapes.
create or replace function private.document_text_sanitize(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(
        translate(
          translate(p_text,
            chr(160) || chr(8239) || chr(8287) || chr(12288),
            '    '),
          chr(1564)
            || chr(8206) || chr(8207)
            || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
            || chr(8294) || chr(8295) || chr(8296) || chr(8297)
            || chr(8203) || chr(8204) || chr(8205)
            || chr(8288) || chr(8289) || chr(8290) || chr(8291) || chr(8292)
            || chr(65279)
            || chr(173) || chr(847) || chr(6158),
          ''),
        -- The measured holes in Postgres's own classification.
        '[' || chr(65024) || '-' || chr(65039)      -- U+FE00-FE0F variation selectors
            || chr(917760) || '-' || chr(917999)    -- U+E0100-E01EF VS supplement
            || chr(12644)                           -- U+3164 HANGUL FILLER
            || ']', '', 'g'),
      '\s+', ' ', 'g')),
    '')
$fn$;

-- ===== Control characters, removed as a CLASS rather than by name =====
-- The C0 controls (U+0001-U+0008, U+000E-U+001F) and U+007F DEL survived every stage above:
-- they are not `\s`, so the whitespace collapse never saw them, and naming 33 code points would
-- have been one more denylist. `[[:cntrl:]]` is a class Postgres classifies CORRECTLY and
-- completely, so this deletion is a property, not a list -- the same shape as the key's
-- allowlist, applied where a property happens to be available.
--
-- ORDER MATTERS AND IS NOT ARBITRARY: the whitespace collapse runs FIRST, so a tab between two
-- words still becomes the single space a reader expects. Stripping controls first would turn
-- `INV<tab>2026` into `INV2026` instead of `INV 2026`, silently joining two fields.
create or replace function private.document_text_sanitize(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            translate(
              translate(p_text,
                chr(160) || chr(8239) || chr(8287) || chr(12288),
                '    '),
              chr(1564)
                || chr(8206) || chr(8207)
                || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
                || chr(8294) || chr(8295) || chr(8296) || chr(8297)
                || chr(8203) || chr(8204) || chr(8205)
                || chr(8288) || chr(8289) || chr(8290) || chr(8291) || chr(8292)
                || chr(65279)
                || chr(173) || chr(847) || chr(6158),
              ''),
            '[' || chr(65024) || '-' || chr(65039)
                || chr(917760) || '-' || chr(917999)
                || chr(12644)
                || ']', '', 'g'),
          '\s+', ' ', 'g'),
        '[[:cntrl:]]', '', 'g'),
      '\s+', ' ', 'g')),
    '')
$fn$;

-- ==========================================================================================
-- THE KEY IS AN ALLOWLIST. THIS IS THE THIRD VERSION AND THE REASON IS THE METHOD, NOT THE
-- CHARACTERS.
--
-- Version one deleted five invisible characters. Review exhibited four more. Version two
-- completed the bidi controls and the U+2060-2064 range -- twelve of twelve, sets completed
-- rather than exhibits patched, which was the right instinct applied to the wrong structure.
-- Review then stopped guessing and SWEPT it: every code point in Cf, Zs, Zl, Zp, Cc plus the
-- whole Default_Ignorable_Code_Point set, 4,289 candidates, through this function.
--
--     413 assigned code points still survived.
--
-- Seven were confirmed writing a second live invoice under one number end to end -- U+FE0F,
-- U+0600, U+E0041, U+206F, U+3164, U+FFF9, U+E0100 -- and the survivors included ALL 272
-- variation selectors, the entire 96-character TAG block, and U+206A-206F: the deprecated
-- shaping controls sitting IMMEDIATELY ADJACENT to the range version two had just completed.
--
-- A denylist cannot win this. The set that needs completing is 413 wide today and grows with
-- every Unicode release, so the next omission is a release note away. An invoice number is a
-- short identifier, not free text, so the safe structure is the opposite one: say what a number
-- MAY contain and delete everything else. Then a character nobody has heard of is stripped by
-- default rather than admitted by default, and no future Unicode version can reopen this.
--
-- MONOTONICALLY SAFE, which is what makes the inversion acceptable at all: an allowlist can only
-- produce MORE collisions than the truth, never fewer. A collision queues the document for a
-- person. So the failure mode of being too narrow is "a human looks at it", and the failure mode
-- of being too wide is "the business pays twice".
--
-- THREE THINGS THAT LOOK LIKE STYLE AND ARE NOT:
--
--   1. ALLOWED BY LETTERS AND DIGITS, NEVER BY SCRIPT BLOCK. Review's first attempt permitted
--      U+0600-06FF wholesale and U+0600 walked straight through -- the Arabic format characters
--      live INSIDE the Arabic block. The ranges below are letters (U+05D0-05EA, U+0620-064A) and
--      digits (U+0660-0669), never blocks.
--
--   2. WRITTEN WITH chr(), NOT LITERALS -- and here it is not merely discipline, it is required.
--      A literal Hebrew or Arabic range in a regex produced
--      `ERROR: invalid regular expression: invalid character range`, because the range operands
--      reorder visually under RTL and the parser sees them backwards. Same reason as the
--      invisible-character rule below, louder failure.
--
--   3. `/`, `.` and `-` SURVIVE. They are how humans actually separate invoice numbers, and
--      folding them would make 2026/1 and 2026-1 the same number. Measured after the inversion:
--      2026/1 <> 2026-1 and INV-123 <> INV123, both preserved exactly.
--
-- NULL IS NOW REACHABLE AND IS A STOP. A number made entirely of unrepresentable characters
-- keys to NULL, and `x = NULL` is NULL -- no duplicate found, auto-apply. The command has an
-- explicit `v_number_key is null` arm for exactly this; see invoice_number_unrepresentable.
--
-- document_text_sanitize STAYS A DENYLIST. For STORAGE you want faithfulness -- the number as
-- the document printed it, minus only what cannot be seen -- and a known-character list is the
-- right tool for that. Only the COMPARISON key inverts.
-- ==========================================================================================
create or replace function private.document_text_key(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select nullif(
    regexp_replace(
      lower(coalesce(private.document_text_sanitize(p_text), '')),
      '[^0-9a-z'
        || chr(1488) || '-' || chr(1514)   -- U+05D0-05EA Hebrew letters (finals included)
        || chr(1568) || '-' || chr(1610)   -- U+0620-064A Arabic letters
        || chr(1632) || '-' || chr(1641)   -- U+0660-0669 Arabic-Indic digits
        || '/.'                            -- human separators
        || '-]',                           -- literal hyphen, last so it is not a range
      '', 'g'),
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
  --
  -- `~ '[[:graph:]]'`, NOT `length(btrim(...)) >= 1`. C5's review measured the hole: one-argument
  -- btrim strips SPACES ONLY, so a reason of E'\t\n\r', of a single U+200F RLM, or of U+00A0 NBSP
  -- passed this constraint and landed in audit_logs as the sole human justification for undoing a
  -- machine-written invoice. `[[:graph:]]` asks a PROPERTY -- is there a character here with any
  -- visual form at all -- and refuses all four.
  --
  -- WHY NOT private.document_text_sanitize, WHICH IS RIGHT THERE AND IS COMPLETE. Measured, not
  -- assumed: a CHECK expression is evaluated as the CURRENT user, and service_role holds neither
  -- USAGE on schema `private` nor EXECUTE on that function (both verified false). An insert by the
  -- trusted server would die with `permission denied for function document_text_sanitize` -- and
  -- p11:1001-1004 inserts into document_filings AS service_role, so the "obvious" fix breaks a
  -- live suite and the trusted-server write path with it. Granting service_role into `private`
  -- would demolish the exact property header note 1 relies on. So the schema gets the property and
  -- the COMMAND gets the complete test: revert_document_auto_action runs as postgres, calls the
  -- sanitizer, and refuses by name.
  --
  -- THE RESIDUAL IS NAMED: Postgres reports graph=true for U+3164 HANGUL FILLER and U+FE0F
  -- VARIATION SELECTOR-16 though neither has a visual form (0077:249-254 measured this), so a
  -- reason made ONLY of those would satisfy this constraint. It cannot reach the table through
  -- either reasoned command, because both sanitize first. It is a backstop that is strictly
  -- better than what it replaces, not a claim of completeness.
  constraint document_auto_actions_reversal_shape check (
    (reverted_at is null and reverted_reason is null and reverted_by is null)
    or (reverted_at is not null and reverted_by is not null
        -- coalesce is load-bearing: a CHECK is satisfied by TRUE *or NULL*, and `null ~ x` is
        -- NULL, so without it a reverted row with a NULL reason would pass the whole constraint.
        and coalesce(reverted_reason, '') ~ '[[:graph:]]'
        and length(coalesce(reverted_reason, '')) <= 1000)
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
--
-- ACCOUNTANT IS DELIBERATELY NOT HERE, and C5's review was right to ask -- the rationale it
-- challenged ("same readership as document_filings") really does copy a policy about who decided
-- a filing onto a table about a machine writing money. The answer is not the rationale, it is a
-- measurement: `/documents` and `/documents/archive` are both guarded by STAFF in App.tsx:244,248,
-- and STAFF is ['owner','office','kitchen'] (App.tsx:102). An accountant cannot open the register
-- at all, so the row this policy would let them read has no screen to appear on -- and the
-- `שויך אוטומטית` badge they would supposedly be missing is on a page they cannot reach. Granting
-- a read that no view consumes would be a widened policy justified by a UI claim that is false.
-- If the accountant's screens ever need to distinguish a machine-authored invoice -- a real
-- question for the reporting path, and a better one than this table answers -- the honest fix is
-- on the INVOICE, which is what those screens actually list, not a documents-register ledger.
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

  -- A HUMAN HAS ALREADY OVERRULED A MACHINE DECISION ON THIS DOCUMENT. The machine does not get
  -- a second vote.
  --
  -- THIS GUARD EXISTS BECAUSE SECTION 4 CREATED THE HOLE IT CLOSES, and that is worth stating
  -- plainly rather than presenting the guard as foresight. Before C5 nothing anywhere could set
  -- reverted_at, so the partial unique index document_auto_actions_one_live_per_document was in
  -- practice a permanent slot: once a document had an automatic write, it had one forever. The
  -- reversal is what frees the slot -- and it frees ALL THREE refusals above and below at once:
  -- the auto-action lookup filters `reverted_at is null`, the filing lookup filters
  -- `reverted_at is null`, and the document goes back to 'inbox'. The duplicate stop is no help
  -- either, because it filters `i.deleted_at is null` and the reverted invoice is soft-deleted.
  --
  -- Measured before this block existed: revert a document, run a second job on it, and the
  -- outcome was auto_applied -- two auto-action rows, one live machine invoice, and the person's
  -- undo silently gone. Not reachable from the browser today (DocumentsInbox only asks for
  -- interpretation while a job is 'extracted', and a reverted document's job is 'completed'), but
  -- the idempotency rationale at 0077:587-589 names "a person re-ran interpretation on a document
  -- that already produced an invoice" as the realistic shape, and this is exactly the defence
  -- that stopped working. An undo the machine can quietly undo is not an undo.
  --
  -- The check is `exists`, not a lookup into v_existing_action: a reverted row is by definition
  -- not the one the query above selected, and there may be several over a document's life.
  if exists (
    select 1 from public.document_auto_actions
    where org_id = v_org and document_id = v_doc.id and reverted_at is not null
  ) then
    return jsonb_build_object(
      'outcome', 'already_decided', 'reason_code', 'auto_action_reverted_by_human',
      'document_id', v_doc.id, 'idempotent', true);
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
  elsif v_number_key is null then
    -- REACHABLE ONLY SINCE THE KEY BECAME AN ALLOWLIST, and it is a hole if left unhandled. A
    -- number made entirely of characters the key does not represent -- Cyrillic, CJK, emoji,
    -- or pure punctuation -- collapses to NULL. Every duplicate predicate below then compares
    -- `something = NULL`, which is NULL, which finds nothing, which auto-applies. This is the
    -- three-valued-logic failure from I-1 wearing a different hat, and it fails closed here.
    v_outcome := 'queued_for_review'; v_reason_code := 'invoice_number_unrepresentable';
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

    -- DEFECT (a), CARRIED FORWARD FROM C4'S REVIEW AND FIXED HERE FOR BOTH DECIDING OUTCOMES.
    -- save_document_interpretation leaves the job at 'review' (0046:1327-1329) and
    -- STAGE_USER_STATE maps review -> review (useDocumentProcessing.ts:73), so the gallery
    -- renders "בבדיקה" with the sentence "ממתין לאישורך" over a document the system has just
    -- finished deciding and that nobody needs to approve. That is the SAME false-attention state
    -- the entity_type write cites §12 to fix, left broken one table over -- and it is latent only
    -- while the switch is off. On the day a tenant is enabled it is wrong on the first document.
    --
    -- `and status = 'review'` is NOT defensive noise, and this is the exact shape 0048:1743-1748
    -- already uses for the same table. 0046:199-202 makes review -> completed legal and makes
    -- completed/failed TERMINAL: an unguarded update against a job that has since failed raises
    -- document_processing_terminal_state and aborts the WHOLE command -- destroying the invoice
    -- it had already written, in the name of tidying a badge.
    update public.document_processing_jobs
    set status = 'completed', last_error_code = null, last_error_message = null
    where org_id = v_org and id = v_i.job_id and status = 'review';

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
        -- The skip test uses the SAME key as the match test, deliberately. With btrim here and
        -- the key there, an identifier made only of characters the key cannot represent would
        -- pass this guard (btrim leaves it non-empty), then match nothing (its key is NULL),
        -- and be reported as an item nobody ordered. One function on both sides means the two
        -- can never disagree about what counts as an identifier.
        where coalesce(private.document_text_key(li.value #>> '{values,sku}'),
                       private.document_text_key(li.value #>> '{values,barcode}')) is not null
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

    -- The job stage, for the same reason and under the same guard as the archive branch above.
    -- It matters MORE here: the archived document at least left the working folder, while an
    -- auto-applied one sits in the register showing "ממתין לאישורך" beside a badge that says it
    -- is filed to an invoice. The row would contradict itself on two columns at once.
    update public.document_processing_jobs
    set status = 'completed', last_error_code = null, last_error_message = null
    where org_id = v_org and id = v_i.job_id and status = 'review';

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

-- ===== 4. REVERSAL IN ONE REASONED ACTION (task C5) =====
--
-- ==========================================================================================
-- THE OTHER HALF OF THE OWNER'S DECISION. Section 3 lets a model author a financial record;
-- without this section that record has no way back, and "the machine may write invoices" would
-- mean "the machine may write invoices you are stuck with". Reversal is not a courtesy feature
-- bolted on afterwards -- it is the condition under which the permission was grantable at all.
--
-- WHO MAY REVERSE, AND WHY IT IS NOT "THE ACTOR WHO DID IT". The usual answer -- the person who
-- performed the action, or their manager -- has no meaning here: the actor was a machine and
-- every audit row it wrote carries user_id NULL by design (header note 5). So the authority is
-- taken from what this codebase already does for the three comparable reversals, not invented:
-- soft_delete_invoice (0034:120), rescue_document_from_archive (0075:377) and file_document all
-- gate on owner/office. `kitchen` reads both ledgers and files nothing, and does not reverse.
--
-- WHAT IT UNDOES, IN ONE TRANSACTION:
--   * the invoice          -- SOFT deleted, through the LIVE soft_delete_invoice, never by hand
--   * the document         -- back to the inbox, the queue a person actually works from
--   * the filing           -- reverted_at + reverted_reason, the 0075 shape
--   * the exception        -- dismissed with a note that says WHY, not that anything was checked
--   * the auto-action row  -- reverted_at/_by/_reason, and never again (the one-way door)
--
-- WHAT IT DOES NOT UNDO, DELIBERATELY:
--   * The two audit rows the creation wrote. Reversal is a SECOND EVENT, not an erasure. "A
--     machine created this invoice, and then a person disagreed and said why" is the history
--     worth having; deleting the first half would leave a business unable to answer how many
--     records its automation wrote.
--   * document_filings rows. The guard forbids deleting one, and that is the point.
--   * invoice_order_links. soft_delete_invoice does not unlink for the human path either, and
--     the link is only reachable through an invoice that is now deleted.
--   * documents.supplier_id / document_date. The person repudiated the FILING, not everything
--     the document is known to say -- the same judgement 0075:161-165 made for the archive.
--
-- WHY IT REUSES soft_delete_invoice RATHER THAN WRITING deleted_at ITSELF. Three things come
-- with it that a hand-rolled update would each have had to re-derive and could each have got
-- wrong: (1) the financial-reference refusal -- an invoice with a payment allocated against it,
-- an export, or a credit request must NOT vanish, and invoice_has_financial_references is the
-- existing name for that; (2) the app.p0_invoice_soft_delete_writer GUC that
-- p0_invoice_soft_delete_guard demands of any caller holding a JWT -- omit it and the update
-- dies as invoice_soft_delete_rpc_required; (3) its own reasoned audit row. It is a definer
-- resolving through auth_org()/auth.uid(), which are exactly the values this command already
-- has, so it composes without any impersonation.
-- ==========================================================================================

-- ----- 4a. The guard learns the one transition a reversal needs -----
--
-- The live refiling predicate admits four legs and `invoice -> inbox` is not among them, so
-- before this block the document CANNOT go back: the reversal would leave it reading
-- "משויך" / "שויך לחשבונית" against an invoice that no longer exists, which is precisely the
-- class of statement this wave has spent its reviews removing.
--
-- Read from pg_get_functiondef and patched by anchored substitution -- never re-declared from
-- 0075's text. That is not ceremony: this function is a live SECURITY DEFINER holding its own A5
-- exemption, and B1's migration exists because file_document reads `security invoker` in 0019
-- while 0022:388 had altered it to definer. The anchor is asserted first and the migration fails
-- if the body has moved.
--
-- THE LEG IS NARROW ON PURPOSE, and the difference matters. What is added is
-- `invoice -> inbox WITH A NULL ENTITY` -- not a general invoice->anything, and emphatically not
-- the `archive -> invoice` transition that p14's I-2 scenario relies on staying shut: that one is
-- what stops a replay silently overruling a person who archived a document (0077:844-851). It is
-- untouched here, and p14 asserts it is still refused.
do $c5guard$
declare
  v_def text := replace(
    pg_get_functiondef('public.documents_guard_columns()'::regprocedure), e'\r', '');
  v_anchor text := replace($legacy$    refiling := (old.entity_type = 'inbox'
                 and ((new.entity_type in ('invoice', 'goods_receipt')
                       and new.entity_id is not null)
                      or (new.entity_type = 'archive' and new.entity_id is null)))
                or (old.entity_type = 'archive'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$legacy$, e'\r', '');
  v_replacement text := replace($widened$    refiling := (old.entity_type = 'inbox'
                 and ((new.entity_type in ('invoice', 'goods_receipt')
                       and new.entity_id is not null)
                      or (new.entity_type = 'archive' and new.entity_id is null)))
                or (old.entity_type = 'archive'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null)
                -- invoice -> inbox (0077, task C5). The fifth leg, and the only one whose OLD
                -- side is a business target: when a machine-written invoice is reverted its
                -- document has to leave a target that no longer exists. It carries no entity on
                -- the way back, exactly like the rescue leg above, so it lands where the two
                -- manual שיוך actions work on it. `goods_receipt -> inbox` is deliberately NOT
                -- added: nothing writes a goods_receipt filing automatically, so there is no
                -- machine decision to reverse and no reasoned command that would perform it.
                or (old.entity_type = 'invoice'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$widened$, e'\r', '');
begin
  if position(v_anchor in v_def) = 0 then
    raise exception '0077: documents_guard_columns has moved -- the refiling predicate is not '
      'where 0075 left it. Re-read the live definition before editing.';
  end if;
  execute replace(v_def, v_anchor, v_replacement);
  -- The same anti-revert assertion 0075:107-110 carries, for the same reason: pg_get_functiondef
  -- renders the live security setting, so the replay preserves it -- but asserting it is what
  -- turns "preserved" from an assumption into a fact.
  if not (select prosecdef from pg_proc
          where oid = 'public.documents_guard_columns()'::regprocedure) then
    raise exception '0077: documents_guard_columns lost SECURITY DEFINER in the replay.';
  end if;
end
$c5guard$;

-- The trigger is NOT recreated, for the reason 0075:114-119 states: `create or replace function`
-- preserves the OID, so documents_guard_columns_trg keeps firing the replaced body, and
-- recreating it would silently drop any WHEN clause or UPDATE OF list a later migration adds.

-- ----- 4b. The reason contract, closed at the schema and in the SIBLING command -----
--
-- C5's review measured a reversal completing with a reason of E'\t\n\r', of one RLM, and of one
-- NBSP -- each soft-deleting an invoice and writing an audit row whose only human justification is
-- a character nobody can see. This is the defect class C2 spent four review rounds closing on
-- invoice numbers, reappearing in the command that undoes what C2 guards.
--
-- BOTH SHAPE CONSTRAINTS MOVE, not just this task's. document_filings_reversal_shape is 0075's and
-- carries the identical one-argument btrim, so leaving it would mean the ledger still accepted
-- what the command now refuses. Read from the LIVE catalogue and asserted before replacement --
-- a constraint is re-stated by definition when it is altered, so the anti-revert discipline is to
-- prove the live text is what this block believes before dropping it.
do $c5reason$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.document_filings'::regclass
    and conname = 'document_filings_reversal_shape';
  if v_def is null then
    raise exception '0077: document_filings_reversal_shape is missing (0075 section 4).';
  end if;
  if v_def !~ 'btrim' then
    raise exception '0077: document_filings_reversal_shape no longer carries the one-argument '
      'btrim this block exists to replace -- re-read the live definition before editing. Live: %',
      v_def;
  end if;
end
$c5reason$;

alter table public.document_filings drop constraint document_filings_reversal_shape;
alter table public.document_filings add constraint document_filings_reversal_shape check (
  (reverted_at is null and reverted_reason is null)
  or (reverted_at is not null
      -- The property, and the coalesce that keeps it from passing on NULL. See the long note on
      -- document_auto_actions_reversal_shape for why this is NOT private.document_text_sanitize:
      -- a CHECK runs as the CURRENT user and service_role -- which inserts into THIS table in
      -- p11:1001-1004 -- holds neither USAGE on schema `private` nor EXECUTE on that function.
      and coalesce(reverted_reason, '') ~ '[[:graph:]]'
      and length(coalesce(reverted_reason, '')) <= 1000)
);

-- And rescue_document_from_archive itself, which has the same hole and is the same author's
-- contract. Patched by anchored substitution into the LIVE body -- 0075's file is not edited.
-- It is a definer owned by postgres, so unlike a CHECK constraint it CAN reach the sanitizer.
--
-- THE EMPTINESS TEST AND THE STORED TEXT ARE SEPARATED, and that is the one place this diverges
-- from the review's one-liner. `v_reason := private.document_text_sanitize(p_reason)` would refuse
-- the right things but would also STORE the sanitized string -- and that function collapses every
-- whitespace run to a single space, so a two-line justification a person typed into the reason
-- textarea would be silently flattened onto one line in audit_logs. This is the same storage-vs-
-- comparison split section 1 of this file already makes for invoice numbers: the sanitizer answers
-- "is there anything here at all", `btrim` answers "what did the person actually write".
-- TWO substitutions, because making the siblings agree on WHAT they refuse while leaving them
-- disagreeing on HOW would have been half a fix. Both shape constraints now cap the reason at
-- 1000 characters, so without the second one a 1001-character rescue reason passes the command,
-- soft-deletes nothing, and dies on a raw `document_filings_reversal_shape` -- atomic, but the
-- person is shown a constraint name while the same input on the reversal command comes back as
-- `reason_too_long`, which src/lib/errors.ts translates. Same argument as the reversal's own
-- length fence: ConfirmDialog caps the textarea at 1000, and this is the fence for every other
-- caller.
do $c5rescue$
declare
  v_def text := replace(
    pg_get_functiondef('public.rescue_document_from_archive(uuid,text)'::regprocedure), e'\r', '');
  v_anchor text := replace($old$  v_reason text := nullif(btrim(p_reason), '');$old$, e'\r', '');
  v_new text := replace($new$  v_reason text := case
    when private.document_text_sanitize(p_reason) is null then null
    else btrim(p_reason)
  end;$new$, e'\r', '');
  -- Anchored on the reason guard EXACTLY as 0075:380-382 wrote it, and the length raise is added
  -- AFTER it rather than inside it. That ordering is not cosmetic: p11:988-997's mutation proof
  -- anchors on this same three-line block and deletes it wholesale, so folding a second condition
  -- into it would break a live suite's mutation. Appended, the block p11 looks for is untouched.
  v_guard_anchor text := replace($ga$  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;$ga$, e'\r', '');
  v_guard_new text := replace($gn$  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;$gn$, e'\r', '');
begin
  if position(v_anchor in v_def) = 0 then
    raise exception '0077: rescue_document_from_archive no longer declares v_reason the way '
      '0075:371 left it -- re-read the live definition before editing.';
  end if;
  if position(v_guard_anchor in v_def) = 0 then
    raise exception '0077: rescue_document_from_archive no longer raises reason_required the way '
      '0075:380-382 left it -- re-read the live definition before editing.';
  end if;
  v_def := replace(v_def, v_anchor, v_new);
  v_def := replace(v_def, v_guard_anchor, v_guard_new);
  execute v_def;
  if not (select prosecdef from pg_proc
          where oid = 'public.rescue_document_from_archive(uuid,text)'::regprocedure) then
    raise exception '0077: rescue_document_from_archive lost SECURITY DEFINER in the replay.';
  end if;
end
$c5rescue$;

-- ----- 4c. The command -----
create function public.revert_document_auto_action(
  p_action_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $revert$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  -- THE EMPTINESS TEST IS THE SANITIZER; THE STORED TEXT IS THE PERSON'S OWN. One-argument btrim
  -- -- what this line used to be, and what rescue_document_from_archive was written with -- strips
  -- SPACES ONLY: E'\t\n\r', a single RLM and a single NBSP each walked through it and completed a
  -- full reversal, leaving an audit row whose sole human justification was a character with no
  -- visual form. private.document_text_sanitize is the allowlist-grade answer to "is there
  -- anything here", already in this file for exactly this class of hazard. It is NOT what gets
  -- stored: it collapses whitespace runs, which would flatten a two-line justification typed into
  -- the reason field. Section 1's storage-vs-comparison split, applied to a reason.
  v_reason text := case
    when private.document_text_sanitize(p_reason) is null then null
    else btrim(p_reason)
  end;
  v_action public.document_auto_actions;
  v_document public.documents;
  v_invoice_result jsonb;
  v_filing_id uuid;
  v_exception_id uuid;
  v_returned boolean := false;
begin
  -- Order matters and is the rescue_document_from_archive order (0075:377-382): authority first,
  -- then the reason, then anything that reads a row. A caller with no authority must not be able
  -- to learn whether an action id exists by watching which refusal comes back.
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- BY NAME, on empty, on whitespace, and on anything with no visual form at all -- see the
  -- declaration above for what that used to let through.
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  -- Its own name, not an arm of reason_required. Both shape constraints cap the reason at 1000
  -- characters, so without this a 1001-character justification passes here, passes
  -- soft_delete_invoice, deletes the invoice, and then dies on a raw
  -- `document_filings_reversal_shape` -- atomic, so nothing is half-done, but the person is shown
  -- a constraint name. Folding it into reason_required would answer that person with "יש להזין
  -- סיבה" about a reason they just wrote 1001 characters of, which is a worse sentence than the
  -- constraint name it replaces. ConfirmDialog already caps the textarea at 1000; this is the
  -- fence for every other caller.
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_action
  from document_auto_actions
  where id = p_action_id and org_id = v_org
  for update;

  -- The function owner bypasses table RLS, so this predicate is the IDOR boundary: another
  -- tenant's action id and a non-existent one are indistinguishable to the caller, and neither
  -- is read. Same shape as 0075:389-393.
  if not found then
    raise exception 'auto_action_unknown' using errcode = 'P0002';
  end if;

  -- REVERSAL IS A ONE-WAY DOOR, and this is the named refusal in front of C2's guard rather than
  -- a replacement for it. document_auto_actions_guard_columns already rejects any update whose
  -- `old.reverted_at is not null`, but it raises document_auto_action_immutable -- a schema-level
  -- name for what is, at this door, an ordinary and likely race: two clerks, one list, one of
  -- them a few seconds behind. The row lock above serializes them; this tells the second one what
  -- actually happened. The guard stays underneath as the backstop that holds for every caller,
  -- including one that never passes through this function.
  if v_action.reverted_at is not null then
    raise exception 'auto_action_already_reverted' using errcode = 'P0001';
  end if;

  -- `deleted_at is null` matches rescue_document_from_archive (0075:386) and the consequence is
  -- stated rather than left to be discovered: if a person soft-deletes the DOCUMENT first, this
  -- door closes and the machine's invoice can no longer be undone from the register. It is not
  -- stranded -- the invoice keeps its own reasoned door, soft_delete_invoice from the invoice
  -- screen -- and this route is unreachable from the UI anyway, because a removed document is not
  -- listed. Reverting against a removed document would mean returning it to an inbox nobody can
  -- see, which is a worse state than the one it replaces.
  select * into v_document
  from documents
  where id = v_action.document_id and org_id = v_org and deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  -- (1) THE INVOICE. Soft delete, through the live command -- see the header of this section for
  -- the three things it carries that a hand-rolled `update invoices set deleted_at` would not.
  -- It is idempotent when the invoice is already deleted and it REFUSES, by name, when money has
  -- been allocated against it: a business that has already paid against this record must not be
  -- able to make it disappear from a documents screen. document_auto_actions_applied_shape makes
  -- invoice_id non-null for every auto_applied row, so the guard below is not the normal path --
  -- it is what keeps this command honest if a later outcome is added that writes no invoice.
  if v_action.invoice_id is not null then
    v_invoice_result := public.soft_delete_invoice(v_action.invoice_id, v_reason);
  end if;

  -- (2) THE DOCUMENT, back to the inbox -- the queue a person works from, where the two manual
  -- שיוך actions apply to it. Conditional on it still pointing at THIS invoice: if a later
  -- migration ever gives a human a path to re-file an auto-applied document, reverting must not
  -- yank it out of wherever that person put it. The GUC is the same tripwire rescue sets
  -- (0075:398) -- not the security boundary, which is the column grant, but the fence that keeps
  -- this write on a reasoned path if that grant is ever widened.
  if v_document.entity_type = 'invoice'
     and v_document.entity_id is not distinct from v_action.invoice_id then
    perform set_config('app.document_filing_writer', v_user::text, true);
    update documents
    set entity_type = 'inbox', entity_id = null
    where id = v_document.id;
    v_returned := true;
  end if;

  -- (3) THE FILING. reverted_at + reverted_reason, which is every reversal column the 0075 table
  -- has -- it carries no reverted_by, and one is NOT added here: the actor is recorded on the
  -- auto-action row below and in the audit row, and widening a table 0075 owns (plus its
  -- document_filings_reversal_shape constraint) to duplicate a fact already stored twice would be
  -- a schema change with no reader. Scoped to the filing this ACTION produced, not to "the active
  -- filing of this document": those are the same row today, and if they ever diverge, reverting
  -- someone else's decision is the wrong repair.
  update document_filings
  set reverted_at = now(),
      reverted_reason = v_reason
  where org_id = v_org
    and id = v_action.filing_id
    and reverted_at is null
  returning id into v_filing_id;

  -- (4) THE EXCEPTION 0077 RAISED, if it raised one. OPEN-DECISIONS #112 -- a documented default,
  -- not a silent choice in code. An exception naming a soft-deleted invoice is the false
  -- "requires attention" §12 forbids, and worse than noise: the manager cannot act on it at all,
  -- because the record it names is gone. Meanwhile the reversal repudiates the reading that
  -- produced it.
  --
  -- THE NOTE STATES ITS OWN LIMIT, and that sentence is the decision, not politeness: the
  -- machine's READING was repudiated, the SHIPMENT was not. The discrepancy may be perfectly
  -- real. So the note says the exception was closed BECAUSE the automatic filing was reversed and
  -- explicitly not because anything was investigated, and it carries the action id so a person
  -- can reopen it deliberately. Anything that implied an investigation happened would be the
  -- machine claiming work no one did.
  if v_action.exception_id is not null then
    update exceptions
    set status = 'dismissed',
        resolved_at = now(),
        resolved_by = v_user,
        resolution_note = 'נסגרה מפני שהשיוך האוטומטי של המסמך בוטל — ולא מפני שהפער נבדק. '
          || 'ייתכן שהפער מול ההזמנה אמיתי; כדי לברר אותו יש לפתוח חריגה מחדש. '
          || 'מזהה הפעולה האוטומטית שבוטלה: ' || v_action.id::text || '. סיבת הביטול: ' || v_reason
    where org_id = v_org
      and id = v_action.exception_id
      and status in ('open', 'in_progress')
    returning id into v_exception_id;
  end if;

  -- (5) THE HANDLE ITSELF, closed for good. `org_id = v_org` is redundant against the row lock
  -- above -- which already matched on it -- and is spelled out anyway, so that every write in this
  -- function is visibly tenant-scoped and a reader does not have to reconstruct the argument for
  -- the one that is not.
  update document_auto_actions
  set reverted_at = now(),
      reverted_by = v_user,
      reverted_reason = v_reason
  where id = v_action.id and org_id = v_org;

  -- THE SECOND EVENT. user_id is the PERSON here, and that asymmetry against section 3's null
  -- actor is the whole point: a reader of audit_logs can tell the machine's write from the
  -- human's undo by the one column that could ever distinguish them. old_values carries the
  -- machine's own decision record, so the row explains what was reversed without a join.
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'document_auto_action_reverted',
    'document_auto_actions',
    v_action.id,
    jsonb_build_object(
      'document_id', v_action.document_id,
      'interpretation_id', v_action.interpretation_id,
      'invoice_id', v_action.invoice_id,
      'exception_id', v_action.exception_id,
      'filing_id', v_action.filing_id,
      'order_id', v_action.order_id,
      'entity_type', v_document.entity_type,
      'decision', v_action.decision),
    jsonb_build_object(
      'invoice_deleted', v_invoice_result -> 'status',
      'entity_type', case when v_returned then 'inbox' else v_document.entity_type end,
      'filing_reverted', v_filing_id is not null,
      'exception_dismissed', v_exception_id is not null),
    v_reason
  );

  return jsonb_build_object(
    'auto_action_id', v_action.id,
    'document_id', v_action.document_id,
    'invoice_id', v_action.invoice_id,
    'invoice_deleted', v_invoice_result -> 'status' = to_jsonb('deleted'::text),
    'document_returned_to_inbox', v_returned,
    'filing_id', v_filing_id,
    'filing_reverted', v_filing_id is not null,
    'exception_id', v_exception_id,
    'exception_dismissed', v_exception_id is not null);
end
$revert$;

revoke all on function public.revert_document_auto_action(uuid, text)
  from public, anon, authenticated, service_role;
-- The mirror image of section 3's grant, and deliberately so. The trusted server may WRITE the
-- automatic invoice and may not undo it; a person may UNDO it and may not invoke the writer.
-- Each door is open to exactly the party that has something to say through it.
grant execute on function public.revert_document_auto_action(uuid, text) to authenticated;

comment on function public.revert_document_auto_action(uuid, text) is
  'Undoes one machine-written filing in a single reasoned transaction, for owner/office with a '
  'mandatory reason: soft-deletes the invoice through soft_delete_invoice (so an invoice with '
  'money allocated against it is refused by name), returns the document to the inbox, reverts the '
  'filing, dismisses the exception the decision raised with a note that says it was closed by the '
  'reversal rather than by any investigation, and closes the auto-action row for good. Both audit '
  'rows survive: the creation is history and this is a second event.';

-- ===== 5. Registry (A1) + the A5 exemptions + the re-assert block =====
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

-- The reversal command's own A5 row. Its reason is a DIFFERENT one from the writer's above and
-- is not copied from it: this command does have a user JWT, so auth_scopes() is populated and the
-- trusted-server argument does not apply. What it cannot be is INVOKER -- word for word the
-- reason rescue_document_from_archive states (0075:466-472), and here it is stronger, because an
-- invoker version would need UPDATE on document_auto_actions AND on document_filings AND on
-- invoices.deleted_at granted to authenticated, and a plain PostgREST PATCH could then set
-- reverted_at with no reason at all -- defeating the mandatory-reason contract this command
-- exists to enforce, on the one ledger that records what a machine did with money.
insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.revert_document_auto_action(uuid,text)'::regprocedure::text,
  'rls-preread-single-unit -- cannot be invoker: that would require granting UPDATE on '
    || 'document_auto_actions, document_filings and invoices.deleted_at to authenticated, '
    || 'letting a direct PostgREST PATCH revert a machine-written financial decision with no '
    || 'reason and no soft-delete guard, defeating the mandatory-reason contract. Remediate by '
    || 'filtering documents on auth_scopes() once documents carries a meaningful unit_id; today '
    || 'an inbox document is unit_id NULL by design (0055:112).',
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
