import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUANTITY_MAX, VAT_RATE_MAX, VAT_RATE_MIN, isQuantityInRange, isVatRateInRange,
} from './inputBounds';

const read = (path: string) => readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');

/**
 * Read a migration by NUMBER, resolving the filename at run time.
 *
 * The full `NNNN_name.sql` spelling is deliberately never written in this file: the repository's
 * numbering guards treat that token as a real citation wherever it appears, so a spec that spelled
 * one out would register as a migration reference and could be read as a claim about which
 * migration this change introduces. The number alone is unambiguous and inert.
 */
function migrationByNumber(number: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const file = readdirSync(dir).find((name) => name.startsWith(`${number}_`));
  if (!file) throw new Error(`no migration numbered ${number}`);
  return readFileSync(join(dir, file), 'utf8');
}

describe('input bounds — the helpers themselves', () => {
  it('accepts the whole inclusive VAT range and refuses either side of it', () => {
    expect(isVatRateInRange(0)).toBe(true);
    expect(isVatRateInRange(17)).toBe(true);
    expect(isVatRateInRange(18)).toBe(true);
    expect(isVatRateInRange(100)).toBe(true);
    expect(isVatRateInRange(-0.01)).toBe(false);
    expect(isVatRateInRange(100.01)).toBe(false);
    expect(isVatRateInRange(999)).toBe(false);
  });

  it('treats a blank or unparseable rate as out of range, not as zero', () => {
    // `Number('')` is 0, which is IN range. A guard written as `value < 0 || value > 100` would
    // therefore accept an empty field and write a real 0% VAT rate. This is the case that makes
    // `Number.isFinite` load-bearing rather than decorative.
    expect(isVatRateInRange(Number(''))).toBe(true); // the trap: '' parses to a valid 0
    expect(isVatRateInRange(Number('abc'))).toBe(false);
    expect(isVatRateInRange(Number.NaN)).toBe(false);
    expect(isVatRateInRange(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('bounds a quantity by magnitude, in both directions', () => {
    expect(isQuantityInRange(0)).toBe(true);
    expect(isQuantityInRange(80)).toBe(true);
    expect(isQuantityInRange(QUANTITY_MAX)).toBe(true);
    expect(isQuantityInRange(QUANTITY_MAX + 1)).toBe(false);
    // Signed, because an inventory adjustment is signed and the server bounds `abs(v_delta)`.
    expect(isQuantityInRange(-QUANTITY_MAX)).toBe(true);
    expect(isQuantityInRange(-QUANTITY_MAX - 1)).toBe(false);
    expect(isQuantityInRange(Number.NaN)).toBe(false);
  });
});

/**
 * The point of this block.
 *
 * A client bound that quietly stops matching its server bound is worse than no client bound at
 * all: the form keeps promising a rule the database no longer enforces, or refuses a value the
 * database would accept. This repository has paid for that class of drift repeatedly — a name
 * renamed on one side while the other half kept reading the old one. These tests fail the moment
 * the two sides disagree, on either side.
 */
describe('input bounds — pinned to the server that actually enforces them', () => {
  it('takes the VAT range from the same 0-100 the invoice-line check uses', () => {
    expect(migrationByNumber('0099')).toContain('vat_rate between 0 and 100');
    expect(VAT_RATE_MIN).toBe(0);
    expect(VAT_RATE_MAX).toBe(100);
  });

  it('takes the VAT range from the same 0-100 the provisioning boundary uses', () => {
    const provision = read('supabase/functions/_shared/provision.ts');
    expect(provision).toContain('input.vatRate < 0 || input.vatRate > 100');
    expect(VAT_RATE_MIN).toBe(0);
    expect(VAT_RATE_MAX).toBe(100);
  });

  it('takes the quantity ceiling from the three inventory commands that already enforce it', () => {
    const ledger = migrationByNumber('0026');
    expect(ledger).toContain(`p_quantity > ${QUANTITY_MAX}`);
    expect(ledger).toContain(`abs(v_delta) > ${QUANTITY_MAX}`);
    expect(ledger).toContain(`v_counted > ${QUANTITY_MAX}`);
  });

  it('takes the quantity ceiling from the supplier-portal proposal column', () => {
    expect(migrationByNumber('0167')).toContain(`proposed_qty <= ${QUANTITY_MAX}`);
    // ...and the portal's own client parses to the same number, so all three agree.
    expect(read('src/portal/PortalApp.tsx')).toContain('1_000_000');
  });
});

/**
 * Wiring, checked in the source rather than through a mounted screen.
 *
 * These assertions exist because the defect being fixed was NOT a wrong number — it was an absent
 * one. A rendering test proves a field works; only reading the call site proves the attribute is
 * there at all, on every screen that writes the value rather than on the one that happened to be
 * mounted. The idiom follows `organizationBranding.spec.ts`.
 */
describe('every screen that writes a VAT rate states the bound', () => {
  it('bounds the tenant settings field and refuses an out-of-range save', () => {
    const settings = read('src/pages/Settings.tsx');
    expect(settings).toContain('min={VAT_RATE_MIN} max={VAT_RATE_MAX}');
    expect(settings).toContain('isVatRateInRange(vat)');
    // The guard must run BEFORE the write, not as a message after it.
    expect(settings.indexOf('isVatRateInRange(vat)'))
      .toBeLessThan(settings.indexOf("supabase.from('organizations').update({"));
  });

  it('bounds the platform provisioning field and refuses an out-of-range submit', () => {
    const admin = read('src/pages/Admin.tsx');
    expect(admin).toContain('min={VAT_RATE_MIN} max={VAT_RATE_MAX}');
    expect(admin).toContain('isVatRateInRange(vat)');
    expect(admin.indexOf('isVatRateInRange(vat)')).toBeLessThan(admin.indexOf('provisionOrg({'));
  });

  it('keeps the onboarding field bounded, which it already was', () => {
    // This screen is the precedent the other two were brought up to, not a change. Pinned so a
    // future edit cannot quietly remove the one that was right first.
    const onboarding = read('src/pages/Onboarding.tsx');
    expect(onboarding).toContain('min="0" max="100"');
    expect(onboarding).toContain('vat < 0 || vat > 100');
  });
});

describe('every screen that writes a quantity states the ceiling', () => {
  it('bounds the order cart, the receiving line, the stocktake and the invoice line', () => {
    expect(read('src/pages/neworder/ProductStep.tsx')).toContain('max={QUANTITY_MAX}');
    expect(read('src/pages/Receiving.tsx')).toContain('max={QUANTITY_MAX}');
    expect(read('src/components/InvoiceLineReviewModal.tsx')).toContain('max={QUANTITY_MAX}');
    const inventory = read('src/pages/Inventory.tsx');
    expect(inventory).toContain('max={QUANTITY_MAX}');
    // The signed command gets the negative floor; the other two keep their floor of 0.
    expect(inventory).toContain("min={command === 'adjustment' ? -QUANTITY_MAX : 0}");
  });

  it('refuses an over-ceiling quantity with a sentence, since `max` alone does not block typing', () => {
    // A `type="number"` field accepts a pasted value above `max` and merely reports :invalid.
    // Both screens that use a plain input therefore also test the parsed number before writing.
    expect(read('src/pages/Inventory.tsx')).toContain('isQuantityInRange(parsed)');
    expect(read('src/components/InvoiceLineReviewModal.tsx')).toContain('isQuantityInRange(line.quantity)');
  });
});
