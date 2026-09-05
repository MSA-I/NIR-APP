/**
 * OWN-12 — one VAT rate, in one place, and it is the one the product already decided on.
 *
 * What the sweep measured is a THREE-way disagreement: `/settings` showed 17.5, the product's
 * fallback for an organisation without a rate was 18, and the supplier documents this tenant
 * receives print 18.00%. Two of the three already agree, and they agree on purpose —
 * `docs/OPEN-DECISIONS.md` records the implemented default under **שיעור מע״מ** (18%, current for
 * Israel 2026, stored per invoice so a later change cannot rewrite history), and the
 * `organizations.vat_rate` column has carried `default 18.00` since the first migration. The odd
 * one out is a value stored on one tenant's row, which no code change can correct and which the
 * owner alters at the door that decision record names.
 *
 * So what is fixable here is the half that is genuinely code, and it is real: the number 18 was
 * written out FIVE times across four screens, each an independent copy of a decision recorded
 * once. That is how the three-way comparison became possible to make in the first place, and it
 * is what "one rate" means on this side of the boundary. This file pins it to the server value it
 * mirrors, the way `inputBounds.spec.ts` pins every bound to the check that enforces it.
 *
 * NOT ASSERTED HERE, deliberately: that any particular tenant's stored rate is 18. It is data,
 * it is the owner's, and a test that demanded it would be this repository writing a business
 * answer into a guard.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');

/* Imported inside each test, through a specifier the bundler cannot follow, so that the absence
   of the single source is reported as the failure of the claim that needs it — and the
   copy-counting claim below still runs and names the copies, instead of the whole file dying at
   resolution time and reporting nothing about the defect. */
const RATE_MODULE = './vatRate.ts';
const rateModule = (): Promise<{
  VAT_RATE_DEFAULT: number;
  organizationVatRate: (rate: number | null | undefined) => number;
}> => import(/* @vite-ignore */ RATE_MODULE);

/** By number, never by filename: the numbering guards read `NNNN_name.sql` as a real citation. */
function migrationByNumber(number: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const file = readdirSync(dir).find((name) => name.startsWith(`${number}_`));
  if (!file) throw new Error(`no migration numbered ${number}`);
  return readFileSync(join(dir, file), 'utf8');
}

/** Every screen that has to answer "what rate does this organisation use?". */
const RATE_READERS = [
  'src/pages/Settings.tsx',
  'src/pages/Onboarding.tsx',
  'src/pages/Admin.tsx',
  'src/pages/InvoiceNew.tsx',
];

describe('OWN-12 — the organisation VAT rate has one source on the client', () => {
  it('takes its default from the same 18.00 the organizations column already defaults to', async () => {
    const { VAT_RATE_DEFAULT } = await rateModule();
    expect(migrationByNumber('0001')).toContain('vat_rate numeric(5,2) not null default 18.00');
    expect(VAT_RATE_DEFAULT).toBe(18);
  });

  it('never overrides a rate the organisation does carry, including a zero one', async () => {
    const { VAT_RATE_DEFAULT, organizationVatRate } = await rateModule();
    expect(organizationVatRate(undefined)).toBe(VAT_RATE_DEFAULT);
    expect(organizationVatRate(null)).toBe(VAT_RATE_DEFAULT);
    // The rate this tenant is actually configured with. The resolver reports it, it does not
    // correct it: correcting a tenant's stored rate is an owner action, not a fallback.
    expect(organizationVatRate(17.5)).toBe(17.5);
    // `??` and not `||`, and this is the assertion that keeps it that way: a zero-rated
    // organisation written with `||` silently becomes an 18% one.
    expect(organizationVatRate(0)).toBe(0);
  });

  it('leaves no screen holding a second copy of the number', () => {
    for (const file of RATE_READERS) {
      const source = read(file);
      expect(source).toContain("from '../lib/vatRate'");
      // The five copies the sweep could compare against each other: `?? '18'`, `?? 18`,
      // `vatRate: '18'`. Any line that mentions VAT and spells the number out is one of them.
      expect(source).not.toMatch(/vat[^\n]*\b18\b/i);
    }
  });
});
