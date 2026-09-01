import { useT } from '../lib/i18n/LocaleProvider';
import { BILLING_EMAIL, SUPPORT_EMAIL, supportMailto } from '../lib/support';

/**
 * Where a customer goes when the product has told them to contact support.
 *
 * DELIBERATELY NOT A CARD OF ITS OWN, and not on every screen. DESIGN.md's north star is a quiet
 * control room; a permanent "How can we help?" panel on nine screens is the generic admin-template
 * furniture the constitution names by name. This is one muted line, mounted where a customer is
 * already looking at something they might need help with.
 *
 * THE TWO ADDRESSES ARE NOT INTERCHANGEABLE. Billing questions — an invoice, a charge, a plan that
 * did not change — go to `billing@`, which is also where the payment provider's own operational
 * mail lands, so the person answering can see both halves of the story. Everything else goes to
 * `support@`. Offering only one address would be simpler and would route every billing question
 * into a queue that cannot see the payment.
 *
 * `variant` picks which pair is worth saying on a given screen; it does not change the addresses.
 */
export function SupportContact({ variant = 'product' }: { variant?: 'product' | 'billing' }) {
  const { t } = useT();
  const showBilling = variant === 'billing';

  return (
    <p className="text-xs text-ink-muted">
      {showBilling ? t('support.billingLead') : t('support.productLead')}{' '}
      {showBilling && (
        <>
          <a className="link" href={supportMailto(BILLING_EMAIL, t('support.billingSubject'))}>
            {BILLING_EMAIL}
          </a>
          {' · '}
        </>
      )}
      <a className="link" href={supportMailto(SUPPORT_EMAIL, t('support.productSubject'))}>
        {SUPPORT_EMAIL}
      </a>
    </p>
  );
}
