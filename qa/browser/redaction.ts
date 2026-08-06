import type { Locator, Page } from '@playwright/test';

const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|apikey|authorization|cookie|jwt|password|refresh[-_]?token|secret|token)/i;

export function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\b([\w.+-]+)@([\w.-]+\.[A-Za-z]{2,})\b/g, '[REDACTED_EMAIL]')
    .replace(/\bIL\d{21}\b/gi, '[REDACTED_IBAN]')
    .replace(/((?:bank account|מספר חשבון|חשבון בנק|חשבון)\s*[:#-]?\s*)(?:\d[\s-]?){5,}/gi, '$1[REDACTED_ACCOUNT]')
    .replace(/\b0\d{1,2}[-\s]?\d{7}\b/g, '[REDACTED_PHONE]')
    .replace(/\b\d{8,20}\b/g, '[REDACTED_NUMBER]')
    .replace(/((?:api[-_]?key|apikey|authorization|cookie|jwt|password|refresh[-_]?token|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
      else url.searchParams.set(key, redactText(url.searchParams.get(key) ?? ''));
    }
    return redactText(url.toString());
  } catch {
    return redactText(value);
  }
}

export function safeArtifactName(value: string, fallback: string): string {
  const safe = value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return (safe || fallback).slice(0, 100);
}

export function sensitiveScreenshotMasks(page: Page): readonly Locator[] {
  return [
    page.locator([
      'input',
      'textarea',
      'td',
      '[role="cell"]',
      '[role="gridcell"]',
      'dd',
      '.num',
      '[data-sensitive="true"]',
      'canvas',
      'iframe',
      'embed',
      'object',
      'img',
    ].join(', ')),
    page.getByText(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/),
    page.getByText(/\bIL\d{21}\b/i),
    page.getByText(/\b\d{8,20}\b/),
    page.getByText(/(?:מספר חשבון|חשבון בנק|חשבון|bank account|IBAN|אימייל|טלפון)\s*[:#-]?\s*\S+/i),
    page.getByText(/(?:[₪$€]\s*[\d,.]+|[\d,.]+\s*[₪$€])/),
  ];
}
