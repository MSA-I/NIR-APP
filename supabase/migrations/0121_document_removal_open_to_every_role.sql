-- 0121 -- Anyone who can see a document may take it out of the gallery. Undoing what it created is
-- still a financial act.
--
-- The owner's instruction on 11.08.2026 was "כולם יכולים למחוק מסמכים שהועלו" -- everyone can delete
-- uploaded documents. 0116 and 0119 shipped with owner/office only, and that is the wrong default
-- for the act they gate: the person who photographs the wrong page, or photographs the same delivery
-- note twice, is the kitchen manager standing at the truck. Making them find someone with a
-- different login to undo their own mis-file is how a gallery fills with rubbish nobody removes.
--
-- WHO "EVERYONE" IS, measured rather than assumed. `documents_select` (live) admits owner, office
-- and kitchen outright, accountant to approved-invoice/receipt/payment documents, and payer to their
-- own uploads. The `supplier` role reaches documents through one separate policy only --
-- `supplier_price_documents_select`, their own price lists -- because a supplier is an EXTERNAL
-- party in someone else's tenant. So this migration opens removal to owner, office, kitchen and
-- accountant, which is every internal role that can see a document at all. It does NOT open it to
-- `supplier`: an outside vendor removing records from the buyer's gallery is not what "everyone"
-- meant, and it is not a decision to take silently inside a role list. `payer` stays out for the
-- separate reason 0111 records -- the role is leaving the product.
--
-- WHAT DOES NOT OPEN, and why this is not a hedge. `document_and_derived` does not remove a
-- document; it SOFT DELETES AN INVOICE, deletes a draft receipt with its lines, and clears a
-- payment pointer. Those are writes to the financial record, and the whole system is built on
-- kitchen and accountant not holding them: kitchen has had no write on invoices since 0022, and
-- accountant's writes are the payment commands 0031 grants by name. Handing either of them an
-- invoice soft delete through a document screen would be a role boundary crossed sideways, which is
-- exactly the shape of the mistakes the p31/p9 suites exist to catch. The document itself is always
-- removable, by everyone, and that is the part the owner's sentence is about.
--
-- The preview says so instead of the button failing. A role that cannot reverse gets
-- `can_remove_derived = false` and a blocker in its own words, because "cannot be deleted" with no
-- reason is how a person concludes the software is broken -- the sentence 0116's own header uses.

-- ===== 1. The preview =====
-- Whole-body replacement rather than an anchored one: it is sixteen lines, and restating them is a
-- more honest diff than a string surgery a reader has to reassemble.
create or replace function public.get_document_removal_impact(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_impact jsonb;
begin
  if auth.uid() is null or v_org is null
     or v_role not in ('owner', 'office', 'kitchen', 'accountant') then
    raise exception 'document_removal_not_authorized' using errcode = '42501';
  end if;
  -- Scope, for the reason 0109 records: inside a definer body the scope riders do not run.
  if not exists (
    select 1 from public.documents d
    where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
      and (d.unit_id is null or d.unit_id = any(public.auth_scopes()))
  ) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;
  v_impact := private.document_removal_impact(v_org, p_document_id);

  -- The role blocker, added here rather than inside the private function, which stays a statement
  -- about the DOCUMENT's state and knows nothing about who is asking. It is appended to the same
  -- list the state blockers use, so the screen renders it with them and a person reads one reason
  -- list rather than a reason list plus a disabled control with no explanation.
  if v_role not in ('owner', 'office') then
    v_impact := jsonb_set(
      jsonb_set(v_impact, '{can_remove_derived}', 'false'::jsonb),
      '{blockers}',
      coalesce(v_impact -> 'blockers', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'kind', 'role_may_not_reverse',
        'description', 'ביטול הרשומות שנוצרו מהמסמך שמור לבעלים ולמנהל הרכש. '
                       || 'הסרת המסמך עצמו זמינה לך.')));
  end if;
  return v_impact;
end
$$;

comment on function public.get_document_removal_impact(uuid) is
  'The impact preview a person reads before removing a document (0116, opened by 0121). Every '
  'internal role that can see a document -- owner, office, kitchen, accountant -- may read it and '
  'may remove the document itself. For the two roles that may not reverse what it created, the '
  'preview returns can_remove_derived=false with a blocker saying so in Hebrew, rather than leaving '
  'a control that fails when pressed. Scoped to the actor''s units, read-only.';

-- ===== 2. The command =====
-- Anchored replacement, the 0061 pattern: the body is two hundred lines of financial reversal and
-- the change is two conditions. Restating the whole thing here would put a second copy of that
-- logic in the repository, and the next person to change one would not find the other.
do $$
declare
  v_def text;
  v_new text;
  v_gate_old constant text :=
    E'  if v_actor is null or v_org is null or v_role not in (''owner'', ''office'') then';
  v_gate_new constant text :=
    E'  if v_actor is null or v_org is null\n'
    '     or v_role not in (''owner'', ''office'', ''kitchen'', ''accountant'') then';
  v_mode_old constant text :=
    E'  if v_mode not in (''document_only'', ''document_and_derived'') then\n'
    '    raise exception ''document_removal_mode_invalid'' using errcode = ''22023'';\n'
    '  end if;';
  v_mode_new constant text :=
    E'  if v_mode not in (''document_only'', ''document_and_derived'') then\n'
    '    raise exception ''document_removal_mode_invalid'' using errcode = ''22023'';\n'
    '  end if;\n'
    '  -- 0121: removing the document is everyone''s; undoing an approved invoice is not. This is a\n'
    '  -- write to the financial record wearing a document screen''s clothes, and kitchen and\n'
    '  -- accountant hold no such write anywhere else in the system.\n'
    '  if v_mode = ''document_and_derived'' and v_role not in (''owner'', ''office'') then\n'
    '    raise exception ''document_removal_derived_not_authorized'' using errcode = ''42501'';\n'
    '  end if;';
begin
  select pg_get_functiondef(to_regprocedure('public.remove_document(uuid,text,text)')) into v_def;
  if v_def is null then
    raise exception '0121: public.remove_document is gone; there is nothing to open.';
  end if;

  -- Idempotent by construction, for the reason 0117 learned the hard way: a migration that mutates
  -- and then fails on something later leaves the mutation applied, and re-running it must not
  -- double-apply. Both anchors are checked against the ALREADY-OPEN text first.
  if position(v_gate_new in v_def) > 0 and position(v_mode_new in v_def) > 0 then
    return;
  end if;

  if position(v_gate_old in v_def) = 0 then
    raise exception
      '0121: the role gate in remove_document is not the text 0119 wrote. Refusing to guess at a '
      'replacement inside a financial command.';
  end if;
  if position(v_mode_old in v_def) = 0 then
    raise exception '0121: the mode validation in remove_document is not the text 0119 wrote.';
  end if;

  v_new := replace(v_def, v_gate_old, v_gate_new);
  v_new := replace(v_new, v_mode_old, v_mode_new);
  execute v_new;
end
$$;

comment on function public.remove_document(uuid, text, text) is
  'Removes a document, and optionally undoes what it created (0119, opened by 0121). '
  '`document_only` is available to every internal role that can see the document -- owner, office, '
  'kitchen, accountant -- because mis-filing a document is done by whoever photographed it. '
  '`document_and_derived` stays owner/office: it soft deletes an invoice, deletes a draft receipt '
  'with its lines and clears a payment pointer, which are writes to the financial record that '
  'kitchen and accountant hold nowhere else. RECOMPUTES 0116''s blocker list inside the row lock '
  'rather than trusting the preview a person read. The stored file and the immutable evidence '
  'survive both modes.';

-- ===== 3. The A5 enforcement rows follow the bodies =====
-- Both hashes move because both bodies changed. The CR strip is not decoration: prosrc arrives with
-- CRLF from a Windows psql and LF from a Linux runner, and a hash of the raw text disagrees with
-- itself across the two machines that run this repository's gate.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values
  ('get_document_removal_impact(uuid)',
   '0116 refuses any document failing auth_org plus the canonical null-or-auth_scopes unit '
   'predicate before computing a single effect; 0121 widened the reader role list and narrows the '
   'reversal offer by role without widening what is read.'),
  ('remove_document(uuid,text,text)',
   '0119 locks the document by auth_org, role and the canonical null-or-auth_scopes unit predicate '
   'before computing a single effect, and every derived write is filtered on the same org; 0121 '
   'widens the role list for document_only only, and gates document_and_derived separately.')
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 4. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0121 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 5. Anchors =====
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(to_regprocedure('public.remove_document(uuid,text,text)')) into v_def;

  -- (a) The two gates are BOTH present. One without the other is the failure this migration is one
  -- careless edit away from: the wide gate alone would hand kitchen an invoice soft delete.
  if position('''kitchen'', ''accountant''' in v_def) = 0 then
    raise exception '0121: remove_document did not open to kitchen and accountant.';
  end if;
  if position('document_removal_derived_not_authorized' in v_def) = 0 then
    raise exception
      '0121: THE DERIVED REVERSAL IS NOT GATED BY ROLE. A kitchen manager can now soft delete an '
      'approved invoice from the document gallery.';
  end if;

  -- (b) The step the widened gate must not have loosened: the unit scope. A role list is not a
  -- tenancy control, and 0119''s own comment records that inside a definer body the scope riders do
  -- not run -- so this predicate is the only thing standing between a manager of one branch and
  -- another branch''s documents.
  if position('auth_scopes()' in v_def) = 0 then
    raise exception '0121: remove_document no longer filters by the actor''s unit scopes.';
  end if;

  -- (c) The preview and the command agree about who may reverse. Two role lists that drift apart
  -- give a person a button the server refuses, which is the exact experience 0116''s header calls
  -- "how a person concludes the software is broken".
  select pg_get_functiondef(to_regprocedure('public.get_document_removal_impact(uuid)'))
    into v_def;
  if position('can_remove_derived' in v_def) = 0
     or position('''owner'', ''office''' in v_def) = 0 then
    raise exception
      '0121: the preview no longer reports can_remove_derived by role, so a role that cannot '
      'reverse would be offered the option anyway.';
  end if;
end
$$;
