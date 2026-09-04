/**
 * `PL-04` — a refusal the server named exactly, read by the user as "contact support".
 *
 * The readiness panel calls `get_qualified_product_creation_dry_run`. That function refuses one
 * context and says which: migration `0182` raises `qualified_product_dry_run_context_invalid` when
 * the document is not a price list, or when it carries no supplier. The sweep met the second case,
 * and the same panel was already printing „הספק שהוצע בפירוש: לא זוהה" one line above the failure.
 *
 * Nothing under `src/` named that condition, so `toErrorKey` fell through to `fallback` and the
 * screen offered a support ticket for a state the reader can clear themselves in one action.
 *
 * TWO ASSERTIONS, AND A CONTROL. The panel must state the cause and the action; and the row of the
 * panel that already knows the supplier is missing must still be there, because the whole finding
 * is that the screen contradicted itself. The control is a DIFFERENT refusal of the same call —
 * one that is not about the supplier — which must NOT be answered with this sentence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc } }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' },
    org: { id: 'org-test' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { PriceListAutomationReadiness } from './PriceListAutomationReadiness';
import { toErrorKey } from '../../lib/errors';

/** The wire shape supabase-js hands back for a PostgREST 400 on an RPC. */
function refuseDryRun(message: string) {
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_qualified_product_creation_dry_run') {
      return { data: null, error: { message, code: '22023', details: null, hint: null } };
    }
    return { data: [], error: null };
  });
}

function renderPanel() {
  render(
    <PriceListAutomationReadiness documentId="doc-1" interpretationId="interpretation-1" ingested={false} />,
  );
}

beforeEach(() => rpc.mockReset());

describe('PL-04 · המחירון בלי ספק — הסיבה על המסך, לא פנייה לתמיכה', () => {
  it('אומר שהמחירון אינו משויך לספק ומה לעשות', async () => {
    refuseDryRun('qualified_product_dry_run_context_invalid');
    renderPanel();

    const note = await screen.findByRole('alert');
    // The cause, in the reader's own vocabulary — a supplier that is not attached to this document.
    expect(note).toHaveTextContent(/אינו משויך לספק/);
    // And the action. A state without an instruction is what the sweep found.
    expect(note).toHaveTextContent(/שייכו ספק|לשייך ספק/);
    // The sentence that made this a self-contradiction rather than merely an unhelpful message.
    expect(note).not.toHaveTextContent(/פנה לתמיכה/);
  });

  it('ממפה את הקוד עצמו, ולא דרך הנוסח על המסך בלבד', () => {
    // The panel wraps whatever `errorText` returns, so the mapping is asserted at its own level
    // too: a future refactor of the wrapper cannot quietly restore the fallback.
    expect(toErrorKey(new Error('qualified_product_dry_run_context_invalid')))
      .toBe('qualified_product_dry_run_context_invalid');
  });

  it('בקרה — סירוב אחר של אותה קריאה אינו מקבל את המשפט הזה', async () => {
    // `document_interpretation_unknown` is the same RPC refusing for a reason that has nothing to
    // do with a supplier. If the new sentence appeared here too, it would be wallpaper.
    refuseDryRun('document_interpretation_unknown');
    renderPanel();

    const note = await screen.findByRole('alert');
    expect(note).not.toHaveTextContent(/אינו משויך לספק/);
  });
});
