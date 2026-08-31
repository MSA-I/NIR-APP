// The impact dialog, with no consumers yet.
//
// What is pinned here is the part a reviewer cannot see by reading the JSX: the three refusal
// states are genuinely different, an unmeasured extent locks the confirm rather than rendering a
// zero, two currencies stay two figures, and the reason is asked for exactly once.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ImpactDialog, type ActionImpact } from './ImpactDialog';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/* Comments blanked before the source scans: the file's own documentation NAMES the patterns it
   refuses ("no second ConfirmDialog", "no Enter shortcut"), and an unstripped scan reads the
   explanation as the offence. Same rule `check-design-tokens.ts` follows. */
const source = readFileSync(join(process.cwd(), 'src/components/ImpactDialog.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const BASE: ActionImpact = {
  actionLabel: 'Approve the override',
  scopeLabel: 'All documents from this supplier',
  affectedCount: 14,
  entityKinds: [{ label: 'documents', count: 11 }, { label: 'invoices', count: 3 }],
  changes: [{ label: 'Category', before: 'General', after: 'Raw materials' }],
  reversible: true,
  effects: [
    { kind: 'recategorise', happens: true, description: 'The category is rewritten on 14 records' },
    { kind: 'amounts', happens: false, description: 'No amount, VAT or balance changes' },
  ],
  warnings: [],
  hardBlockers: [],
  requiresStepUp: false,
};

const impact = (over: Partial<ActionImpact> = {}): ActionImpact => ({ ...BASE, ...over });

function show(props: Partial<Parameters<typeof ImpactDialog>[0]> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const view = render(
    <LocaleProvider>
      <ImpactDialog open onClose={vi.fn()} onConfirm={onConfirm} impact={BASE} {...props} />
    </LocaleProvider>,
  );
  return { ...view, onConfirm };
}

/* `Modal` portals to `document.body`, so the render `container` is EMPTY and any DOM query has to
   go through `ownerDocument` or through `screen`. A `container.querySelector` here returns null for
   the wrong reason and passes a test that measured nothing. */
const confirmButton = () => screen.getByRole('button', { name: /Approve the override|Confirm|Working/ });

beforeEach(() => { vi.clearAllMocks(); });

describe('what the dialog says', () => {
  it('names the scope and the count rather than only the action', async () => {
    show();
    expect(await screen.findByText('All documents from this supplier')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('documents (11) · invoices (3)')).toBeInTheDocument();
  });

  it('shows old beside new for every field it rewrites', async () => {
    show();
    expect(await screen.findByText('General')).toBeInTheDocument();
    expect(screen.getByText('Raw materials')).toBeInTheDocument();
  });

  /**
   * The most useful line before approving is the one about what will NOT change, and it is the
   * half a summary always drops. Both kinds render, and they are distinguished by an icon and by
   * screen-reader text — never by colour alone.
   */
  it('renders the negative effects too, and tells them apart without colour', async () => {
    show();
    expect(await screen.findByText('No amount, VAT or balance changes')).toBeInTheDocument();
    expect(screen.getByText('Will not happen:')).toBeInTheDocument();
    expect(screen.getByText('Will happen:')).toBeInTheDocument();
  });

  it('says plainly when an action cannot be undone', async () => {
    show({ impact: impact({ reversible: false }) });
    expect(await screen.findByText('This action cannot be undone')).toBeInTheDocument();
  });

  it('prefers the caller\u2019s own reversal sentence when it has one', async () => {
    show({ impact: impact({ reversible: true, reversalHint: 'Undo from the supplier log' }) });
    expect(await screen.findByText('Undo from the supplier log')).toBeInTheDocument();
  });
});

describe('the three refusal states, which are not one state', () => {
  it('a warning leaves the confirm LIVE and says the server checks again', async () => {
    show({ impact: impact({ warnings: [{ kind: 'stale_prices', description: 'Two prices changed today' }] }) });
    expect(await screen.findByText('Two prices changed today')).toBeInTheDocument();
    expect(screen.getByText(/The server checks again/)).toBeInTheDocument();
    expect(confirmButton()).toBeEnabled();
  });

  it('a hard blocker LOCKS the confirm and says what stands in the way', async () => {
    show({ impact: impact({ hardBlockers: [{ kind: 'closed_period', description: 'The month is closed — an owner must reopen it' }] }) });
    expect(await screen.findByText('The month is closed — an owner must reopen it')).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  /**
   * THE CASE THE GENERALISATION WOULD HAVE GOT WRONG. `affectedCount: null` is not zero and not
   * "fine": it is an extent nobody measured, and approving an unknown extent is not informed
   * consent. The count renders a dash and the confirm is locked until a refresh measures it.
   */
  it('an unmeasured extent locks the confirm and never renders a zero', async () => {
    const { container } = show({ impact: impact({ affectedCount: null, entityKinds: [] }) });
    await screen.findByText('All documents from this supplier');
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(/could not be measured/)).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('.num')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('a hard blocker outranks a warning, so only the blocking sentence is shown', async () => {
    show({ impact: impact({
      warnings: [{ kind: 'w', description: 'A warning nobody needs to read now' }],
      hardBlockers: [{ kind: 'b', description: 'The blocker' }],
    }) });
    expect(await screen.findByText('The blocker')).toBeInTheDocument();
    expect(screen.queryByText('A warning nobody needs to read now')).toBeNull();
  });
});

describe('money', () => {
  it('keeps two currencies as two figures and never sums them', async () => {
    const { container } = show({ impact: impact({ amounts: [
      { currency: 'ILS', amount: 12400 },
      { currency: 'USD', amount: 3100 },
    ] }), baseCurrency: 'ILS' });
    await screen.findByText('All documents from this supplier');
    const figures = [...container.ownerDocument.querySelectorAll('.num')].map((n) => n.textContent ?? '');
    expect(figures.some((f) => f.includes('12,400'))).toBe(true);
    expect(figures.some((f) => f.includes('3,100'))).toBe(true);
    expect(figures.join(' ')).not.toContain('15,500');
  });
});

describe('the reason, and the confirmation itself', () => {
  it('asks for a reason once, and hands it on already resolved', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    show({ onConfirm });
    const boxes = await screen.findAllByLabelText(/Reason \(optional/);
    expect(boxes).toHaveLength(1);
    await user.type(boxes[0], 'agreed with the supplier');
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith('agreed with the supplier');
  });

  /**
   * `#299` — an empty box never holds the button, and the ledger still gets a sentence naming the
   * action rather than a forced "asdf".
   */
  it('confirms with an empty box, and the ledger still gets a sentence', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    show({ onConfirm });
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toContain('Approve the override');
    expect(onConfirm.mock.calls[0][0]).not.toBe('');
  });

  it('a busy dialog cannot be confirmed twice', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    show({ onConfirm, busy: true });
    await waitFor(() => expect(confirmButton()).toBeDisabled());
    await user.click(confirmButton()).catch(() => {});
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a refusal in place rather than closing over it', async () => {
    show({ error: 'The state changed while you were reading' });
    expect(await screen.findByText('The state changed while you were reading')).toBeInTheDocument();
  });
});

describe('the shape of the thing', () => {
  it('renders a skeleton, not a spinner, while the impact loads', async () => {
    const { container } = show({ impact: null });
    await waitFor(() => expect(container.ownerDocument.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(confirmButton()).toBeDisabled();
  });

  /** `useDialogLayer` is the only focus/Esc/stack engine in the product. There is not a second. */
  it('owns no key handling of its own', () => {
    expect(source).not.toContain("addEventListener('keydown'");
    expect(source).not.toContain('onKeyDown');
  });

  /**
   * No dialog in the product confirms on Enter. Adding one here would put a fast path on the most
   * consequential button in the app.
   */
  it('has no Enter-to-confirm shortcut', () => {
    expect(source).not.toMatch(/key\s*===\s*'Enter'|'Enter'/);
  });

  /** Nothing here is a second `ConfirmDialog`: confirming performs the action. */
  it('does not stack another confirmation behind itself', () => {
    expect(source).not.toContain('ConfirmDialog');
  });

  /**
   * PR-2 asserted ZERO consumers, because that is what made it a clean revert. PR-3 adopts it on
   * the invoice three-way override — a live money screen — and the assertion changes SHAPE rather
   * than being deleted: the dialog is adopted one screen at a time, deliberately, so a second
   * adoption arriving without its own review fails here.
   *
   * The plan is explicit that the 46 `ConfirmDialog` call sites are NOT to be converted.
   *
   * Read off disk rather than shelled out to `git grep`: a newline inside a shell string is one
   * escaping mistake away from an unterminated literal, and this needs no shell at all.
   */
  it('is adopted on exactly one screen, and that screen is the three-way override', () => {
    const roots = ['src/pages', 'src/components', 'src/operator', 'src/portal'];
    const consumers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(entry.name) || entry.name === 'impactDialog.spec.tsx') continue;
        if (/from '[^']*\/ImpactDialog'/.test(readFileSync(join(process.cwd(), rel), 'utf8'))) {
          consumers.push(rel);
        }
      }
    };
    roots.forEach(walk);
    expect(consumers.sort()).toEqual(['src/pages/InvoiceDetail.tsx']);
  });
});
