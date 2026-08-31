/**
 * The commercial catalogue in the reader's language (OPEN-DECISIONS #303, owner 31.08.2026).
 *
 * The behaviour under test is a PAIR, and testing either half alone would miss the point:
 *   - English reads English, which is the change; and
 *   - Hebrew reads exactly what the database says, which is what makes the change safe to ship.
 *
 * The second half is guarded twice on purpose. Here it is checked against the strings a screen
 * actually renders; in `npm run check:plan-labels` it is checked against the migrations that seed
 * them. A test alone would keep agreeing with a dictionary that had drifted from the database.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from './i18n/LocaleProvider';
import { usePlanCatalogue } from './planLabels';
import type { Locale } from './i18n/locale';

function Probe({ planKey, entitlementKey, serverLabel }: {
  planKey?: string;
  entitlementKey?: string;
  serverLabel: string;
}) {
  const { planName, quotaName, featureName } = usePlanCatalogue();
  return (
    <ul>
      <li data-testid="plan">{planName(planKey, serverLabel)}</li>
      <li data-testid="quota">{quotaName(entitlementKey, serverLabel)}</li>
      <li data-testid="feature">{featureName(entitlementKey, serverLabel)}</li>
    </ul>
  );
}

const renderIn = (locale: Locale, props: Parameters<typeof Probe>[0]) => render(
  <LocaleProvider initialLocale={locale}><Probe {...props} /></LocaleProvider>,
);

describe('the plan catalogue in the reader\'s language', () => {
  it('names the rung in English, which is the whole change', () => {
    renderIn('en', { planKey: 'premium', serverLabel: 'פרימיום' });
    expect(screen.getByTestId('plan')).toHaveTextContent('Premium');
  });

  it('leaves Hebrew reading exactly what the server sent, which is what makes it safe', () => {
    renderIn('he', { planKey: 'premium', serverLabel: 'פרימיום' });
    expect(screen.getByTestId('plan')).toHaveTextContent('פרימיום');
  });

  /**
   * The same `entitlement_key` carries two different labels — the quota's name and the plan card's
   * sales wording — because the database keeps two columns. One map for both would publish the
   * wrong one of the pair on one of the two screens.
   */
  it('keeps the quota name and the card wording apart for one entitlement key', () => {
    renderIn('en', { entitlementKey: 'org.multi_unit', serverLabel: 'ריבוי יחידות' });
    expect(screen.getByTestId('quota')).toHaveTextContent('Multiple units');
    expect(screen.getByTestId('feature')).toHaveTextContent('Up to 10 branches');
  });

  /**
   * The cost `#303` named for taking this route — "a new plan needs code, not just a row" — paid
   * rather than denied. A rung seeded by a future migration renders the label the SERVER sent,
   * in whatever language it was written, instead of vanishing or printing its own key.
   */
  it('falls back to the server label for a key nothing maps yet', () => {
    renderIn('en', { planKey: 'enterprise', entitlementKey: 'seats.max', serverLabel: 'ארגוני' });
    expect(screen.getByTestId('plan')).toHaveTextContent('ארגוני');
    expect(screen.getByTestId('quota')).toHaveTextContent('ארגוני');
  });

  it('renders nothing rather than a raw key when the server sent no label either', () => {
    renderIn('en', { planKey: 'enterprise', serverLabel: '' });
    expect(screen.getByTestId('plan')).toBeEmptyDOMElement();
  });

  /**
   * 0251 renamed this quota away from the word OCR — an owner decision about what customers are
   * told a quota is called — so neither language may reintroduce it. The English side is the easy
   * one to get wrong: translating the ORIGINAL seed would have walked the decision back on one
   * screen only, and it did, until `check:plan-labels` learned to read renames.
   */
  it('does not say OCR to a customer, in either language', () => {
    const { unmount } = renderIn('en', { entitlementKey: 'ocr_pages.monthly', serverLabel: 'x' });
    expect(screen.getByTestId('quota')).toHaveTextContent('Scan pages per month');
    unmount();

    renderIn('he', { entitlementKey: 'ocr_pages.monthly', serverLabel: 'x' });
    expect(screen.getByTestId('quota')).toHaveTextContent('עמודי סריקה בחודש');
  });
});
