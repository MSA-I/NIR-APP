import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../lib/i18n/LocaleProvider';
import { ASSISTANT_ERROR_CODES } from '../../lib/assistant/errorCodes';
import * as ErrorCodes from '../../lib/assistant/errorCodes';
import * as AssistantPanelModule from '../AssistantPanel';
import * as AssistantDialogModule from './AssistantDialog';

const askAssistant = vi.hoisted(() => vi.fn());

vi.mock('../../lib/assistant/client', () => ({
  askAssistant,
  deleteAssistantConversation: vi.fn(),
  listAssistantConversations: vi.fn(async () => []),
  loadAssistantConversation: vi.fn(async () => []),
  useAssistantConversations: () => ({ data: [], loading: false, error: null, refetch: vi.fn() }),
}));

import { useAssistantRunSession } from '../../lib/assistant/runSession';

const wrapper = ({ children }: { children: ReactNode }) => (
  <LocaleProvider initialLocale="he">{children}</LocaleProvider>
);

describe('P9a — assistant recovery', () => {
  beforeEach(() => askAssistant.mockReset());

  it('puts a failed suggested question back in the composer and retries without a reload', async () => {
    askAssistant
      .mockRejectedValueOnce(new Error('assistant_provider_timeout'))
      .mockResolvedValueOnce({
        run_id: '11111111-1111-4111-8111-111111111111',
        conversation_id: '22222222-2222-4222-8222-222222222222',
        answer: { blocks: [], next_steps: [], no_answer_reason: 'not_measured' },
        facts: [], sources: [], tools_used: [], complete: false,
        as_of: '2026-09-05T09:00:00+03:00', proposal: null,
      });
    const { result } = renderHook(() => useAssistantRunSession('actor-org-owner'), { wrapper });
    const suggestion = 'מה דורש טיפול עכשיו?';

    await act(() => result.current.submit('/dashboard', suggestion));
    expect(result.current.question).toBe(suggestion);
    expect(result.current.submittedQuestion).toBe(suggestion);

    await act(() => result.current.submit('/dashboard'));
    expect(askAssistant).toHaveBeenCalledTimes(2);
    expect(askAssistant.mock.calls[1]![0]).toMatchObject({ question: suggestion });
    expect(result.current.question).toBe('');
  });

  it('auto-restores only a valid conversation updated no more than ten minutes ago', () => {
    const freshness = (AssistantPanelModule as unknown as {
      assistantConversationIsFresh?: (updatedAt: string, nowMs: number) => boolean;
    }).assistantConversationIsFresh;
    expect(freshness).toBeTypeOf('function');
    const now = Date.parse('2026-09-05T09:10:00Z');
    expect(freshness!('2026-09-05T09:00:00Z', now)).toBe(true);
    expect(freshness!('2026-09-05T08:59:59.999Z', now)).toBe(false);
    expect(freshness!('2026-09-05T09:10:00.001Z', now)).toBe(false);
    expect(freshness!('not-a-date', now)).toBe(false);
  });

  it('uses usage questions for an empty business and data questions after business data exists', () => {
    const examplesFor = (AssistantDialogModule as unknown as {
      assistantExampleKeysFor?: (
        role: 'owner' | 'office' | 'accountant', hasBusinessData: boolean,
      ) => readonly string[];
    }).assistantExampleKeysFor;
    expect(examplesFor).toBeTypeOf('function');
    for (const role of ['owner', 'office', 'accountant'] as const) {
      const usage = examplesFor!(role, false);
      const data = examplesFor!(role, true);
      expect(usage.length).toBeGreaterThan(0);
      expect(data.length).toBeGreaterThan(0);
      expect(usage).not.toEqual(data);
      expect(usage.every((key) => key.includes('HowTo'))).toBe(true);
      expect(data.some((key) => !key.includes('HowTo'))).toBe(true);
    }
  });

  it('classifies every canonical error into an explicit recovery affordance', () => {
    const matrix = (ErrorCodes as unknown as {
      ASSISTANT_ERROR_RECOVERY?: Record<string, string>;
    }).ASSISTANT_ERROR_RECOVERY;
    expect(matrix).toBeTypeOf('object');
    expect(Object.keys(matrix!).sort()).toEqual([...ASSISTANT_ERROR_CODES].sort());
    expect(Object.values(matrix!).every((value) =>
      ['retry', 'edit', 'sign_in', 'use_screens', 'new_check', 'none'].includes(value))).toBe(true);
  });
});

describe('P9d — assistant surface stays useful without decorative glass', () => {
  const dialogSource = readFileSync('src/components/assistant/AssistantDialog.tsx', 'utf8');
  const panelSource = readFileSync('src/components/AssistantPanel.tsx', 'utf8');
  const cssSource = readFileSync('src/index.css', 'utf8');
  const assistantCss = cssSource.slice(
    cssSource.indexOf('/* Assistant B'),
    cssSource.indexOf('.dialog-backdrop-safe'),
  );

  it('keeps the floating panel and removes glass, drifting gradients and decorative light bodies', () => {
    expect(panelSource).toContain('<AssistantDialog');
    expect(dialogSource).toContain('data-assistant-mode');
    expect(cssSource).toContain('.assistant-surface[data-assistant-mode="docked"]');
    expect(dialogSource).not.toContain('ASSISTANT_MOTES');
    expect(dialogSource).not.toContain('assistant-gradient');
    expect(dialogSource).not.toContain('assistant-mote');
    expect(assistantCss).not.toContain('backdrop-filter');
    expect(assistantCss).not.toContain('@keyframes assistant-drift');
    expect(assistantCss).not.toContain('@keyframes assistant-rise');
    expect(assistantCss).not.toContain('#main reserves');
  });

  it('does not add AI disclosure and uses a creation icon for a new check', () => {
    expect(dialogSource).not.toMatch(/נוצר(?:ה)? (?:ב|באמצעות)[־ -]?(?:AI|בינה מלאכותית)/);
    expect(dialogSource).not.toContain('RotateCcw');
    expect(dialogSource).toContain('<Plus');
  });
});
