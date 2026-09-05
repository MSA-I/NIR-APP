import { he } from '../i18n/dictionaries/he';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askAssistant,
  deleteAssistantConversation,
  loadAssistantConversation,
  sendAssistantFeedback,
  useAssistantConversations,
} from './client';
import { type AssistantRunResult } from './contracts';
import { toHebrewError } from '../errors';
import { OrgScopeProvider } from '../query/orgScope';

const invoke = vi.fn();
const rpc = vi.fn();
const limit = vi.fn();
const single = vi.fn();
const eq = vi.fn((..._args: unknown[]) => ({ single: (...args: unknown[]) => single(...args) }));
const order = vi.fn((..._args: unknown[]) => ({ limit: (...args: unknown[]) => limit(...args) }));
const select = vi.fn((..._args: unknown[]) => ({
  order: (...args: unknown[]) => order(...args),
  eq: (...args: unknown[]) => eq(...args),
}));
const from = vi.fn((..._args: unknown[]) => ({ select: (...args: unknown[]) => select(...args) }));

vi.mock('../supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

const emptyRun: AssistantRunResult = {
  run_id: '11111111-1111-4111-8111-111111111111',
  conversation_id: null,
  answer: { blocks: [{ type: 'text', text: 'אין חריגות פתוחות' }], next_steps: [], no_answer_reason: null },
  facts: [],
  sources: [],
  tools_used: [],
  complete: true,
  as_of: '2026-08-20T00:00:00.000Z',
  proposal: null,
};

const invoiceFact = {
  id: 'f1',
  kind: 'invoice.total' as const,
  subject: { entity: 'invoice' as const, id: 'invoice-1' },
  label: 'סכום חשבונית',
  value: 50,
  unit: 'ils' as const,
  tool: 'explain_invoice_block',
  as_of: '2026-08-20T00:00:00.000Z',
  classification: 'financial_sensitive' as const,
};

const invoiceSource = {
  id: 's1',
  entity: 'invoice' as const,
  entity_id: 'invoice-1',
  label: 'חשבונית',
  route: '/invoices/invoice-1',
  classification: 'financial_sensitive' as const,
};

const supportedRun: AssistantRunResult = {
  ...emptyRun,
  answer: {
    blocks: [{
      type: 'claim',
      text: 'סכום החשבונית הוא 50 שקלים.',
      claim_kind: 'invoice.total',
      subject: { entity: 'invoice', id: 'invoice-1' },
      claim_unit: 'ils',
      claim_value: 50,
      fact_ids: ['f1'],
      source_ids: ['s1'],
    }],
    next_steps: [],
    no_answer_reason: null,
  },
  facts: [invoiceFact],
  sources: [invoiceSource],
  tools_used: [{ tool: 'explain_invoice_block', complete: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('askAssistant', () => {
  it('שולח את הבקשה לפונקציית assistant ומחזיר את המעטפה כפי שהשרת הנפיק אותה — הלקוח לא מחשב דבר', async () => {
    invoke.mockResolvedValue({ data: emptyRun, error: null });
    const request = { question: 'מה מצב החשבוניות?', conversation_id: null, route: '/dashboard', locale: 'en' as const };
    const result = await askAssistant(request);
    expect(invoke).toHaveBeenCalledWith('assistant', { body: request });
    expect(result).toEqual(emptyRun);
  });

  it.each([
    ['מעטפה עם שדה לא מוכר', { ...emptyRun, arbitrary: true }],
    ['answer שאינו עומד בחוזה', {
      ...emptyRun,
      answer: { ...emptyRun.answer, blocks: [{ type: 'text', text: 'נמצאו 2 חריגות' }] },
    }],
    ['fact שאינו עומד בחוזה', {
      ...emptyRun,
      facts: [{
        id: 'f1',
        kind: 'invoice.total',
        subject: null,
        label: 'סכום חשבונית',
        value: { amount: 50 },
        unit: 'ils',
        tool: 'explain_invoice_block',
        as_of: '2026-08-20T00:00:00.000Z',
        classification: 'financial_sensitive',
      }],
    }],
    ['source שאינו עומד בחוזה', {
      ...emptyRun,
      sources: [{
        id: 's1',
        entity: 'invoice',
        entity_id: 'invoice-1',
        label: ['חשבונית'],
        route: '/invoices/invoice-1',
        classification: 'tenant_standard',
      }],
    }],
    ['route חיצוני בתוך source', {
      ...emptyRun,
      sources: [{
        id: 's1',
        entity: 'invoice',
        entity_id: 'invoice-1',
        label: 'חשבונית',
        route: 'https://attacker.invalid/invoices/invoice-1',
        classification: 'tenant_standard',
      }],
    }],
    ['מזהה Fact כפול', {
      ...supportedRun,
      facts: [invoiceFact, { ...invoiceFact }],
    }],
    ['מזהה Source כפול', {
      ...supportedRun,
      sources: [invoiceSource, { ...invoiceSource }],
    }],
    ['claim שמפנה ל-Fact שלא הונפק', {
      ...supportedRun,
      answer: {
        ...supportedRun.answer,
        blocks: [{ ...supportedRun.answer.blocks[0], fact_ids: ['missing-fact'] }],
      },
    }],
    ['claim שמפנה ל-Source שלא הונפק', {
      ...supportedRun,
      answer: {
        ...supportedRun.answer,
        blocks: [{ ...supportedRun.answer.blocks[0], source_ids: ['missing-source'] }],
      },
    }],
    ['Fact קשור שאינו תומך בערך הסמנטי של ה-claim', {
      ...supportedRun,
      answer: {
        ...supportedRun.answer,
        blocks: [{
          ...supportedRun.answer.blocks[0],
          text: 'סכום החשבונית הוא 51 שקלים.',
          claim_value: 51,
        }],
      },
    }],
    ['complete שסותר את תוצאות הכלים', {
      ...supportedRun,
      tools_used: [{ tool: 'explain_invoice_block', complete: false }],
      complete: true,
    }],
  ])('נכשל סגור על 2xx פגום: %s', async (_case, malformed) => {
    invoke.mockResolvedValue({ data: malformed, error: null });

    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null, locale: null }))
      .rejects.toThrow('assistant_unsupported_answer');
  });

  it('חושף את קוד הסירוב מגוף התשובה — supabase-js בולע את הגוף ב-non-2xx, והקוד הוא מה שממופה לעברית אחת', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { json: async () => ({ error: { code: 'assistant_limit_reached' } }) },
      }),
    });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null, locale: null }))
      .rejects.toThrow('assistant_limit_reached');
  });

  it('סירוב שמגיע בגוף 2xx (מוסכמת send-feedback) נזרק גם הוא כקוד, לא מדווח כהצלחה', async () => {
    invoke.mockResolvedValue({ data: { error: { code: 'assistant_disabled' } }, error: null });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null, locale: null }))
      .rejects.toThrow('assistant_disabled');
  });

  it('401 חשוף בגוף ריק הוא השער (verify_jwt) שדחה טוקן לפני הקוד שלנו — ממופה ל-assistant_unauthenticated, לא למשפט הגנרי', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: { status: 401, json: async () => { throw new Error('empty body'); } },
      }),
    });
    await expect(askAssistant({ question: 'שאלה', conversation_id: null, route: null, locale: null }))
      .rejects.toThrow('assistant_unauthenticated');
    expect(toHebrewError(new Error('assistant_unauthenticated')))
      .toBe(he.errors.assistant_unauthenticated);
  });
});

describe('מילון השגיאות — ניסוח אחד, לא שניים', () => {
  it('קוד עוזר מתורגם למשפט הקנוני מ-ASSISTANT_ERROR_MESSAGES', () => {
    expect(toHebrewError(new Error('assistant_limit_reached')))
      .toBe(he.errors.assistant_limit_reached);
  });

  it('assistant_provider_timeout אינו נבלע בתבנית ה-timeout הגנרית — הסדר ב-PATTERNS הוא החוזה', () => {
    const text = toHebrewError(new Error('assistant_provider_timeout'));
    expect(text).toBe(he.errors.assistant_provider_timeout);
    expect(text).not.toBe('הפעולה ארכה זמן רב מדי. נסה שוב.');
  });

  it('קוד שנוסף ל-errorCodes.ts נקלט מעצמו — הרשימה מיוצרת, אין רשימה שנייה לתחזק', () => {
    // assistant_persistence_failed נוסף אחרי שה-PATTERNS נכתבו; אם המשפט הקנוני חוזר, ההפקה
    // האוטומטית עובדת וכשל שמירה לא ידווח כהצלחה מחוץ למכסה.
    expect(toHebrewError(new Error('assistant_persistence_failed')))
      .toBe(he.errors.assistant_persistence_failed);
    expect(toHebrewError(new Error('assistant_invalid_request')))
      .toBe(he.errors.assistant_invalid_request);
  });
});

describe('פעולות שיחה', () => {
  it('פתיחת בדיקה קודמת עוברת רק דרך Edge שמבצע reauthorization ומפרש מעטפה סגורה', async () => {
    // The whole conversation, oldest turn first — the Edge used to answer with only the newest
    // turn, which is what made a stored conversation not worth reopening.
    const turns = [
      {
        question: 'מה מצב החשבונית?',
        result: { ...emptyRun, conversation_id: '22222222-2222-4222-8222-222222222222' },
      },
      {
        question: 'ומה נשאר לשלם עליה?',
        result: {
          ...emptyRun,
          run_id: '33333333-3333-4333-8333-333333333333',
          conversation_id: '22222222-2222-4222-8222-222222222222',
        },
      },
    ];
    invoke.mockResolvedValue({ data: { turns }, error: null });

    await expect(loadAssistantConversation('22222222-2222-4222-8222-222222222222'))
      .resolves.toEqual(turns);
    expect(invoke).toHaveBeenCalledWith('assistant', {
      body: {
        operation: 'history_load',
        conversation_id: '22222222-2222-4222-8222-222222222222',
      },
    });
  });

  it('מעטפת history בת תור אחד עדיין נטענת כשיחה בת תור אחד', async () => {
    const turns = [{
      question: 'מה מצב החשבונית?',
      result: { ...emptyRun, conversation_id: '22222222-2222-4222-8222-222222222222' },
    }];
    invoke.mockResolvedValue({ data: { turns }, error: null });

    await expect(loadAssistantConversation('22222222-2222-4222-8222-222222222222'))
      .resolves.toEqual(turns);
  });

  // The old shape is not accepted as a courtesy: a bare `{question, result}` would silently drop
  // every earlier turn, which is the defect this replaced.
  it('המעטפה הישנה של תור בודד נדחית ולא מתפרשת כשיחה', async () => {
    invoke.mockResolvedValue({
      data: {
        question: 'מה מצב החשבונית?',
        result: { ...emptyRun, conversation_id: '22222222-2222-4222-8222-222222222222' },
      },
      error: null,
    });

    await expect(loadAssistantConversation('22222222-2222-4222-8222-222222222222'))
      .rejects.toThrow('assistant_unsupported_answer');
  });

  it('פתיחת history נכשלת סגור אם ה-Edge החזיר shape לא מוכר', async () => {
    invoke.mockResolvedValue({ data: { question: 'שאלה', result: { arbitrary: true } }, error: null });
    await expect(loadAssistantConversation('22222222-2222-4222-8222-222222222222'))
      .rejects.toThrow('assistant_unsupported_answer');
  });

  it('מחיקת שיחה עוברת דרך ה-definer של 0164 בחתימה המדויקת שלו', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await deleteAssistantConversation('conv-9');
    expect(rpc).toHaveBeenCalledWith('assistant_delete_conversation', { p_conversation_id: 'conv-9' });
  });

  it('משוב עם הערה נקשר לריצה, ואז נקרא חזרה מהמסד לפני אישור בממשק', async () => {
    rpc.mockResolvedValue({ data: { feedback_id: 'feedback-7' }, error: null });
    single.mockResolvedValue({
      data: { rating: 'not_helpful', note: 'הסכום אינו תואם למסמך' }, error: null,
    });
    await expect(sendAssistantFeedback('run-7', false, '  הסכום אינו תואם למסמך  '))
      .resolves.toEqual({ helpful: false, note: 'הסכום אינו תואם למסמך' });
    expect(rpc).toHaveBeenCalledWith('assistant_record_feedback', {
      p_run_id: 'run-7',
      p_helpful: false,
      p_note: 'הסכום אינו תואם למסמך',
    });
    expect(from).toHaveBeenCalledWith('assistant_feedback');
    expect(select).toHaveBeenCalledWith('rating, note');
    expect(eq).toHaveBeenCalledWith('run_id', 'run-7');
  });

  it('כשל מחיקה נזרק במקום להיבלע — supabase-js לא זורק לבד', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'not_authorized' } });
    await expect(deleteAssistantConversation('conv-9')).rejects.toThrow('not_authorized');
  });
});

describe('useAssistantConversations — מפתח מטמון מושרש בדייר', () => {
  it('המפתח נפתח ב-org, כך שהחלפת ארגון לעולם לא מגישה שיחות של דייר אחר מהמטמון', async () => {
    invoke.mockResolvedValue({ data: { conversations: [] }, error: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient },
        createElement(OrgScopeProvider, { org: 'org-a', children }));
    const { result } = renderHook(() => useAssistantConversations('actor-owner-active'), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const keys = queryClient.getQueryCache().getAll().map((entry) => entry.queryKey);
    expect(keys).toContainEqual(['org', 'org-a', 'assistant', 'conversations', 'actor-owner-active']);
    expect(invoke).toHaveBeenCalledWith('assistant', {
      body: { operation: 'history_list', limit: 10 },
    });
    expect(from).not.toHaveBeenCalled();
  });
});
