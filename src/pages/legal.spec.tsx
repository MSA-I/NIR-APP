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
import { PrivacyPolicy, TermsOfService, TERMS_VERSION } from './Legal';

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
      expect(screen.getByText(new RegExp(processor))).toBeInTheDocument();
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
});
