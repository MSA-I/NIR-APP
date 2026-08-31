import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReasonField } from './ui';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/**
 * The one reason box.
 *
 * Five screens had grown their own copy, and two of them had drifted in ways nobody chose: the
 * role-change dialog used a single-line `<input>` with NO bound, and the document-review decision
 * spelled its own class list with no focus ring. Both were invisible precisely because the copies
 * were never compared to each other — so the guard here is the comparison, not the component.
 */

function renderField(props: Partial<Parameters<typeof ReasonField>[0]> = {}) {
  return render(
    <LocaleProvider>
      <ReasonField label="סיבה (רשות)" value="" onChange={vi.fn()} {...props} />
    </LocaleProvider>,
  );
}

const source = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

describe('ReasonField', () => {
  it('pairs its label with the control, so getByLabelText reaches it', () => {
    renderField();
    expect(screen.getByLabelText('סיבה (רשות)')).toBeInTheDocument();
  });

  it('is a textarea, because a reason is prose and lands in audit_logs', () => {
    renderField();
    expect(screen.getByLabelText('סיבה (רשות)').tagName).toBe('TEXTAREA');
  });

  /**
   * The bound is read from the DOM rather than imported. A caller that can import the constant is
   * a caller that can re-state it, and re-stating it per screen is exactly the drift this replaced.
   */
  it('declares the 1000-character bound itself', () => {
    renderField();
    expect(screen.getByLabelText('סיבה (רשות)')).toHaveAttribute('maxlength', '1000');
  });

  it('uses the shared .input utility, which is what carries the focus ring', () => {
    renderField();
    expect(screen.getByLabelText('סיבה (רשות)')).toHaveClass('input');
  });

  it('takes a stable id where a test or the browser gate names the field', () => {
    renderField({ id: 'review-reason' });
    expect(screen.getByLabelText('סיבה (רשות)')).toHaveAttribute('id', 'review-reason');
  });

  it('generates an id when the caller does not name one, so two boxes never collide', () => {
    const { container } = render(
      <LocaleProvider>
        <ReasonField label="ראשונה" value="" onChange={vi.fn()} />
        <ReasonField label="שנייה" value="" onChange={vi.fn()} />
      </LocaleProvider>,
    );
    const ids = [...container.querySelectorAll('textarea')].map((node) => node.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('reports what was typed, not the event', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderField({ onChange });
    await user.type(screen.getByLabelText('סיבה (רשות)'), 'א');
    expect(onChange).toHaveBeenCalledWith('א');
  });

  it('carries a placeholder only where the caller gave one', () => {
    renderField({ placeholder: 'לדוגמה: עדכון תפקיד' });
    expect(screen.getByLabelText('סיבה (רשות)')).toHaveAttribute('placeholder', 'לדוגמה: עדכון תפקיד');
    renderField();
    expect(screen.getAllByLabelText('סיבה (רשות)')[1]).not.toHaveAttribute('placeholder');
  });
});

/**
 * The extraction itself, asserted on the source. Rendering each of the five screens would prove
 * that they still work; only reading them proves that they stopped keeping their own copy — which
 * is the claim PR-1 actually makes.
 */
describe('the five reason sites', () => {
  const sites = [
    ['components/ui.tsx', 'ConfirmDialog'],
    ['components/ReauthModal.tsx', 'the step-up dialog'],
    ['components/document-review/DocumentAssessmentPanel.tsx', 'the document-review decision'],
    ['pages/Exceptions.tsx', 'the exception resolution note'],
    ['pages/Settings.tsx', 'the role-change dialog'],
  ] as const;

  it.each(sites)('%s (%s) renders ReasonField', (path) => {
    expect(source(path)).toContain('<ReasonField');
  });

  /**
   * `maxLength` is declared once. This is the criterion the plan states for PR-1, and it is worth
   * asserting rather than describing: the whole failure being repaired here is five hand-written
   * copies of a bound that only agreed by accident — and one that did not agree at all.
   */
  it.each(sites)('%s no longer states a maxLength of its own', (path) => {
    expect(source(path)).not.toContain('maxLength={1000}');
  });

  it('leaves exactly one declaration of the bound, inside ui.tsx', () => {
    const ui = source('components/ui.tsx');
    expect(ui.match(/REASON_MAX_LENGTH/g) ?? []).toHaveLength(2); // the const, and its one use
    expect(ui).toContain('const REASON_MAX_LENGTH = 1000;');
  });

  /**
   * The bound does NOT spread to free-form notes. An invoice note and a supplier note are business
   * content, not justifications, and truncating them would be worse than an unbounded box — so a
   * later agent reading "one reason box" must not go capping those too.
   */
  it('leaves free-form notes uncapped', () => {
    for (const path of ['pages/InvoiceNew.tsx', 'pages/Products.tsx', 'pages/Suppliers.tsx']) {
      expect(source(path)).not.toContain('maxLength={1000}');
    }
  });
});
