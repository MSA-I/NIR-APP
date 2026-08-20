import { MemoryRouter } from 'react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from '../AssistantPanel';
import {
  ASSISTANT_ERROR_MESSAGES,
  type AssistantRunResult,
} from '../../lib/assistant/contracts';
import { fmtMoneyExact } from '../../lib/format';

/* הפאנל נבחן מול שכבת לקוח מדומה: החוזה של המעטפה הוא של השרת, והבדיקות כאן מוכיחות
   שכל מה שמוצג ניתן לעקיבה — לא שהשרת צודק. */

let flags: Set<string>;
const ask = vi.fn();
const feedback = vi.fn();

vi.mock('../../lib/flags', () => ({
  useFeatureFlags: () => ({
    flags: null,
    isEnabled: (key: string) => flags.has(key),
    loading: false,
    error: null,
    refetch: async () => true,
  }),
}));

vi.mock('../../lib/assistant/client', () => ({
  askAssistant: (...args: unknown[]) => ask(...args),
  sendAssistantFeedback: (...args: unknown[]) => feedback(...args),
  deleteAssistantConversation: vi.fn(),
  useAssistantConversations: () => ({
    data: [],
    loading: false,
    fetching: false,
    error: null,
    refetch: async () => true,
  }),
}));

const makeResult = (over: Partial<AssistantRunResult> = {}): AssistantRunResult => ({
  run_id: 'run-1',
  conversation_id: 'conv-1',
  answer: {
    blocks: [
      { type: 'text', text: 'בשבוע האחרון נקלטו חשבוניות חדשות.' },
      {
        type: 'claim',
        text: 'היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.',
        claim_kind: 'supplier.balance',
        subject: { entity: 'supplier', id: 'sup-1' },
        fact_ids: ['f1'],
        source_ids: ['s1'],
      },
    ],
    next_steps: [],
    no_answer_reason: null,
  },
  facts: [
    {
      id: 'f1',
      kind: 'supplier.balance',
      subject: { entity: 'supplier', id: 'sup-1' },
      label: 'יתרה פתוחה לספק',
      value: 1650.6,
      unit: 'ils',
      tool: 'supplier_balances',
      as_of: '2026-08-20T08:00:00.000Z',
      classification: 'financial_sensitive',
    },
  ],
  sources: [
    {
      id: 's1',
      entity: 'supplier',
      entity_id: 'sup-1',
      label: 'ירקות השדה',
      route: '/suppliers/sup-1',
      classification: 'tenant_standard',
    },
  ],
  tools_used: [{ tool: 'supplier_balances', complete: true }],
  complete: true,
  as_of: '2026-08-20T08:00:00.000Z',
  proposal: null,
  ...over,
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <AssistantPanel />
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'העוזר של InPlace' });

async function openDialog() {
  // userEvent ולא fireEvent: לחיצת עכבר אמיתית ממקדת את הכפתור, וזה מה שמאפשר ל-useDialogLayer
  // ללכוד את הפותח ולהחזיר אליו את המיקוד בסגירה.
  await userEvent.click(trigger());
  const dialog = await screen.findByRole('dialog', { name: /העוזר של InPlace/ });
  return dialog;
}

async function askQuestion(text = 'מה מצב הספקים?') {
  fireEvent.change(screen.getByLabelText('שאלה לעוזר'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /שאל/ }));
}

beforeEach(() => {
  flags = new Set(['assistant.ui']);
  ask.mockReset();
  feedback.mockReset();
  // jsdom lays nothing out, so the layer's visibility guards (`getClientRects().length > 0`) see
  // no boxes and the trap/restore branches are unreachable by default — same fix as
  // quickCreateSupplierWiring.spec: give the guard the one fact a real browser supplies.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

describe('העוזר של InPlace — הפאנל', () => {
  it('כשהדגל כבוי אין כפתור בכלל — נראות UI אינה הרשאה, אבל דלת לסירוב היא רעש', () => {
    flags = new Set();
    renderPanel();
    expect(screen.queryByRole('button', { name: 'העוזר של InPlace' })).toBeNull();
  });

  it('פתיחה ממקדת את שדה השאלה, ו-Escape סוגר ומחזיר את המיקוד לכפתור שפתח', async () => {
    renderPanel();
    await openDialog();
    await waitFor(() => expect(screen.getByLabelText('שאלה לעוזר')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('Tab מהפריט האחרון מתגלגל לראשון — המיקוד כלוא בדיאלוג, לא בורח לעמוד שמאחור', async () => {
    renderPanel();
    await openDialog();
    const textarea = screen.getByLabelText('שאלה לעוזר');
    await waitFor(() => expect(textarea).toHaveFocus());
    // כפתור "שאל" מנוטרל כששדה השאלה ריק, ולכן שדה השאלה הוא הפריט האחרון שניתן למיקוד.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'סגירה' })).toHaveFocus();
  });

  it('בלוק claim ניתן לעקיבה: העובדות שצוטטו מוצגות בערך המעוצב של הריפו, והמקור הוא קישור למסך אמיתי', async () => {
    ask.mockResolvedValue(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
    expect(screen.getByText('יתרה פתוחה לספק')).toBeInTheDocument();
    // textContent גולמי ולא getByText(string): הפלט של Intl מכיל NBSP שהנרמול של testing-library
    // מקפל לרווח, וההשוואה חייבת להיות מול אותו פורמטר בדיוק — לא מול העתק מוקלד שלו.
    const value = screen.getByText((_, element) =>
      element?.tagName === 'DD' && element.textContent === fmtMoneyExact(1650.6));
    expect(value).toBeInTheDocument();
    const source = screen.getByRole('link', { name: /ירקות השדה/ });
    expect(source).toHaveAttribute('href', '/suppliers/sup-1');
  });

  it('בלוק טקסט בלי עובדות הוא פרוזה רגילה — בלי כרטיס עובדות ובלי מספרים', async () => {
    ask.mockResolvedValue(makeResult({
      answer: { blocks: [{ type: 'text', text: 'לא נמצאו חריגות בבדיקה הזו.' }], next_steps: [], no_answer_reason: null },
      facts: [],
      sources: [],
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    const prose = await screen.findByText('לא נמצאו חריגות בבדיקה הזו.');
    expect(prose.tagName).toBe('P');
    expect(prose.closest('dl')).toBeNull();
  });

  it('complete:false מציג את אזהרת הסריקה החלקית — תשובה חלקית לעולם לא מוצגת כשלמה', async () => {
    ask.mockResolvedValue(makeResult({
      complete: false,
      tools_used: [{ tool: 'supplier_balances', complete: false }],
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText(/אי אפשר לקבוע שהכול תקין/)).toBeInTheDocument();
  });

  it('value:null מוצג כ"—" ולעולם לא כ-0 — אפס הוא טענה על העסק', async () => {
    ask.mockResolvedValue(makeResult({
      facts: [{
        id: 'f1',
        kind: 'metric.count',
        subject: null,
        label: 'תשלומים ללא תאריך יעד',
        value: null,
        unit: 'count',
        tool: 'payment_requests',
        as_of: '2026-08-20T08:00:00.000Z',
        classification: 'tenant_standard',
      }],
      sources: [],
      answer: {
        blocks: [{
          type: 'claim',
          text: 'אי אפשר למדוד תשלומים ללא תאריך יעד.',
          claim_kind: 'metric.count',
          subject: null,
          fact_ids: ['f1'],
          source_ids: [],
        }],
        next_steps: [],
        no_answer_reason: null,
      },
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('קוד שגיאה מתורגם למשפט העברי הקנוני, וקישור הנפילה הדטרמיניסטית ל-/alerts מחווט ולא רק מוזכר', async () => {
    ask.mockRejectedValue(new Error('assistant_limit_reached'));
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText(ASSISTANT_ERROR_MESSAGES.assistant_limit_reached)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'מסך ההתראות' })).toHaveAttribute('href', '/alerts');
  });

  it('undefined_business_rule אומר שהמוצר לא הגדיר את הכלל — לא שאין נתונים', async () => {
    ask.mockResolvedValue(makeResult({
      answer: {
        blocks: [{ type: 'text', text: 'אין תשובה לשאלה הזו.' }],
        next_steps: [],
        no_answer_reason: 'undefined_business_rule',
      },
      facts: [],
      sources: [],
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText(/טרם הגדיר את הכלל העסקי/)).toBeInTheDocument();
    expect(screen.queryByText(/אין נתונים במערכת/)).toBeNull();
  });

  it('התשובה שהוכרעה מוכרזת פעם אחת באזור חי — אין הקראה מצטברת כי אין זרם', async () => {
    ask.mockResolvedValue(makeResult());
    renderPanel();
    const dialog = await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');
    const live = dialog.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('התקבלה תשובה מהעוזר');
  });

  it('משוב נשלח עם מזהה הריצה שהשרת הנפיק, והאישור מוצג במקום הכפתורים', async () => {
    ask.mockResolvedValue(makeResult());
    feedback.mockResolvedValue(undefined);
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');
    fireEvent.click(screen.getByRole('button', { name: 'מועיל' }));
    expect(await screen.findByText(/המשוב נרשם/)).toBeInTheDocument();
    expect(feedback).toHaveBeenCalledWith('run-1', true);
  });
});
