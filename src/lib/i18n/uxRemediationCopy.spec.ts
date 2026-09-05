import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from './dictionaries/en';
import { he } from './dictionaries/he';

const priceListsSource = readFileSync('src/pages/PriceLists.tsx', 'utf8');
const priceListReviewSource = readFileSync(
  'src/components/document-review/PriceListReviewConfirmation.tsx',
  'utf8',
);

describe('P10 — user-facing copy', () => {
  it('removes the literal rung translation and pipeline vocabulary from the visible failure banner', () => {
    expect(he.reconciliation.classExtraction).not.toMatch(/רגה|רגות/);
    expect(he.documents.text_30).not.toMatch(/חילוץ|פענוח|OCR|תור|pipeline/i);
    expect(en.documents.text_30).not.toMatch(/extraction|interpretation|OCR|queue|pipeline/i);
  });

  it('describes rechecks and upload failures without server or storage-protocol vocabulary', () => {
    for (const value of [
      he.impact.serverChecksAgain,
      he.docReview.text_19,
      he.docRemoval.text_10,
      he.errors.tus_upload_forbidden,
      he.priceUpload.reservationMalformed,
      he.priceUpload.reservationPathMismatch,
      he.priceUpload.registrationUnconfirmed,
      he.priceUpload.registrationIncomplete,
    ]) {
      expect(value).not.toMatch(/השרת|הקצאת העלאה|נתיב ההעלאה|רישום המסמך/);
    }
    for (const value of [
      en.impact.serverChecksAgain,
      en.docReview.text_19,
      en.docRemoval.text_10,
      en.errors.tus_upload_forbidden,
      en.priceUpload.reservationMalformed,
      en.priceUpload.reservationPathMismatch,
      en.priceUpload.registrationUnconfirmed,
      en.priceUpload.registrationIncomplete,
    ]) {
      expect(value).not.toMatch(/\bserver\b|upload allocation|upload path|document registration/i);
    }
  });

  it('replaces the final document-registration error with a visible support path', () => {
    expect(he.errors.document_registration_failed).not.toMatch(/רישום המסמך/);
    expect(en.errors.document_registration_failed).not.toMatch(/document registration|recording the document/i);
    expect(he.errors.document_registration_failed).toMatch(/פנה/);
    expect(en.errors.document_registration_failed).toMatch(/contact/i);
  });

  it('describes an unfinished price-list upload without registration vocabulary', () => {
    expect(he.priceUpload.text_5).not.toMatch(/רישום המסמך/);
    expect(en.priceUpload.text_5).not.toMatch(/document registration|recording the document/i);
    expect(he.priceUpload.text_5).toContain('ניסיון נוסף');
    expect(en.priceUpload.text_5).toMatch(/try again/i);
    expect(he.priceUpload.retryRegistration).toBe('ניסיון נוסף');
    expect(en.priceUpload.retryRegistration).toBe('Try again');
  });

  it('calls monthly price-list receipts upload results', () => {
    expect(he.priceLists.text_13).not.toMatch(/קבלות? הגשה/);
    expect(en.priceLists.text_13).not.toMatch(/submission receipts?/i);
    expect(he.priceLists.text_13).toContain('תוצאות');
    expect(en.priceLists.text_13).toMatch(/results/i);
  });

  it('uses a human price-list result vocabulary and renders a localized month name', () => {
    for (const value of [
      he.priceListReview.setRecoveryError,
      he.priceListReview.setRefreshWarning,
      he.priceListReview.text,
      he.priceListReview.text_26,
      he.priceListReview.setRecoveryRevision,
      he.priceListReview.text_29,
      he.priceListReview.text_61,
      he.priceListReview.receiptMalformed,
      he.priceListReview.receiptRecoveryFailed,
      he.priceListReview.receiptUnverified,
    ]) {
      expect(value).not.toMatch(/קבלת הגשה|פירוש|קבלה תואמת|שחזור קבלה/);
    }
    for (const value of [
      en.priceListReview.setRecoveryError,
      en.priceListReview.setRefreshWarning,
      en.priceListReview.text,
      en.priceListReview.text_26,
      en.priceListReview.setRecoveryRevision,
      en.priceListReview.text_29,
      en.priceListReview.text_61,
      en.priceListReview.receiptMalformed,
      en.priceListReview.receiptRecoveryFailed,
      en.priceListReview.receiptUnverified,
    ]) {
      expect(value).not.toMatch(/submission receipt|current interpretation|matching receipt|recover the receipt/i);
    }
    expect(priceListReviewSource).not.toContain('targetMonth.slice(0, 7)');
    expect(priceListReviewSource).toContain('fmtMonth(attemptedPayload.targetMonth, locale)');
    expect(priceListReviewSource).not.toContain('>שורות שהתקבלו: </dt>');
  });

  it('gives every interpretation failure a concrete next action in both languages', () => {
    const heMessages = Object.entries(he.documentReviewPage)
      .filter(([key]) => /^interpret/.test(key))
      .map(([, value]) => value);
    const enMessages = Object.entries(en.documentReviewPage)
      .filter(([key]) => /^interpret/.test(key))
      .map(([, value]) => value);
    expect(heMessages).toHaveLength(19);
    expect(enMessages).toHaveLength(19);
    for (const value of heMessages) {
      expect(value).toMatch(/נסה|התחבר|פנה|המתן|רענן|חזור|שלח|פצל|פתח/);
    }
    for (const value of enMessages) {
      expect(value).toMatch(/try|sign in|contact|wait|refresh|return|send|split|open/i);
    }
  });

  it('speaks to the user, not about the product backlog, and keeps the upload intro short', () => {
    expect(he.answerView.noAnswerUndefinedBusinessRule).not.toContain('המוצר טרם הגדיר');
    expect(en.answerView.noAnswerUndefinedBusinessRule).not.toMatch(/product has not yet defined/i);
    const heIntro = `${he.documents.text_18} ${he.documents.text_19}`;
    const enIntro = `${en.documents.text_18} ${en.documents.text_19}`;
    expect(heIntro.trim().split(/\s+/).length).toBeLessThanOrEqual(18);
    expect(enIntro.trim().split(/\s+/).length).toBeLessThanOrEqual(24);
  });

  it('moves the targeted PriceLists labels into the bilingual dictionary', () => {
    for (const literal of [
      'ייבוא רב־ספקים מ־Excel',
      'העלאת מחירון',
      'המוצר מצוטט ביותר ממטבע אחד',
      'מחיר חדש (',
      'בתוקף מתאריך',
      'זמין אצל הספק',
      'סיבת העדכון (רשות)',
    ]) {
      expect(priceListsSource).not.toContain(literal);
    }
    for (const key of [
      'importMultiSupplier', 'uploadPriceList', 'multiCurrencyComparison', 'newPriceLabel',
      'effectiveDate', 'supplierAvailable', 'updateReason',
    ] as const) {
      expect(he.priceListsTail[key]).toBeTruthy();
      expect(en.priceListsTail[key]).toBeTruthy();
    }
  });

  it('keeps automatic-assignment supervision without showing a raw confidence percentage', () => {
    expect(he.documentStatus.autoAssignedByMachine).not.toMatch(/\{confidence\}|%/);
    expect(en.documentStatus.autoAssignedByMachine).not.toMatch(/\{confidence\}|%/);
    expect(he.documentsInboxTail.revertMessage).not.toMatch(/\{confidence\}|%/);
    expect(en.documentsInboxTail.revertMessage).not.toMatch(/\{confidence\}|%/);
    expect(he.documentStatus.autoAssignedByMachine).toContain('ללא אישור אדם');
    expect(en.documentStatus.autoAssignedByMachine).toContain('without human approval');
  });
});
