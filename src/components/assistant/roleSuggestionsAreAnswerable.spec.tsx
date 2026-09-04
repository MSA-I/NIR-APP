/**
 * ASSIST-04 — a suggested opening the asking role cannot have answered.
 *
 * The accountant's panel offered "כמה חשבוניות נקלטו ב־7 הימים האחרונים?". Only
 * `get_business_summary` answers reception in a trailing window — `docs/ASSISTANT.md` §7.2 marks
 * the accountant `NOT_PERMITTED` there — and §7.3 records the trap beside it: the accountant MAY
 * run `get_purchase_metrics`, which measures purchase by `invoice_date` rather than reception by
 * `received_date`. So the two outcomes were a refusal the person reads as the assistant being
 * broken, or a confident answer to a different question. Clicking an opening SENDS it, so neither
 * is a thing a person chose.
 *
 * THE FIX IS THE SUGGESTION, NEVER THE BOUNDARY. `requiredRoles` is a role-scope decision that
 * lives with the tool; a panel is not the place to widen one to make its own menu work. This spec
 * therefore reads the roles OUT OF THE EDGE TOOL SOURCES rather than restating them, so it fails
 * either way round: an opening put in the wrong list, or a tool whose roles narrow later.
 *
 * Two halves, deliberately:
 *   1. the table — every opening every role is offered names a tool that role may run;
 *   2. the screen — the accountant's panel really renders those six sentences, so the table is
 *      not a document beside the product.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { he } from '../../lib/i18n/dictionaries/he';
import { translate } from '../../lib/i18n/t';
import { EXAMPLE_ANSWERED_BY, ROLE_EXAMPLE_KEYS } from './roleExamples';

const TOOLS_DIR = resolve(process.cwd(), 'supabase/functions/assistant/tools');

/**
 * `requiredRoles` as the server actually declares it, read from the tool sources.
 *
 * A tool file is `name: "x", ... requiredRoles: [...]` in one object literal, so the roles are
 * taken from the first `requiredRoles` that follows the `name`. Test files in the same directory
 * assert on `requiredRoles` too and would poison the map, so only the modules that DECLARE a
 * tool name are read.
 */
function declaredRoles(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = readFileSync(resolve(TOOLS_DIR, file), 'utf8');
    const pattern = /name:\s*"([a-z_]+)"[\s\S]*?requiredRoles:\s*\[([^\]]*)\]/g;
    for (const [, name, roles] of source.matchAll(pattern)) {
      if (map.has(name)) continue;
      map.set(name, [...roles.matchAll(/"([a-z]+)"/g)].map(([, role]) => role));
    }
  }
  return map;
}

const ROLES = declaredRoles();

describe('ASSIST-04 — the openings are answerable by the role that is offered them', () => {
  it('reads the tool roles it is about to judge by, so a silent empty map cannot pass', () => {
    // The named controls: one all-roles tool, one owner/office tool, one owner/accountant tool.
    expect(ROLES.get('get_open_alerts')).toEqual(['owner', 'office', 'accountant']);
    expect(ROLES.get('get_business_summary')).toEqual(['owner', 'office']);
    expect(ROLES.get('get_unmatched_bank_transactions')).toEqual(['owner', 'accountant']);
    expect(ROLES.size).toBeGreaterThanOrEqual(13);
  });

  it('names a real tool for every opening, and no opening is left unmapped', () => {
    for (const [role, keys] of Object.entries(ROLE_EXAMPLE_KEYS)) {
      for (const key of keys) {
        const tool = EXAMPLE_ANSWERED_BY[key];
        expect(tool, `${role}: ${key} has no tool in EXAMPLE_ANSWERED_BY`).toBeTruthy();
        expect(ROLES.has(tool!), `${role}: ${key} names an unknown tool ${tool}`).toBe(true);
      }
    }
  });

  for (const role of ['owner', 'office', 'accountant'] as const) {
    it(`offers ${role} nothing but questions ${role} may have answered`, () => {
      const refused = ROLE_EXAMPLE_KEYS[role]
        .filter((key) => !(ROLES.get(EXAMPLE_ANSWERED_BY[key]!) ?? []).includes(role))
        .map((key) => `${translate(he, key)}  ->  ${EXAMPLE_ANSWERED_BY[key]} (${(ROLES.get(EXAMPLE_ANSWERED_BY[key]!) ?? []).join('/')})`);
      expect(refused).toEqual([]);
    });
  }
});

/* ---- the second half: what the panel actually puts on the accountant's screen ---- */

let currentRole: 'owner' | 'office' | 'accountant' = 'accountant';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { role: currentRole } }),
}));

vi.mock('../../lib/flags', () => ({
  useFeatureFlags: () => ({
    flags: null,
    isEnabled: (key: string) => key === 'assistant.ui',
    loading: false,
    error: null,
    refetch: async () => true,
  }),
}));

vi.mock('../../lib/assistant/client', () => ({
  askAssistant: vi.fn(),
  sendAssistantFeedback: vi.fn(),
  loadAssistantConversation: vi.fn(),
  deleteAssistantConversation: vi.fn(),
  useAssistantConversations: () => ({
    data: [], loading: false, fetching: false, error: null, refetch: async () => true,
  }),
}));

const AssistantPanel = (await import('../AssistantPanel')).default;

describe('ASSIST-04 — the accountant\'s panel, rendered', () => {
  beforeEach(() => {
    currentRole = 'accountant';
    // jsdom has neither of these and the panel needs both: the dialog picks desktop vs. mobile
    // off a media query, and `useDialogLayer` refuses to trap focus in boxes it cannot measure.
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  });

  it('offers only openings whose tool the accountant may run', async () => {
    render(<MemoryRouter><AssistantPanel /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /העוזר של InPlace/ }));
    const offered = ROLE_EXAMPLE_KEYS.accountant.map((key) => translate(he, key));
    // Every one is on screen: the table describes the product rather than sitting beside it.
    for (const sentence of offered) {
      expect(screen.getByRole('button', { name: sentence })).toBeTruthy();
    }
    // And none of them is answered by a tool that would refuse this role.
    for (const key of ROLE_EXAMPLE_KEYS.accountant) {
      expect(
        ROLES.get(EXAMPLE_ANSWERED_BY[key]!),
        `on screen: ${translate(he, key)} -> ${EXAMPLE_ANSWERED_BY[key]}`,
      ).toContain('accountant');
    }
  });

  /**
   * The control, green in both runs: the reception question is a real question and the product
   * still answers it for the roles whose tool answers it. The defect was never the sentence.
   */
  it('leaves the owner\'s and office\'s own openings alone', () => {
    expect(ROLE_EXAMPLE_KEYS.owner).toHaveLength(6);
    expect(ROLE_EXAMPLE_KEYS.office).toHaveLength(6);
    expect(ROLE_EXAMPLE_KEYS.owner).toContain('assistantDialog.exampleBusinessPicture');
    expect(ROLES.get('get_business_summary')).toContain('owner');
  });
});
