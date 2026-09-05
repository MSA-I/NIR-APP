/**
 * `FIN-06`, second clause — "The warning names an action the reader can take."
 *
 * WHAT THE SWEEP READ. Invoice 7702 carried
 * `נמצאה חשבונית נוספת של אותו ספק עם אותו מספר — יש לתקן את הכפילות לפני אישור` on a card whose
 * own badges said the invoice was already `מאושרת` and `שולמה`. The one step the message named was
 * gated on an event that had already happened, and the second copy was not in the reader's list at
 * all: `soft_delete_invoice` (`0034:120`) admits `owner` and `office` only, so an accountant could
 * not have carried out that step even with both invoices in front of them.
 *
 * TWO FALSIFIABLE PROPERTIES, and neither is a restatement of the sentence written to satisfy it:
 *
 *  1. The action is not conditioned on the approval step. `לפני אישור` / `before approval` is the
 *     exact phrasing the finding caught, in both dictionaries.
 *  2. The message names who resolves it when the reader cannot — anchored on the product's OWN
 *     role vocabulary (`ACTIVE_ROLE_LABEL.owner`), not on a literal chosen here.
 *
 * WHAT THIS SPEC DOES NOT CLAIM. `FIN-06`'s first clause — the `?attention=duplicates` filter
 * listing the invoice the card flags — is NOT closed by this file and cannot be closed from the
 * client. The card's flag comes from `get_invoice_three_way_match` (`0099:1872`, SECURITY
 * DEFINER), whose duplicate `exists(...)` at `0099:1241-1249` runs with the definer's authority
 * and therefore sees every invoice in the tenant. The filter is
 * `invoice_has_duplicate(public.invoices)` (`0139:1230`, SECURITY INVOKER), evaluated under
 * `invoices_select` (`0133:212`), which hides every invoice that is not `approved` from the
 * accountant. A duplicate pair straddling that boundary is visible to one and invisible to the
 * other. Closing it means either disclosing the hidden twin to a role the boundary excludes, or
 * taking a critical warning away from that role — a ruling and a migration, not a client change.
 */
import { describe, expect, it } from 'vitest';
import { translateIn } from '../lib/i18n/LocaleProvider';
import { ACTIVE_ROLE_LABEL } from '../lib/status';

const LOCALES = ['he', 'en'] as const;

/** The step the finding caught: it can already be behind the invoice when the warning is read. */
const APPROVAL_GATED: Record<(typeof LOCALES)[number], RegExp> = {
  he: /לפני\s+אישור/,
  en: /before\s+approval/i,
};

describe('the definite-duplicate warning names a step its reader can actually take', () => {
  for (const locale of LOCALES) {
    it(`${locale}: does not gate the action on an approval that may already have happened`, () => {
      const message = translateIn(locale, 'invoices.reason_definite_duplicate_invoice');
      expect(message).not.toMatch(APPROVAL_GATED[locale]);
    });

    it(`${locale}: says who resolves the duplicate when the second copy is out of the reader's scope`, () => {
      const message = translateIn(locale, 'invoices.reason_definite_duplicate_invoice');
      // The product's own word for the role that can delete an invoice — read from the role
      // label, so a rename of that role fails this test instead of silently passing it.
      const ownerWord = translateIn(locale, `status.${ACTIVE_ROLE_LABEL.owner}` as never)
        .split(/[\s/]+/).filter(Boolean).at(-1)!;
      expect(message.toLowerCase()).toContain(ownerWord.toLowerCase());
    });
  }
});
