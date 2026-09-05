import type { TKey } from '../../lib/i18n/t.ts';

/**
 * The openings each role is offered — six per role since 26.08.2026 (owner: "צריך להוסיף יותר
 * הצעות מבחינת השאלות"). Two was not a menu, it was a pair of samples, and a person who wanted
 * neither of them was left facing an empty box with no idea what this surface can be asked.
 *
 * EVERY ENTRY IS ANSWERABLE BY A TOOL THE ROLE MAY RUN, and that is now a test rather than a
 * promise. `EXAMPLE_ANSWERED_BY` below names the tool for each opening, and
 * `roleSuggestionsAreAnswerable.spec.tsx` reads `requiredRoles` out of the Edge tool sources
 * themselves — so an opening moved into the wrong list, or a tool whose roles narrow later,
 * turns the suite red instead of reaching a person as a refusal.
 *
 * The prose version of this check stood here from 26.08.2026 and it did not hold. It had already
 * caught one case — the accountant used to be offered "כמה כסף ממתין לזיכוי?", which is
 * `get_open_credits`, an owner/office tool — and it missed the opening beside it: "כמה חשבוניות
 * נקלטו ב־7 הימים האחרונים?" is answered only by `get_business_summary`, which is owner/office
 * too (`ASSIST-04`). Clicking an opening SENDS it, so a dead end here is not a menu item a person
 * declined to use; it is a refusal they read as the assistant being broken. Worse on this one: the
 * accountant MAY run `get_purchase_metrics`, which measures purchase by `invoice_date` and not
 * reception by `received_date` (`docs/ASSISTANT.md` §7.3), so the likelier outcome was a confident
 * answer to a different question.
 *
 * The opening went, not the boundary. `requiredRoles` is a role-scope decision that belongs to the
 * tool and to `ENTERPRISE-SECURITY-MODEL.md`; widening one so a panel's own menu works would put
 * the business summary in the hands of a role the model excludes from it, to fix a menu. What the
 * accountant is offered instead is the purchase figure `get_purchase_metrics` really computes, and
 * the sentence names that window rather than the reception window it cannot answer.
 */
/**
 * The example questions, as KEYS rather than sentences — and the reason is not tidiness.
 *
 * Clicking one SENDS it: the example becomes the question the assistant is asked. Since
 * `OPEN-DECISIONS #283` the assistant answers in the reader's language, so an English reader
 * clicking a Hebrew example would be asking in a language they did not choose and reading the
 * answer in one they did. The example has to be in their language before it is sent, not after.
 */
export const ROLE_EXAMPLE_KEYS: Record<'owner' | 'office' | 'accountant', readonly TKey[]> = {
  owner: [
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleBusinessPicture',
    'assistantDialog.exampleCreditsPending',
    'assistantDialog.examplePriceRises',
    'assistantDialog.examplePaymentExposure',
    'assistantDialog.exampleUnmatchedBank',
  ],
  office: [
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleInvoiceBlocked',
    'assistantDialog.exampleOrdersUnconfirmed',
    'assistantDialog.examplePriceRises',
    'assistantDialog.exampleLateSuppliers',
    'assistantDialog.exampleInventoryRisk',
  ],
  accountant: [
    'assistantDialog.exampleUnmatchedBank',
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleInvoiceBlocked',
    'assistantDialog.examplePurchaseSpend',
    'assistantDialog.exampleThreeWayMatch',
    'assistantDialog.exampleWhereApprovals',
  ],
};

/**
 * The tool that answers each opening, by the `name` the registry gives it.
 *
 * This is the mapping the comment above used to state in prose. It is data now because a comment
 * cannot be run: the roles live in `supabase/functions/assistant/tools/`, they change there, and
 * nothing connected the two files. Names are checked against the tool sources, so a rename breaks
 * the suite rather than quietly voiding the check.
 *
 * A question the model would route elsewhere is not merely mislabelled here — it is a wrong
 * answer waiting to happen. Each entry names the tool whose OWN definition matches the sentence,
 * not merely one that could produce a number.
 */
export const EXAMPLE_ANSWERED_BY: Readonly<Record<string, string>> = {
  'assistantDialog.exampleWhatNeedsAttention': 'get_open_alerts',
  'assistantDialog.exampleBusinessPicture': 'get_business_summary',
  'assistantDialog.exampleCreditsPending': 'get_open_credits',
  'assistantDialog.examplePriceRises': 'get_monthly_price_rises',
  'assistantDialog.examplePaymentExposure': 'get_payment_exposure',
  'assistantDialog.exampleUnmatchedBank': 'get_unmatched_bank_transactions',
  'assistantDialog.exampleInvoiceBlocked': 'explain_invoice_block',
  'assistantDialog.exampleOrdersUnconfirmed': 'get_orders_awaiting_confirmation',
  'assistantDialog.exampleLateSuppliers': 'get_supplier_performance',
  'assistantDialog.exampleInventoryRisk': 'get_inventory_risk',
  'assistantDialog.examplePurchaseSpend': 'get_purchase_metrics',
  'assistantDialog.exampleThreeWayMatch': 'compare_order_receipt_invoice',
  'assistantDialog.exampleWhereApprovals': 'get_product_help',
};
