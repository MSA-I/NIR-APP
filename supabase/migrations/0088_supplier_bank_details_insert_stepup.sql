-- Package 4 — OPEN-DECISIONS #106, decided 09.08.2026 (owner, option 2): entering bank
-- details while CREATING a supplier is no longer a plain form write. DEBT-REGISTER §11
-- documented the hole: 0061 closed the UPDATE column grant (payment-diversion surface) but
-- deliberately left INSERT open, so a new supplier row with substituted bank details slipped
-- past step-up, reason and audit_logs.
--
-- The fix is one revoke, because the reasoned path ALREADY exists: creation now writes the
-- row without bank_details, and a non-empty value goes through update_supplier_bank_details
-- (0061) — owner/office + fresh-password step-up + mandatory reason + audit — exactly like a
-- change to an existing supplier. QuickCreateSupplier never carried bank_details, so the
-- quick-create door is untouched.
--
-- The 0036 INSERT grant is column-level (0036:61-66), so revoking one column narrows it
-- without touching the rest — same mechanics 0061 used for UPDATE.
revoke insert (bank_details) on table public.suppliers from public, anon, authenticated;

-- Re-assert the 0057 scope-enforcement invariants (DEBT-REGISTER §9: the block is remembered,
-- not structural — so every migration carries it explicitly).
do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0088 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
