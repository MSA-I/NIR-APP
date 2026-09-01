import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SupportContact } from './SupportContact';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import { BILLING_EMAIL, SECURITY_EMAIL, SUPPORT_EMAIL, supportMailto } from '../lib/support';

const renderIn = (node: React.ReactNode) => render(<LocaleProvider>{node}</LocaleProvider>);

describe('SupportContact', () => {
  it('gives the product variant one address, and it is support', () => {
    renderIn(<SupportContact />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining(`mailto:${SUPPORT_EMAIL}`));
  });

  it('gives the billing variant the billing address as well as support', () => {
    renderIn(<SupportContact variant="billing" />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.startsWith(`mailto:${BILLING_EMAIL}`))).toBe(true);
    expect(hrefs.some((h) => h.startsWith(`mailto:${SUPPORT_EMAIL}`))).toBe(true);
  });

  it('never offers a sending identity as a place to write to', () => {
    // no-reply@ and orders@ are Resend senders that nobody reads. Offering one to a customer is
    // worse than offering nothing, so the rule is asserted rather than remembered.
    renderIn(<SupportContact variant="billing" />);
    const html = document.body.innerHTML;
    expect(html).not.toContain('no-reply@');
    expect(html).not.toContain('orders@');
  });
});

describe('supportMailto', () => {
  it('returns a bare mailto when there is no subject', () => {
    expect(supportMailto(SUPPORT_EMAIL)).toBe(`mailto:${SUPPORT_EMAIL}`);
  });

  it('encodes the subject, so a newline cannot append a second header', () => {
    const href = supportMailto(SUPPORT_EMAIL, 'Hi\n&bcc=attacker@evil.example');
    expect(href).not.toContain('\n');
    expect(href).not.toContain('&bcc=');
    expect(href).toContain('%0A');
  });

  it('keeps the three human addresses on the InPlace domain and distinct', () => {
    const all = [SUPPORT_EMAIL, BILLING_EMAIL, SECURITY_EMAIL];
    expect(new Set(all).size).toBe(3);
    for (const address of all) expect(address.endsWith('@inplace.digital')).toBe(true);
  });
});
