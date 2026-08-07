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
  DOCUMENT_USER_STATE_FILTERS,
  DOCUMENT_USER_STATE_META,
  documentUserState,
  documentUserStateDescription,
  documentUserStateFromParam,
  documentUserStateLabel,
  documentUserStateUrgency,
  type DocumentProcessingStage,
  type DocumentUserState,
} from './useDocumentProcessing';
import { ProcessingBadge, ProcessingFilterSelect } from '../pages/DocumentsInbox';

const STAGES = Object.keys(DOCUMENT_PROCESSING_STAGE_META) as DocumentProcessingStage[];

const unfiled = { entity_type: 'inbox', entity_id: null };
const archived = { entity_type: 'archive', entity_id: null };
const onInvoice = { entity_type: 'invoice', entity_id: '00000000-0000-4000-8000-000000000001' };
const onReceipt = { entity_type: 'goods_receipt', entity_id: '00000000-0000-4000-8000-000000000002' };

describe('שבעת השלבים שורדים מתחת לתצוגה', () => {
  // אם מישהו "יפשט" את החוזה הפנימי בעקבות המסך, נופלות איתו 29 תרחישי דפדפן, סוויטות SQL
  // ופונקציות מסד. הטענה הזו קיימת כדי שהניסיון ייכשל כאן קודם.
  it('טבלת השלבים הפנימית נשארת בת שבעה שלבים עם התוויות ההנדסיות שלה', () => {
    expect(STAGES).toEqual(['unprocessed', 'queued', 'processing', 'extracted', 'review', 'completed', 'failed']);
    expect(DOCUMENT_PROCESSING_STAGE_META.extracted.label).toBe('ממתין לפירוש');
    expect(DOCUMENT_PROCESSING_STAGE_META.completed.label).toBe('הושלם');
  });
});

describe('שבעה שלבים → ארבעה מצבים אנושיים', () => {
  it('כל שלב פנימי מקבל מצב, ובסך הכול יש ארבעה', () => {
    const states = STAGES.map(documentUserState);
    expect(states).toEqual(['intake', 'intake', 'intake', 'intake', 'review', 'completed', 'failed']);
    expect(new Set(states).size).toBe(4);
  });

  it('התוויות הן המילים של הבעלים, לא מונחי מכונה', () => {
    expect(DOCUMENT_USER_STATE_META.intake.label).toBe('נקלט');
    expect(DOCUMENT_USER_STATE_META.review.label).toBe('בבדיקה');
    expect(DOCUMENT_USER_STATE_META.completed.label).toBe('שויך');
    expect(DOCUMENT_USER_STATE_META.failed.label).toBe('לא נקרא');
    // "פירוש", "חילוץ" ו"עיבוד" הם מה שהמשתמשים לא אמורים לפגוש.
    const labels = Object.values(DOCUMENT_USER_STATE_META).map(({ label }) => label).join(' ');
    expect(labels).not.toMatch(/עיבוד|פירוש|חילוץ|OCR/);
  });

  it('מסמך שנכשל לעולם אינו נקרא "נקלט"', () => {
    expect(documentUserState('failed')).not.toBe(documentUserState('queued'));
    expect(DOCUMENT_USER_STATE_META[documentUserState('failed')].label).toBe('לא נקרא');
    expect(documentUserStateDescription('failed')).toContain('לא הצלחנו לקרוא');
    // ההסבר חייב להשאיר דרך פעולה — אחרת המשתמש נתקע מול "נכשל" בלי מוצא.
    expect(documentUserStateDescription('failed')).toContain('לשייך ידנית');
  });

  it('מסמך שמעולם לא נשלח לעיבוד לא מתואר כמסמך שקוראים אותו כרגע', () => {
    // הקיבוץ עצמו הוא של הבעלים: `unprocessed` יושב עם השלושה. אבל המשפט "המערכת קוראת את
    // המסמך" אינו נכון עליו — שום עבודה לא רצה — ולכן ההסבר שלו נפרד מהתווית המשותפת.
    expect(documentUserState('unprocessed')).toBe('intake');
    expect(documentUserStateDescription('queued')).toBe('המערכת קוראת את המסמך');
    expect(documentUserStateDescription('unprocessed')).not.toBe(documentUserStateDescription('queued'));
    expect(documentUserStateDescription('unprocessed')).toContain('טרם נשלח');
  });

  it('גווני התג נשארים בחמש הקטגוריות הקיימות ומתאימים למשמעות', () => {
    const tones = new Set(Object.values(DOCUMENT_PROCESSING_STAGE_META).map(({ tone }) => tone));
    for (const { tone } of Object.values(DOCUMENT_USER_STATE_META)) expect(tones).toContain(tone);
    expect(DOCUMENT_USER_STATE_META.review.tone).toBe('await');
    expect(DOCUMENT_USER_STATE_META.completed.tone).toBe('done');
    expect(DOCUMENT_USER_STATE_META.failed.tone).toBe('alert');
  });
});

describe('"שויך" חייב לומר את האמת על השיוך', () => {
  it('מסמך שהעיבוד שלו הושלם ושויך אומר לאן', () => {
    expect(documentUserStateLabel('completed', onInvoice)).toBe('שויך לחשבונית');
    expect(documentUserStateLabel('completed', onReceipt)).toBe('שויך לקבלת סחורה');
  });

  it('מסמך שהעיבוד שלו הושלם אך לא שויך אינו מוצג כמשויך', () => {
    // עמודת התיוק באותה שורה אומרת "לא משויך". תג עיבוד שיאמר "שויך" לצידה הופך את המסך
    // לסתירה עצמית — וזה בדיוק המצב היחיד שמייצר `completed` היום (0048: אישור מחירון
    // משאיר את המסמך ב-inbox).
    expect(documentUserStateLabel('completed', unfiled)).not.toContain('שויך');
    expect(documentUserStateLabel('completed', unfiled)).toBe('נקרא');
    expect(documentUserStateLabel('completed', archived)).toBe('נקרא');
  });

  it('בלי שורת מסמך נופלים לתווית המצב, לא לניחוש על היעד', () => {
    expect(documentUserStateLabel('completed', null)).toBe('שויך');
    expect(documentUserStateLabel('review', onInvoice)).toBe('בבדיקה');
    expect(documentUserStateLabel('unprocessed', onInvoice)).toBe('נקלט');
  });
});

describe('הסינון מדבר באותם ארבעה מצבים', () => {
  it('ארבע אפשרויות, באותן מילים שעל התגים', () => {
    expect(DOCUMENT_USER_STATE_FILTERS.map(({ value }) => value))
      .toEqual(['intake', 'review', 'completed', 'failed']);
    expect(DOCUMENT_USER_STATE_FILTERS.map(({ label }) => label))
      .toEqual(['נקלט', 'בבדיקה', 'שויך', 'לא נקרא']);
  });

  it('כתובת ישנה עם שלב הנדסי נשארת סינון בעל משמעות', () => {
    // `?processing=extracted` שרד ניווט לפני השינוי הזה. הוא חייב להמשיך לסנן משהו הגיוני —
    // הקבוצה שמכילה את השלב — ולא להציג רשימה ריקה בלי הסבר.
    const expected: Record<DocumentProcessingStage, DocumentUserState> = {
      unprocessed: 'intake', queued: 'intake', processing: 'intake', extracted: 'intake',
      review: 'review', completed: 'completed', failed: 'failed',
    };
    for (const stage of STAGES) expect(documentUserStateFromParam(stage)).toBe(expected[stage]);
  });

  it('ערך שאינו מוכר אינו מסנן דבר', () => {
    expect(documentUserStateFromParam('banana')).toBeNull();
    expect(documentUserStateFromParam('')).toBeNull();
    expect(documentUserStateFromParam(null)).toBeNull();
  });

  // `banana` נכשל נכון גם עם `in`, ולכן הבדיקה שמעליו החמיצה מחלקה שלמה: `in` מטפס על שרשרת
  // הפרוטוטייפ, ולכן `?processing=toString` חזר כאילו היה מצב תקין — הבקרה הציגה "הכול" מעל
  // רשימה מסוננת לאפס שורות. בקרה שמכריזה על מסנן שאינו מופעל היא בדיוק השקר שהמסך הזה נועד
  // להפסיק.
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'])(
    'תכונת פרוטוטייפ (%s) אינה מצב, ואינה מסננת דבר',
    (key) => { expect(documentUserStateFromParam(key)).toBeNull(); },
  );

  it('הבקרה עצמה מציגה ארבעה מצבים ועוד "הכול" — לא שבעה שלבים', () => {
    // הטענה על המערך המיוצא אינה טענה על הבקרה: החלפת ה-JSX חזרה לשבעת השלבים לא הפילה דבר,
    // ו-`selectOption('failed')` בשער הדפדפן עובר מול שתי הרשימות גם יחד.
    render(<ProcessingFilterSelect value="all" onChange={() => {}} />);
    const select = screen.getByTestId('documents-processing-filter');
    const options = [...select.querySelectorAll('option')];
    expect(options.map((option) => option.value)).toEqual(['all', 'intake', 'review', 'completed', 'failed']);
    expect(options.map((option) => option.textContent)).toEqual(['הכול', 'נקלט', 'בבדיקה', 'שויך', 'לא נקרא']);
  });
});

describe('סדר הדחיפות בעמודת המצב', () => {
  // §12: המסך אמור לענות תוך שניות מה דורש טיפול. מיון לפי שם המצב נתן
  // שויך → לא נקרא → נקלט → בבדיקה — קיבוץ נכון, דירוג חסר משמעות.
  it('מה שממתין לאדם עולה ראשון, ומה שהסתיים אחרון', () => {
    const ranked = [...STAGES].sort((a, b) => documentUserStateUrgency(a) - documentUserStateUrgency(b));
    expect(ranked.map(documentUserState)).toEqual([
      'review', 'failed', 'intake', 'intake', 'intake', 'intake', 'completed',
    ]);
    expect(documentUserStateUrgency('review')).toBeLessThan(documentUserStateUrgency('failed'));
    expect(documentUserStateUrgency('failed')).toBeLessThan(documentUserStateUrgency('queued'));
    expect(documentUserStateUrgency('queued')).toBeLessThan(documentUserStateUrgency('completed'));
  });
});

describe('חוזה התג מול שער הדפדפן', () => {
  it.each(STAGES)('%s — data-stage נושא את השלב הגולמי, והטקסט עברי אנושי', (stage) => {
    render(<ProcessingBadge documentId="doc-1" stage={stage} />);
    const badge = screen.getByTestId('document-processing-status');
    expect(badge.getAttribute('data-document-id')).toBe('doc-1');
    expect(badge.getAttribute('data-stage')).toBe(stage);
    expect(badge.textContent?.trim()).toBe(DOCUMENT_USER_STATE_META[documentUserState(stage)].label);
    expect(badge.className).toBe(`badge-${DOCUMENT_USER_STATE_META[documentUserState(stage)].tone}`);
  });

  it.each(STAGES)('%s — ההסבר נגיש גם בלי ריחוף, ומחוץ לטקסט התג', (stage) => {
    const { container } = render(<ProcessingBadge documentId="doc-4" stage={stage} />);
    const badge = screen.getByTestId('document-processing-status');
    const description = documentUserStateDescription(stage);
    expect(badge.getAttribute('title')).toBe(description);
    // ולא ב-title בלבד: tooltip אינו קיים במגע, והתרחיש מריץ את הדף הזה ב-390px.
    expect(container.querySelector('.sr-only')?.textContent).toBe(description);
    // ומחוץ לתג — check-browser-smoke.cjs מודד את ה-innerText שלו מול תווית אחת.
    expect(badge.textContent?.trim()).toBe(documentUserStateLabel(stage, null));
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
