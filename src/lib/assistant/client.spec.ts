import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askAssistant,
  deleteAssistantConversation,
  sendAssistantFeedback,
  useAssistantConversations,
} from './client';
import { ASSISTANT_ERROR_MESSAGES, type AssistantRunResult } from './contracts';
import { toHebrewError } from '../errors';
import { OrgScopeProvider } from '../query/orgScope';

const invoke = vi.fn();
const rpc = vi.fn();
const limit = vi.fn();
const order = vi.fn((..._args: unknown[]) => ({ limit: (...args: unknown[]) => limit(...args) }));
const select = vi.fn((..._args: unknown[]) => ({ order: (...args: unknown[]) => order(...args) }));
const from = vi.fn((..._args: unknown[]) => ({ select: (...args: unknown[]) => select(...args) }));

vi.mock('../supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

const emptyRun: AssistantRunResult = {
  run_id: 'run-1',
  conversation_id: null,
  answer: { blocks: [{ type: 'text', text: 'אין חריגות פתוחות' }], next_steps: [], no_answer_reason: null },
  facts: [],
  sources: [],
  tools_used: [],
  complete: true,
  as_of: '2026-08-20T00:00:00.000Z',
  proposal: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('askAssistant', () => {
  it('שולח את הבקשה לפונקציית assistant ומחזיר את המעטפה כפי שהשרת הנפיק אותה — הלקוח לא מחשב דבר', async () => {
    invoke.mockResolvedValue({ data: emptyRun, error: null });
    const request = { question: 'מה מצב החשבוניות?', conversation_id: null, route: '/dashboard' };
    const result = await askAssistant(request);
    expect(invoke).toHaveBeenCalledWith('assistant', { body: request });
    expect(result).toEqual(emptyRun);
  });

  it('חושף את קוד הסירוב מגוף התשובה — supabase-js בולע את הגוף ב-non-2xx, והקוד הוא מה שממופה לעברית אחת', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { json: async () => ({ error: { code: 'assistant_limit_reached' } }) },
      }),
    });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null }))
      .rejects.toThrow('assistant_limit_reached');
  });

  it('סירוב שמגיע בגוף 2xx (מוסכמת send-feedback) נזרק גם הוא כקוד, לא מדווח כהצלחה', async () => {
    invoke.mockResolvedValue({ data: { error: { code: 'assistant_disabled' } }, error: null });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null }))
      .rejects.toThrow('assistant_disabled');
  });

  it('401 חשוף בגוף ריק הוא השער (verify_jwt) שדחה טוקן לפני הקוד שלנו — ממופה ל-assistant_unauthenticated, לא למשפט הגנרי', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { status: 401, json: async () => { throw new Error('empty body'); } },
      }),
    });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null }))
      .rejects.toThrow('assistant_unauthenticated');
    expect(toHebrewError(new Error('assistant_unauthenticated')))
      .toBe(ASSISTANT_ERROR_MESSAGES.assistant_unauthenticated);
  });
});

describe('מילון השגיאות — ניסוח אחד, לא שניים', () => {
  it('קוד עוזר מתורגם למשפט הקנוני מ-ASSISTANT_ERROR_MESSAGES', () => {
    expect(toHebrewError(new Error('assistant_limit_reached')))
      .toBe(ASSISTANT_ERROR_MESSAGES.assistant_limit_reached);
  });

  it('assistant_provider_timeout אינו נבלע בתבנית ה-timeout הגנרית — הסדר ב-PATTERNS הוא החוזה', () => {
    const text = toHebrewError(new Error('assistant_provider_timeout'));
    expect(text).toBe(ASSISTANT_ERROR_MESSAGES.assistant_provider_timeout);
    expect(text).not.toBe('הפעולה ארכה זמן רב מדי. נסה שוב.');
  });

  it('קוד שנוסף ל-errorCodes.ts נקלט מעצמו — הרשימה מיוצרת, אין רשימה שנייה לתחזק', () => {
    // assistant_persistence_failed נוסף אחרי שה-PATTERNS נכתבו; אם המשפט הקנוני חוזר, ההפקה
    // האוטומטית עובדת וכשל שמירה לא ידווח כהצלחה מחוץ למכסה.
    expect(toHebrewError(new Error('assistant_persistence_failed')))
      .toBe(ASSISTANT_ERROR_MESSAGES.assistant_persistence_failed);
    expect(toHebrewError(new Error('assistant_invalid_request')))
      .toBe(ASSISTANT_ERROR_MESSAGES.assistant_invalid_request);
  });
});

describe('פעולות שיחה', () => {
  it('מחיקת שיחה עוברת דרך ה-definer של 0164 בחתימה המדויקת שלו', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await deleteAssistantConversation('conv-9');
    expect(rpc).toHaveBeenCalledWith('assistant_delete_conversation', { p_conversation_id: 'conv-9' });
  });

  it('משוב נקשר לריצה שהשרת שמר, לא למצב דפדפן', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await sendAssistantFeedback('run-7', true);
    expect(rpc).toHaveBeenCalledWith('assistant_record_feedback', {
      p_run_id: 'run-7',
      p_helpful: true,
      p_note: null,
    });
  });

  it('כשל מחיקה נזרק במקום להיבלע — supabase-js לא זורק לבד', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'not_authorized' } });
    await expect(deleteAssistantConversation('conv-9')).rejects.toThrow('not_authorized');
  });
});

describe('useAssistantConversations — מפתח מטמון מושרש בדייר', () => {
  it('המפתח נפתח ב-org, כך שהחלפת ארגון לעולם לא מגישה שיחות של דייר אחר מהמטמון', async () => {
    limit.mockResolvedValue({ data: [], error: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient },
        createElement(OrgScopeProvider, { org: 'org-a', children }));
    const { result } = renderHook(() => useAssistantConversations(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const keys = queryClient.getQueryCache().getAll().map((entry) => entry.queryKey);
    expect(keys).toContainEqual(['org', 'org-a', 'assistant', 'conversations']);
    expect(from).toHaveBeenCalledWith('assistant_conversations');
  });
});
