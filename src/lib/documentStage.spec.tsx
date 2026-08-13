// Task D1 — שבעת שלבי העיבוד נשארים בדיוק כפי שהם במסד, ב-`data-stage` ובסוויטות; מה שמשתנה הוא
// מה שאדם קורא. הבעלים: "כשאני מעלה מסמך אנחנו לא אמורים לראות את כל הprocess של ה-OCR עם אחוזי
// תאימות וכו. המשתמשים הם לא מתכנתים והנתונים הללו רק מבלבלים עוד יותר."
//
// לכן הקובץ הזה בודק שני חוזים נפרדים ששוברים אחד את השני בקלות:
//   1. המיפוי — שבעה שלבים → ארבעה מצבים אנושיים, בלי שאף שלב ייפול בין הכיסאות.
//   2. התג — `data-testid` ו-`data-document-id` לא זזו, ו-`data-stage` נושא את השלב הגולמי, כך
//      ש-`check-browser-smoke.cjs` ממשיך למדוד מצב אמיתי בזמן שהמשתמש רואה עברית.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ProcessingBadge הוא span טהור, אבל הוא יושב בקובץ שמייבא את הלקוח האמיתי בזמן טעינת המודול.
// הבדיקה לא נוגעת ברשת, ולכן הלקוח מוחלף בכזה שמתפוצץ אם מישהו ינסה בכל זאת.
vi.mock('./supabase', () => ({
  supabase: new Proxy({}, { get() { throw new Error('documentStage.spec: no network here'); } }),
}));

import {
  DOCUMENT_PROCESSING_STAGE_META,
  type DocumentProcessingStage,
} from './useDocumentProcessing';
import {
  DOCUMENT_STATUS_FILTERS,
  documentMatchesStatusFilter,
  documentStatusFilterFromParam,
  documentUiStatus,
} from './documentStatus';
import { ProcessingBadge, ProcessingFilterSelect } from '../pages/DocumentsInbox';

const STAGES = Object.keys(DOCUMENT_PROCESSING_STAGE_META) as DocumentProcessingStage[];

const unfiled = { entity_type: 'inbox', entity_id: null };
const onInvoice = { entity_type: 'invoice', entity_id: '00000000-0000-4000-8000-000000000001' };

describe('שבעת השלבים שורדים מתחת לתצוגה', () => {
  // אם מישהו "יפשט" את החוזה הפנימי בעקבות המסך, נופלות איתו 29 תרחישי דפדפן, סוויטות SQL
  // ופונקציות מסד. הטענה הזו קיימת כדי שהניסיון ייכשל כאן קודם.
  it('טבלת השלבים הפנימית נשארת בת שבעה שלבים עם התוויות ההנדסיות שלה', () => {
    expect(STAGES).toEqual(['unprocessed', 'queued', 'processing', 'extracted', 'review', 'completed', 'failed']);
    expect(DOCUMENT_PROCESSING_STAGE_META.extracted.label).toBe('ממתין לפירוש');
    expect(DOCUMENT_PROCESSING_STAGE_META.completed.label).toBe('הושלם');
  });
});

describe('הסינון והתג מבוססים על אותו מצב קנוני', () => {
  it('מציג אפשרויות שאינן מאחדות מצבים סותרים', () => {
    expect(DOCUMENT_STATUS_FILTERS.map(({ value }) => value)).toEqual([
      'stuck', 'failed', 'processing', 'review', 'unassigned', 'assigned',
    ]);
    render(<ProcessingFilterSelect value="all" onChange={() => {}} />);
    const options = [...screen.getByTestId('documents-processing-filter').querySelectorAll('option')];
    expect(options.map((option) => option.textContent)).toEqual([
      'הכול', 'עיבוד תקוע', 'העיבוד נכשל', 'בעיבוד או בהמתנה', 'נדרשת בדיקה', 'לא משויך', 'משויך',
    ]);
  });

  it('מקבל רק כתובות קנוניות ואינו מנחש משמעות לשלב ישן', () => {
    expect(documentStatusFilterFromParam('queued')).toBeNull();
    expect(documentStatusFilterFromParam('extracted')).toBeNull();
    expect(documentStatusFilterFromParam('unprocessed')).toBeNull();
    expect(documentStatusFilterFromParam('review')).toBe('review');
    expect(documentStatusFilterFromParam('completed')).toBeNull();
    expect(documentStatusFilterFromParam('intake')).toBeNull();
    expect(documentStatusFilterFromParam('toString')).toBeNull();
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'])(
    'תכונת פרוטוטייפ (%s) אינה מצב סינון',
    (key) => { expect(documentStatusFilterFromParam(key)).toBeNull(); },
  );

  it('המסנן בודק את התוצאה הקנונית, לא את השלב הגולמי', () => {
    const completedInbox = documentUiStatus({ status: 'completed', document: unfiled });
    expect(completedInbox.label).toBe('לא משויך');
    expect(documentMatchesStatusFilter(completedInbox, 'unassigned')).toBe(true);
    expect(documentMatchesStatusFilter(completedInbox, 'assigned')).toBe(false);
  });

  it('מסמך בארכיון אינו לא-משויך ואינו משויך ליעד עסקי', () => {
    const archived = documentUiStatus({
      status: 'completed',
      document: { entity_type: 'archive', entity_id: null },
    });
    expect(archived).toMatchObject({ state: 'historical', label: 'אורכב', countsAsUnassigned: false });
    expect(documentMatchesStatusFilter(archived, 'unassigned')).toBe(false);
    expect(documentMatchesStatusFilter(archived, 'assigned')).toBe(false);
  });
});

describe('חוזה התג מול שער הדפדפן', () => {
  it.each(STAGES)('%s — data-stage נושא את השלב הגולמי, והטקסט עברי אנושי', (stage) => {
    render(<ProcessingBadge documentId="doc-1" stage={stage} />);
    const badge = screen.getByTestId('document-processing-status');
    const status = documentUiStatus({ status: stage });
    expect(badge.getAttribute('data-document-id')).toBe('doc-1');
    expect(badge.getAttribute('data-stage')).toBe(stage);
    expect(badge.textContent?.trim()).toBe(status.label);
    expect(badge.className).toContain(`badge-${status.tone}`);
  });

  it.each(STAGES)('%s — ההסבר נגיש גם בלי ריחוף, ומחוץ לטקסט התג', (stage) => {
    const { container } = render(<ProcessingBadge documentId="doc-4" stage={stage} />);
    const badge = screen.getByTestId('document-processing-status');
    const description = documentUiStatus({ status: stage }).description;
    expect(badge.getAttribute('title')).toBe(description);
    // ולא ב-title בלבד: tooltip אינו קיים במגע, והתרחיש מריץ את הדף הזה ב-390px.
    expect(container.querySelector('.sr-only')?.textContent).toBe(description);
    // ומחוץ לתג — check-browser-smoke.cjs מודד את ה-innerText שלו מול תווית אחת.
    expect(badge.textContent?.trim()).toBe(documentUiStatus({ status: stage }).label);
  });

  it('שורה שהעיבוד שלה הושלם ושויכה מספרת על היעד בתג עצמו', () => {
    render(<ProcessingBadge documentId="doc-2" stage="completed" doc={onInvoice} />);
    const badge = screen.getByTestId('document-processing-status');
    expect(badge.getAttribute('data-stage')).toBe('completed');
    expect(badge.textContent?.trim()).toBe('שויך לחשבונית');
  });

  it('כשמצב העיבוד לא נטען, התג אומר זאת ולא ממציא שלב', () => {
    render(<ProcessingBadge documentId="doc-3" stage={null} />);
    const badge = screen.getByTestId('document-processing-status');
    expect(badge.getAttribute('data-stage')).toBeNull();
    expect(badge.textContent?.trim()).toBe('סטטוס לא זמין');
  });
});
