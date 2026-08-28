/**
 * Package 7 — the pins that keep the consent contract honest.
 *
 * TERMS_VERSION is what a person consents TO (0089 stamps it into audit_logs), so the two
 * legal pages must render, name that version, and actually disclose the processors the
 * system really uses — a privacy policy that stops naming OpenAI while documents still go
 * there would be the expensive kind of drift, and nothing else would notice.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';
import { en } from '../lib/i18n/dictionaries/en';
import { he } from '../lib/i18n/dictionaries/he';
import { PrivacyPolicy, TermsOfService, TERMS_VERSION } from './Legal';

/** The English document, rendered the way an English reader actually meets it. */
const inEnglish = (page: React.ReactNode) => render(
  <LocaleProvider initialLocale="en"><MemoryRouter>{page}</MemoryRouter></LocaleProvider>,
);

describe('שני נוסחים מחייבים — OPEN-DECISIONS #280', () => {
  // The owner chose two binding versions over both cheaper readings. These pins are what stops
  // the expensive half of that decision from being quietly dropped later.

  it('the English reader meets an English document, not a translated shell over Hebrew copy', () => {
    inEnglish(<TermsOfService />);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
    // The clause the product actually lives by, in the other language.
    expect(screen.getByText(/may be wrong/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TERMS_VERSION))).toBeInTheDocument();
  });

  it('the English privacy policy keeps every disclosure the Hebrew one makes', () => {
    inEnglish(<PrivacyPolicy />);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
    for (const processor of ['Supabase', 'OpenAI', 'Cloudflare', 'Resend', 'Sentry']) {
      expect(screen.getAllByText(new RegExp(processor)).length).toBeGreaterThan(0);
    }
    // The three provider-side facts, and the promise that is deliberately NOT made. A document
    // that discloses less in one language than in the other is two different undertakings.
    expect(screen.getByText(/up to 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/third-party contractors/)).toBeInTheDocument();
    expect(screen.getByText(/Israel is not a supported region/)).toBeInTheDocument();
    expect(screen.getByText(/store: false/)).toBeInTheDocument();
    expect(screen.getByText(/does not promise zero retention/)).toBeInTheDocument();
    expect(screen.getByText(/Amendment 13/)).toBeInTheDocument();
  });

  it('neither version claims the other one governs', () => {
    // The sentence a translated consent document usually carries — "the Hebrew version prevails".
    // It is the ordinary practice, and it is the reading the owner did NOT choose. Somebody who
    // signed in English agreed to the English text.
    // Narrow patterns, not the bare words: clause 7 legitimately says “governing law”, and a
    // test that forbade the word would be deleted by the next person rather than obeyed.
    const CLAIMS = [
      /Hebrew[^.]{0,60}(prevail|govern|binding|authoritative)/i,
      /(prevail|governing|binding|authoritative)[^.]{0,60}Hebrew/i,
      /הנוסח העברי[^.]{0,40}(מחייב|גובר|קובע)/,
      /במקרה של סתירה[^.]{0,40}עברי/,
    ];
    const legal = { ...he.legal, ...en.legal };
    for (const [key, value] of Object.entries(legal)) {
      for (const claim of CLAIMS) expect(String(value), `${key} / ${claim}`).not.toMatch(claim);
    }
  });

  it('both documents carry the same clauses, key for key', () => {
    // `apply-ns.mjs` refuses a half-translated namespace and `en.ts` is type-checked against
    // `he.ts`, so this cannot drift silently — but a consent document is worth one explicit
    // count, because the failure mode here is a clause that exists in one language only.
    expect(Object.keys(en.legal).sort()).toEqual(Object.keys(he.legal).sort());
    for (const [key, value] of Object.entries(en.legal)) {
      expect(String(value).trim(), key).not.toBe('');
    }
  });
});

describe('the legal pages and the consented version', () => {
  it('TERMS_VERSION is a dated version string', () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('terms render with the version and the automation honesty clause', () => {
    render(<MemoryRouter><TermsOfService /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'תנאי שימוש' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TERMS_VERSION))).toBeInTheDocument();
    // The clause the product actually lives by: automated interpretation can be wrong and
    // stays reviewable/undoable.
    expect(screen.getByText(/עשויה להיות שגויה/)).toBeInTheDocument();
  });

  it('privacy names the real processors and the data-subject rights', () => {
    render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'מדיניות פרטיות' })).toBeInTheDocument();
    for (const processor of ['Supabase', 'OpenAI', 'Cloudflare', 'Resend', 'Sentry']) {
      // getAllByText rather than getByText: since 2026-08-24 the model provider is named twice on
      // purpose -- once in the sub-processor list and again in the section that says what it does
      // with the content. The contract is that each processor is named, not that it is named once.
      expect(screen.getAllByText(new RegExp(processor)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/תיקון 13/)).toBeInTheDocument();
  });

  it('privacy states what the system asks the provider, never what the provider does', () => {
    // OPEN-DECISIONS #179: zero retention is never promised without a contract that proves it, and
    // `store: false` is an API REQUEST rather than the provider's undertaking — docs/ASSISTANT.md
    // §5.1 says so. The page said flatly that a document is not stored at the provider until
    // 2026-08-24; this pins the deletion so it cannot come back as a plausible-sounding sentence.
    render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
    expect(screen.getByText(/store: false/)).toBeInTheDocument();
    expect(screen.getByText(/אינה מבטיחה אפס-שימור/)).toBeInTheDocument();
    expect(screen.queryByText(/אינו נשמר אצל ספק המודל/)).toBeNull();
  });
  it('privacy discloses the three provider-side facts a reader cannot discover', () => {
    // Deleting a promise we could not keep was half the work (the case above). The other half is
    // saying what actually happens, and these three came from OpenAI's own dated pages, recorded
    // in docs/ASSISTANT-ACTIVATION-EVIDENCE.md §1. Each is pinned because each is the kind of
    // sentence that gets quietly softened later.
    render(<MemoryRouter><PrivacyPolicy /></MemoryRouter>);
    // Retention is a number with a direction, not "the provider's terms apply".
    expect(screen.getByText(/עד 30 יום/)).toBeInTheDocument();
    // Human review is not limited to the provider's own staff.
    expect(screen.getByText(/קבלני צד-שלישי/)).toBeInTheDocument();
    // No regional restriction is configured, and Israel is not even available.
    expect(screen.getByText(/ישראל אינה אזור/)).toBeInTheDocument();
  });
});
