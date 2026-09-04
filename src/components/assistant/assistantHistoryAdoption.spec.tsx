import { he } from '../../lib/i18n/dictionaries/he';
import { MemoryRouter } from 'react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from '../AssistantPanel';
import { type AssistantRunResult } from '../../lib/assistant/contracts';

/* אימוץ ה-history בפתיחת הפאנל הוא מרוץ, ולכן הוא נבחן בקובץ משלו.
   ‏`assistantPanel.spec.tsx` משאיר את `listAssistantConversations` מחוץ ל-mock שלו בכוונה —
   כך האפקט של האימוץ נופל מיד ל-catch ואינו מפריע לארבעים הבדיקות שם. כאן ה-mock כן מספק
   אותו, וזה מה שמאפשר להחזיק את חלון ה-await פתוח ולשאול שאלה בתוכו. */

let flags: Set<string>;
const ask = vi.fn();
const listConversations = vi.fn();
const loadConversation = vi.fn();

const OLD_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
/** מה שהאדם שאל עכשיו, ומה שהשיחה הישנה שאלה — שתי שאלות שונות, בכוונה. */
const ASKED_NOW = 'כמה חשבוניות ממתינות לי היום?';
const ASKED_BEFORE = 'מה מצב הספקים?';
const OLD_ANSWER_TEXT = 'התשובה הישנה מהשיחה הקודמת.';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { role: 'owner' } }),
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
  sendAssistantFeedback: vi.fn(),
  listAssistantConversations: (...args: unknown[]) => listConversations(...args),
  loadAssistantConversation: (...args: unknown[]) => loadConversation(...args),
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
  run_id: '66666666-6666-4666-8666-666666666666',
  conversation_id: OLD_CONVERSATION_ID,
  answer: {
    blocks: [{ type: 'text', text: OLD_ANSWER_TEXT }],
    next_steps: [],
    no_answer_reason: null,
  },
  facts: [],
  sources: [],
  tools_used: [],
  complete: true,
  as_of: '2026-08-20T08:00:00.000Z',
  proposal: null,
  ...over,
});

const olderConversation = () => [
  { question: ASKED_BEFORE, result: makeResult() },
];

function renderPanel() {
  return render(
    <MemoryRouter>
      <AssistantPanel />
    </MemoryRouter>,
  );
}

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: /העוזר של InPlace|חזרה לבדיקה/ }));
  return screen.findByRole('dialog', { name: /העוזר של InPlace/ });
}

async function askQuestion(text: string) {
  fireEvent.change(screen.getByLabelText('שאלה לבדיקה'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'בדיקה' }));
}

/* השאלה שנשלחה מופיעה גם בשרשור וגם כתוכן ה-textarea שלא נוקה, ולכן כל טענה כאן
   ממוקדת לשרשור עצמו. אחרת הבדיקה נופלת על „נמצאו כמה" — כשל של השאילתה, לא של המוצר. */
const thread = () => document.querySelector('[data-assistant-thread]') as HTMLElement;

/** מרוקן את שרשרת ה-await של האפקט: רשימת השיחות, ואז טעינת השיחה עצמה. */
async function settleAdoption() {
  await waitFor(() => expect(loadConversation).toHaveBeenCalledWith(OLD_CONVERSATION_ID));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  flags = new Set(['assistant.ui', 'assistant.history']);
  ask.mockReset();
  listConversations.mockReset();
  loadConversation.mockReset();
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

describe('העוזר של InPlace — אימוץ history מול שאלה שנשאלה בתוך החלון', () => {
  it('שאלה שהוכרעה בתוך חלון האימוץ שורדת — תשובה ישנה אינה מוחקת אותה ואת התוצאה שלה', async () => {
    // האפקט נעצר על ה-await הראשון, וכך החלון נשאר פתוח בזמן שהאדם שואל.
    const pendingList = deferred<{ id: string; title: string; updated_at: string }[]>();
    listConversations.mockReturnValue(pendingList.promise);
    loadConversation.mockResolvedValue(olderConversation());
    // מסלול שגיאה הוא המסלול המהיר — בדיוק זה שנופל בתוך החלון.
    ask.mockRejectedValue(new Error('assistant_limit_reached'));

    renderPanel();
    await openDialog();
    expect(listConversations).toHaveBeenCalledWith(1);

    await askQuestion(ASKED_NOW);
    // הריצה הוכרעה: מכאן `inFlightRef` כבר ריק, וזה כל הבאג.
    expect(await screen.findByText(he.errors.assistant_limit_reached)).toBeInTheDocument();
    expect(within(thread()).getByText(ASKED_NOW)).toBeInTheDocument();

    await act(async () => {
      pendingList.resolve([{
        id: OLD_CONVERSATION_ID,
        title: ASKED_BEFORE,
        updated_at: '2026-08-20T08:00:00.000Z',
      }]);
      await pendingList.promise;
    });
    await settleAdoption();

    // האורקל: השאלה של האדם והתוצאה שלה נשארות. לפני התיקון שתיהן נמחקו והוחלפו
    // בתשובה ישנה לשאלה אחרת — והשגיאה נעלמה בשקט יחד איתן.
    expect(within(thread()).getByText(ASKED_NOW)).toBeInTheDocument();
    expect(within(thread()).getByText(he.errors.assistant_limit_reached)).toBeInTheDocument();
    expect(within(thread()).queryByText(ASKED_BEFORE)).toBeNull();
    expect(within(thread()).queryByText(OLD_ANSWER_TEXT)).toBeNull();
  });

  it('שאלה שעדיין רצה בתוך החלון שורדת גם היא — השכן שכבר היה מוגן נשאר מוגן', async () => {
    const pendingList = deferred<{ id: string; title: string; updated_at: string }[]>();
    listConversations.mockReturnValue(pendingList.promise);
    loadConversation.mockResolvedValue(olderConversation());
    const neverSettles = deferred<AssistantRunResult>();
    ask.mockReturnValue(neverSettles.promise);

    renderPanel();
    await openDialog();
    await askQuestion(ASKED_NOW);

    await act(async () => {
      pendingList.resolve([{
        id: OLD_CONVERSATION_ID,
        title: ASKED_BEFORE,
        updated_at: '2026-08-20T08:00:00.000Z',
      }]);
      await pendingList.promise;
    });
    await settleAdoption();

    expect(within(thread()).getByText(ASKED_NOW)).toBeInTheDocument();
    expect(within(thread()).queryByText(ASKED_BEFORE)).toBeNull();
    expect(within(thread()).queryByText(OLD_ANSWER_TEXT)).toBeNull();
  });

  it('פאנל שלא נשאל בו דבר עדיין מאמץ את השיחה האחרונה — התיקון מסרב, לא מכבה', async () => {
    listConversations.mockResolvedValue([{
      id: OLD_CONVERSATION_ID,
      title: ASKED_BEFORE,
      updated_at: '2026-08-20T08:00:00.000Z',
    }]);
    loadConversation.mockResolvedValue(olderConversation());

    renderPanel();
    await openDialog();

    expect(await screen.findByText(OLD_ANSWER_TEXT)).toBeInTheDocument();
    expect(within(thread()).getByText(ASKED_BEFORE)).toBeInTheDocument();
  });
});
