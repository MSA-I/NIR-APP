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
});
