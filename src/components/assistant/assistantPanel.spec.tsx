import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from '../AssistantPanel';
import {
  ASSISTANT_DRAFT_LABEL,
  ASSISTANT_ERROR_MESSAGES,
  type AssistantRunResult,
} from '../../lib/assistant/contracts';
import { fmtMoneyExact } from '../../lib/format';

/* הפאנל נבחן מול שכבת לקוח מדומה: החוזה של המעטפה הוא של השרת, והבדיקות כאן מוכיחות
   שכל מה שמוצג ניתן לעקיבה — לא שהשרת צודק. */

let flags: Set<string>;
let currentRole: 'owner' | 'office' | 'accountant';
let desktopMode: boolean;
const ask = vi.fn();
const feedback = vi.fn();
const loadConversation = vi.fn();
let historyRows: { id: string; title: string; updated_at: string }[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { role: currentRole } }),
}));

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
  loadAssistantConversation: (...args: unknown[]) => loadConversation(...args),
  deleteAssistantConversation: vi.fn(),
  useAssistantConversations: () => ({
    data: historyRows,
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
        claim_unit: 'ils',
        claim_value: 1650.6,
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

/* טיוטת תזכורת לספק (#191): גוף ההודעה שהמשתמש עצמו ישלח, מעוגן בעובדות שהשרת הנפיק. */
const DRAFT_TEXT = 'שלום, נשמח לעדכון על מועד האספקה של הזמנה 1042.';

const draftResult = (): AssistantRunResult => makeResult({
  answer: {
    blocks: [{ type: 'draft', text: DRAFT_TEXT, fact_ids: ['f1'], source_ids: ['s1'] }],
    next_steps: [],
    no_answer_reason: null,
  },
  facts: [{
    id: 'f1',
    kind: 'order.status',
    subject: { entity: 'purchase_order', id: 'po-1' },
    label: 'מספר ההזמנה — הזמנה #1042',
    value: '1042',
    unit: 'text',
    tool: 'draft_supplier_reminder',
    as_of: '2026-08-20T08:00:00.000Z',
    classification: 'tenant_standard',
  }],
  sources: [{
    id: 's1',
    entity: 'purchase_order',
    entity_id: 'po-1',
    label: 'הזמנה #1042 — ירקות השדה',
    route: '/orders/po-1',
    classification: 'tenant_standard',
  }],
  tools_used: [{ tool: 'draft_supplier_reminder', complete: true }],
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <AssistantPanel />
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: /העוזר של InPlace|חזרה לבדיקה/ });

async function openDialog() {
  // userEvent ולא fireEvent: לחיצת עכבר אמיתית ממקדת את הכפתור, וזה מה שמאפשר ל-useDialogLayer
  // ללכוד את הפותח ולהחזיר אליו את המיקוד בסגירה.
  await userEvent.click(trigger());
  const dialog = await screen.findByRole(desktopMode ? 'complementary' : 'dialog', { name: /העוזר של InPlace/ });
  return dialog;
}

async function askQuestion(text = 'מה מצב הספקים?') {
  fireEvent.change(screen.getByLabelText('שאלה לבדיקה'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'בדיקה' }));
}

beforeEach(() => {
  flags = new Set(['assistant.ui']);
  currentRole = 'owner';
  desktopMode = false;
  ask.mockReset();
  feedback.mockReset();
  loadConversation.mockReset();
  historyRows = [];
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: desktopMode && query.includes('min-width: 64rem'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
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
    await waitFor(() => expect(screen.getByLabelText('שאלה לבדיקה')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('הטריגר הוא הנצנוץ בלבד, והשם נשאר נגיש בלי טקסט נראה', () => {
    // Rewritten 25.08.2026 by owner ruling: the assistant was never named „בדיקה", and the word
    // beside the icon read like an environment tag on a live product. The case that used to pin
    // the WORD now pins what replaced it — the trigger shows no text at ANY width, and the name
    // it lost from the surface it keeps as its accessible name. That is the half worth guarding:
    // dropping visible text is only safe while the label survives for a screen reader.
    desktopMode = true;
    renderPanel();
    expect(trigger().textContent?.trim()).toBe('');
    expect(trigger()).toHaveAccessibleName('העוזר של InPlace');
    expect(trigger().querySelector('[data-assistant-trigger-icon="sparkles"]')).not.toBeNull();
  });

  it('הכותרת שומרת את שם המוצר ואת „לקריאה בלבד" גם כשכפתור „בדיקה חדשה" נוכח', async () => {
    // 26.08.2026: the subtitle used to share the header row with the controls and carried
    // `truncate`. At 27.5rem, with „בדיקה חדשה" present, what the ellipsis ate was the END of the
    // sentence — „בדיקה תפעולית מבוססת ר…" — i.e. exactly the two words DESIGN.md requires the
    // header to keep. A promise about what the surface may do cannot be the clipped half.
    desktopMode = true;
    ask.mockResolvedValue(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByRole('button', { name: 'בדיקה חדשה' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'העוזר של InPlace' })).toBeInTheDocument();
    const subtitle = screen.getByText('בדיקה תפעולית מבוססת ראיות · לקריאה בלבד');
    expect(subtitle.className).not.toContain('truncate');
  });

  it('בזמן ריצה מוצג סימן חיים בעמדת התשובה — נקודות בלי שם, בלי דמות ובלי טקסט נראה', async () => {
    const pendingRun = deferred<AssistantRunResult>();
    ask.mockReturnValue(pendingRun.promise);
    renderPanel();
    const panel = await openDialog();
    await askQuestion();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    const typing = panel.querySelector('[data-assistant-typing]');
    expect(typing).not.toBeNull();
    expect(typing?.children).toHaveLength(3);
    // The visible mark is decoration over a state; the sentence is what assistive tech is told.
    // Nothing here may name, personify or impersonate an author (DESIGN.md:515).
    expect(typing).toHaveAttribute('aria-hidden', 'true');
    expect(typing?.textContent).toBe('');
    expect(screen.getByText('בודק את הנתונים המורשים')).toBeInTheDocument();
  });

  it('ב-1024 ומעלה המשטח docked ו-non-modal: אין aria-modal ואין נעילת body', async () => {
    desktopMode = true;
    renderPanel();
    const panel = await openDialog();
    expect(panel).toHaveAttribute('data-assistant-mode', 'docked');
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(document.body.style.overflow).toBe('');
  });

  it('מתחת ל-1024 המשטח full-screen modal ונועל את הרקע', async () => {
    renderPanel();
    const panel = await openDialog();
    expect(panel).toHaveAttribute('data-assistant-mode', 'fullscreen');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('סגירה בזמן pending ממשיכה את אותה ריצה; reopen לא שולח שוב ומציג את התוצאה כשהיא מגיעה', async () => {
    const pendingRun = deferred<AssistantRunResult>();
    ask.mockReturnValue(pendingRun.promise);
    renderPanel();
    await openDialog();
    await askQuestion('מה מצב הספקים?');
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'סגירת הבדיקה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openDialog();
    expect(screen.getByText('בודק את הנתונים המורשים')).toBeInTheDocument();
    expect(screen.getByLabelText('שאלה לבדיקה')).toBeDisabled();
    expect(ask).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingRun.resolve(makeResult());
      await pendingRun.promise;
    });
    expect(await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('שינוי role מנקה מיד תשובה שכבר הוצגה תחת ההרשאה הקודמת', async () => {
    ask.mockResolvedValue(makeResult());
    const view = renderPanel();
    await openDialog();
    await askQuestion();
    expect(await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();

    currentRole = 'office';
    view.rerender(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeNull();
    });
    expect(screen.getByLabelText('שאלה לבדיקה')).toHaveValue('');
  });

  it('תוצאה של ריצה pending נזרקת אם role השתנה לפני שחזרה', async () => {
    const pendingRun = deferred<AssistantRunResult>();
    ask.mockReturnValue(pendingRun.promise);
    const view = renderPanel();
    await openDialog();
    await askQuestion();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    currentRole = 'office';
    view.rerender(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('שאלה לבדיקה')).not.toBeDisabled());

    await act(async () => {
      pendingRun.resolve(makeResult());
      await pendingRun.promise;
    });
    expect(screen.queryByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeNull();
    expect(screen.getByLabelText('שאלה לבדיקה')).toHaveValue('');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('Tab מהפריט האחרון מתגלגל לראשון — המיקוד כלוא בדיאלוג, לא בורח לעמוד שמאחור', async () => {
    renderPanel();
    await openDialog();
    const textarea = screen.getByLabelText('שאלה לבדיקה');
    await waitFor(() => expect(textarea).toHaveFocus());
    // כפתור "בדיקה" מנוטרל כששדה השאלה ריק, ולכן שדה השאלה הוא הפריט האחרון שניתן למיקוד.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'סגירת הבדיקה' })).toHaveFocus();
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
      element?.tagName === 'DD' && element.textContent === fmtMoneyExact(1650.6, 'ILS'));
    expect(value).toBeInTheDocument();
    const source = screen.getByRole('link', { name: /ירקות השדה/ });
    expect(source).toHaveAttribute('href', '/suppliers/sup-1');
  });

  it('השאלה שנשלחה נשארת גלויה עם העדכניות אחרי שהתוצאה התקבלה', async () => {
    ask.mockResolvedValue(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion('מה מצב הספקים בחלון שנבדק?');
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    // Owner decision 24.08.2026: the exchange reads as a conversation. The question stays on
    // screen as the message its author wrote, and the answer keeps its freshness beside it.
    expect(screen.getByLabelText('השיחה עם העוזר')).toBeInTheDocument();
    expect(screen.getByText('מה מצב הספקים בחלון שנבדק?')).toBeInTheDocument();
    expect(screen.getByText(/עודכן ל־/)).toBeInTheDocument();
  });

  it('שאלה שנייה מצטרפת לשיחה במקום להחליף את הראשונה', async () => {
    ask.mockResolvedValueOnce(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion('מה מצב הספקים בחלון שנבדק?');
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    ask.mockResolvedValueOnce(makeResult({
      run_id: '55555555-5555-4555-8555-555555555555',
      answer: { blocks: [{ type: 'text', text: 'שתי חשבוניות ממתינות לאישור.' }], next_steps: [], no_answer_reason: null },
    }));
    await askQuestion('וכמה חשבוניות ממתינות?');
    await screen.findByText('שתי חשבוניות ממתינות לאישור.');

    // The first exchange is still there. Before this, a second question replaced the first.
    expect(screen.getByText('מה מצב הספקים בחלון שנבדק?')).toBeInTheDocument();
    expect(screen.getByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
    expect(screen.getByText('וכמה חשבוניות ממתינות?')).toBeInTheDocument();
    expect(screen.getAllByText(/עודכן ל־/)).toHaveLength(2);
  });

  it('היקף הבדיקה מציג תוויות מוצר עבריות ולא שמות tools פנימיים', async () => {
    ask.mockResolvedValue(makeResult({
      tools_used: [{ tool: 'get_open_credits', complete: true }],
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    fireEvent.click(screen.getByText('היקף הבדיקה'));
    expect(screen.getByText('זיכויים פתוחים')).toBeInTheDocument();
    expect(screen.queryByText('get_open_credits')).toBeNull();
  });

  it('בדסקטופ פתיחת מקור משאירה את הפאנל פתוח כדי להשוות אותו למסך המקור', async () => {
    desktopMode = true;
    ask.mockResolvedValue(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    await userEvent.click(screen.getByRole('link', { name: /ירקות השדה/ }));
    expect(screen.getByRole('complementary', { name: /העוזר של InPlace/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ירקות השדה/ })).toHaveAttribute('aria-current', 'page');
  });

  it('במובייל פתיחת מקור סוגרת את המסך המלא ומשאירה טריגר מפורש לחזרה לאותה בדיקה', async () => {
    ask.mockResolvedValue(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    await userEvent.click(screen.getByRole('link', { name: /ירקות השדה/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveAccessibleName(/חזרה לבדיקה/);
    await waitFor(() => expect(trigger()).toHaveFocus());

    await userEvent.click(trigger());
    expect(await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
  });

  it('history מאושרת נפתחת רק דרך מעטפת ה-Edge ומחליפה את המשטח בשאלה ובממצאים שעברו reauthorization', async () => {
    flags = new Set(['assistant.ui', 'assistant.history']);
    historyRows = [{
      id: '22222222-2222-4222-8222-222222222222',
      title: 'מה מצב הספקים?',
      updated_at: '2026-08-20T08:00:00.000Z',
    }];
    // A stored conversation comes back whole. Returning only its newest turn is the defect this
    // replaced: the earlier questions were loaded, authorized, and then thrown away.
    loadConversation.mockResolvedValue([
      {
        question: 'מה שאלתי קודם?',
        result: {
          ...makeResult(),
          run_id: '66666666-6666-4666-8666-666666666666',
          conversation_id: historyRows[0].id,
          answer: {
            blocks: [{ type: 'text', text: 'התשובה מהתור הראשון.' }],
            next_steps: [],
            no_answer_reason: null,
          },
        },
      },
      {
        question: 'מה מצב הספקים?',
        result: { ...makeResult(), conversation_id: historyRows[0].id },
      },
    ]);
    renderPanel();
    await openDialog();

    await userEvent.click(screen.getByRole('button', { name: /פתיחת הבדיקה מה מצב הספקים/ }));
    expect(loadConversation).toHaveBeenCalledWith(historyRows[0].id);
    expect(await screen.findByLabelText('השיחה עם העוזר')).toBeInTheDocument();
    expect(screen.getByText('מה שאלתי קודם?')).toBeInTheDocument();
    expect(screen.getByText('התשובה מהתור הראשון.')).toBeInTheDocument();
    expect(screen.getByText('מה מצב הספקים?')).toBeInTheDocument();
    expect(screen.getByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
  });

  it('תוצאת history ישנה נזרקת אם ההרשאה השתנתה בזמן טעינתה', async () => {
    flags = new Set(['assistant.ui', 'assistant.history']);
    historyRows = [{
      id: '22222222-2222-4222-8222-222222222222',
      title: 'מה מצב הספקים?',
      updated_at: '2026-08-20T08:00:00.000Z',
    }];
    const pendingHistory = deferred<{ question: string; result: AssistantRunResult }[]>();
    loadConversation.mockReturnValue(pendingHistory.promise);
    const view = renderPanel();
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: /פתיחת הבדיקה מה מצב הספקים/ }));

    currentRole = 'office';
    view.rerender(
      <MemoryRouter>
        <AssistantPanel />
      </MemoryRouter>,
    );
    await act(async () => {
      pendingHistory.resolve([{
        question: 'מה מצב הספקים?',
        result: { ...makeResult(), conversation_id: historyRows[0].id },
      }]);
      await pendingHistory.promise;
    });

    expect(screen.queryByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeNull();
    expect(screen.getByLabelText('שאלה לבדיקה')).toHaveValue('');
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
          claim_unit: 'count',
          claim_value: null,
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

  it('timeout מאפשר retry רק אחרי שהריצה הראשונה הסתיימה, בלי שתי בקשות חופפות', async () => {
    ask
      .mockRejectedValueOnce(new Error('assistant_provider_timeout'))
      .mockResolvedValueOnce(makeResult());
    renderPanel();
    await openDialog();
    await askQuestion('מה מצב הספקים?');
    expect(await screen.findByText(ASSISTANT_ERROR_MESSAGES.assistant_provider_timeout)).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('שאלה לבדיקה')).toHaveValue('מה מצב הספקים?');

    fireEvent.click(screen.getByRole('button', { name: 'בדיקה' }));
    expect(await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.')).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('מקור ו-next step שאינם מורשים לתפקיד הנוכחי אינם מגיעים ל-render גם אם ה-Edge שגה', async () => {
    currentRole = 'accountant';
    ask.mockResolvedValue(makeResult({
      answer: {
        ...makeResult().answer,
        next_steps: [{ label: 'פתיחת כרטיס הספק', source_id: 's1' }],
      },
    }));
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText('היתרה הפתוחה לספק ירקות השדה גבוהה מהרגיל.');

    expect(screen.queryByRole('link', { name: /ירקות השדה|פתיחת כרטיס הספק/ })).toBeNull();
  });

  it('fallback מסונן מול Guard התפקיד: accountant מקבל dashboard אך לא קישור staff ל-alerts', async () => {
    currentRole = 'accountant';
    ask.mockRejectedValue(new Error('assistant_limit_reached'));
    renderPanel();
    await openDialog();
    await askQuestion();
    await screen.findByText(ASSISTANT_ERROR_MESSAGES.assistant_limit_reached);

    expect(screen.queryByRole('link', { name: 'מסך ההתראות' })).toBeNull();
    expect(screen.getByRole('link', { name: 'מרכז הבקרה' })).toHaveAttribute('href', '/dashboard');
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
    expect(live).toHaveTextContent('הבדיקה הושלמה');
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
  it('בלוק טיוטה מוצג עם התווית הקבועה של המוצר ועם פעולת העתקה בלבד', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    ask.mockResolvedValue(draftResult());
    renderPanel();
    const dialog = await openDialog();
    await askQuestion('נסח תזכורת לספק');

    expect(await screen.findByText(DRAFT_TEXT)).toBeInTheDocument();
    // התווית היא קבוע של המוצר, לא מחרוזת שהמודל כתב.
    expect(screen.getByRole('region', { name: ASSISTANT_DRAFT_LABEL })).toBeInTheDocument();
    expect(screen.getByText(ASSISTANT_DRAFT_LABEL)).toBeInTheDocument();
    // העובדה שהטיוטה מצטטת מוצגת על ידה — טיוטה עקיבה כמו כל טענה.
    expect(screen.getByText('מספר ההזמנה — הזמנה #1042')).toBeInTheDocument();

    const copyButton = screen.getByRole('button', { name: 'העתקת הטיוטה' });
    copyButton.focus();
    expect(copyButton).toHaveFocus();
    await userEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(DRAFT_TEXT);
    // האישור מוכרז ולא רק נראה.
    const confirmation = await screen.findByText(/הטיוטה הועתקה/);
    expect(confirmation).toHaveAttribute('role', 'status');

    // אין שום אפורדנס של שליחה, נמען או ערוץ — המשתמש מעתיק ושולח בעצמו.
    expect(screen.queryByRole('button', { name: /שליחה|לשלוח|נמען|ערוץ|WhatsApp|מייל/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('link', { name: /WhatsApp/ })).toBeNull();
    expect(dialog.textContent).not.toMatch(/נשלח/);
  });

  it('accountant אינו רואה טיוטה לספק גם כשה-Edge שלח אחת (#191)', async () => {
    currentRole = 'accountant';
    ask.mockResolvedValue(draftResult());
    renderPanel();
    await openDialog();
    await askQuestion('נסח תזכורת לספק');
    await screen.findByText('הבדיקה הושלמה');

    expect(screen.queryByText(DRAFT_TEXT)).toBeNull();
    expect(screen.queryByText(ASSISTANT_DRAFT_LABEL)).toBeNull();
    expect(screen.queryByRole('button', { name: 'העתקת הטיוטה' })).toBeNull();
  });

  it('הרכיב עצמו אינו מכיל שום נתיב שליחה — גם לא כמחרוזת', () => {
    const source = readFileSync('src/components/assistant/AnswerView.tsx', 'utf8');
    // #191: המוצר אינו שולח לספק, ולכן המילה הזו אינה קיימת ברכיב שמציג את התשובה — לא בקוד,
    // לא בהערה ולא בטקסט למשתמש.
    expect(source).not.toContain('נשלח');
    // הסריקה הבאה היא על הקוד בלבד: הערה שמסבירה שאין נמען ואין ערוץ היא בדיוק התיעוד שרוצים
    // שיישאר, ואסור שהיא תיקרא כמסלול שליחה.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .join('\n')
      .toLowerCase();
    for (const forbidden of ['mailto:', 'whatsapp', 'recipient', 'channel', 'sendMessage', 'href=']) {
      expect(code).not.toContain(forbidden.toLowerCase());
    }
  });
});
