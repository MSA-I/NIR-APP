import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { ToastProvider } from './ui';

/**
 * Real supabase-js against the MSW base URL, exactly as notificationPreferences.spec.tsx does:
 * the assertions here are about the request this dialog puts on the wire and the Hebrew sentence
 * it shows for each refusal, so the PostgREST wire format has to stay real.
 */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', org_id: 'org-test', role: 'office' } }),
}));

import { QuickCreateSupplier, quickSupplierRow } from './QuickCreateSupplier';
// Vite's `?raw` rather than fs + a path: the repo lives under a Hebrew path with a space, and the
// source text itself is what the boundary assertions below are about.
import componentSource from './QuickCreateSupplier.tsx?raw';

const SUPPLIERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/suppliers`;

/** Records every insert body so a test can assert both what was sent and that nothing was. */
function useInsertEndpoint(
  respond: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const bodies: Record<string, unknown>[] = [];
  server.use(http.post(SUPPLIERS_ENDPOINT, async ({ request }) => {
    const parsed = (await request.json()) as Record<string, unknown> | Record<string, unknown>[];
    const body = Array.isArray(parsed) ? parsed[0] : parsed;
    bodies.push(body);
    return respond(body);
  }));
  return bodies;
}

const created = (body: Record<string, unknown>) =>
  HttpResponse.json({ id: 'supplier-new', name: body.name });

const postgrestError = (status: number, message: string, code: string) =>
  HttpResponse.json({ message, code, details: null, hint: null }, { status });

/**
 * Renders and waits for the dialog to take focus before returning.
 *
 * `useDialogLayer` focuses the panel inside a `requestAnimationFrame`. Typing before that frame
 * lands puts the keystrokes into a field that is about to lose focus, so the name arrives empty,
 * the client-side guard fires and no request is ever made — a race that fails roughly one run in
 * three and passes in isolation, which is exactly the symptom `src/test/setup.ts` records for
 * ReauthModal. Waiting for the focus makes the ordering deterministic instead of lucky.
 */
async function renderDialog() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <QuickCreateSupplier onClose={onClose} onCreated={onCreated} />
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
  return { onCreated, onClose };
}

const nameField = () => screen.getByLabelText('שם הספק *');
const saveButton = () => screen.getByRole('button', { name: 'שמירה' });

/**
 * Every form control in the dialog, queried from the DOM rather than by role.
 *
 * `getAllByRole('textbox')` was the hole review found: it cannot see a `type="password"` input
 * (no implicit textbox role) and it misses anything a role query filters out. A field this
 * component must not have does not become acceptable by being hard to query.
 */
const dialogControls = () => Array.from(
  document.querySelectorAll<HTMLElement>('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select'),
);

describe('QuickCreateSupplier — the shared door', () => {
  it('creates the supplier and hands the caller the row it can select immediately', async () => {
    const user = userEvent.setup();
    const bodies = useInsertEndpoint(created);
    const { onCreated, onClose } = await renderDialog();

    await user.type(nameField(), '  ירקות השדה בע״מ  ');
    await user.type(screen.getByLabelText('ח.פ / עוסק'), '514123456');
    await user.click(saveButton());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'supplier-new', name: 'ירקות השדה בע״מ' }));
    expect(bodies).toHaveLength(1);
    // Trimmed at the boundary: the stored name is what the user meant, not what they typed.
    expect(bodies[0]).toEqual({ org_id: 'org-test', name: 'ירקות השדה בע״מ', tax_id: '514123456' });
    // Closing is the caller's move (SupplierForm's onSaved contract) — the dialog never closes itself.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends tax_id as null when it was left empty, like the full supplier form does', async () => {
    const user = userEvent.setup();
    const bodies = useInsertEndpoint(created);
    await renderDialog();

    await user.type(nameField(), 'ספק ללא ח.פ');
    await user.click(saveButton());

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ org_id: 'org-test', name: 'ספק ללא ח.פ', tax_id: null });
  });

  it('cannot fire a second insert after a successful create', async () => {
    const user = userEvent.setup();
    const bodies = useInsertEndpoint(created);
    const { onCreated } = await renderDialog();

    await user.type(nameField(), 'ספק יחיד');
    const button = saveButton();
    await user.click(button);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    // Closing is the caller's move, so the form outlives the create by a beat. `suppliers` has no
    // unique constraint on `name`, so a second click in that beat would silently create the
    // duplicate half of the #106 fraud pattern under a "הספק נוצר" toast.
    expect(button).toBeDisabled();
    await user.click(button);
    expect(bodies).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    // The exit is never taken away, even though the form is spent.
    expect(screen.getByRole('button', { name: 'ביטול' })).toBeEnabled();
  });

  it('treats an insert that answers with no row as a failure, not a success', async () => {
    const user = userEvent.setup();
    // PostgREST answered 2xx but returned nothing usable — the caller must not be told a supplier
    // exists on the strength of a cast.
    useInsertEndpoint(() => HttpResponse.json({}));
    const { onCreated } = await renderDialog();

    await user.type(nameField(), 'ספק ללא תשובה');
    await user.click(saveButton());

    expect(await screen.findByText('הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה.')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it('refuses a whitespace-only name before anything reaches the server', async () => {
    const user = userEvent.setup();
    const bodies = useInsertEndpoint(created);
    const { onCreated } = await renderDialog();

    await user.type(nameField(), '   ');
    await user.click(saveButton());

    expect(await screen.findByText('שם ספק הוא שדה חובה')).toBeInTheDocument();
    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('maps a server unique violation to its own sentence and keeps the dialog open', async () => {
    const user = userEvent.setup();
    useInsertEndpoint(() => postgrestError(409, 'duplicate key value violates unique constraint "suppliers_pkey"', '23505'));
    const { onCreated, onClose } = await renderDialog();

    await user.type(nameField(), 'ACME בע״מ');
    await user.click(saveButton());

    expect(await screen.findByText('הרשומה כבר קיימת במערכת.')).toBeInTheDocument();
    // Nothing was created — the caller must not be told otherwise, and the typed name survives
    // so the user can correct it instead of retyping.
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(nameField()).toHaveValue('ACME בע״מ');
  });

  it('maps an RLS refusal to the permission sentence — a different sentence', async () => {
    const user = userEvent.setup();
    useInsertEndpoint(() => postgrestError(403, 'new row violates row-level security policy for table "suppliers"', '42501'));
    const { onCreated } = await renderDialog();

    await user.type(nameField(), 'ספק חסום');
    await user.click(saveButton());

    expect(await screen.findByText('אין לך הרשאה לבצע את הפעולה הזו.')).toBeInTheDocument();
    // The name is not what was wrong — a refusal from the server must not mark the field invalid.
    expect(nameField()).not.toHaveAttribute('aria-invalid');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('maps a network failure to the connection sentence — a third, different sentence', async () => {
    const user = userEvent.setup();
    server.use(http.post(SUPPLIERS_ENDPOINT, () => HttpResponse.error()));
    const { onCreated } = await renderDialog();

    await user.type(nameField(), 'ספק אופליין');
    await user.click(saveButton());

    expect(await screen.findByText('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

/**
 * The boundary, enforced structurally — and honest about where it still ends.
 *
 * DEBT-REGISTER §11 / OPEN-DECISIONS #106: `suppliers.bank_details` lost its UPDATE grant in
 * `0061:469` but kept INSERT deliberately, so a *new* supplier row can carry substituted bank
 * details with no step-up, no operator reason and no `security_event`. A bank field in a quick
 * create surface would spread that unresolved hole from one screen to four.
 *
 * A first version of this block claimed three independent axes and had one. Review put five edits
 * through it; three passed everything, including the plausible one — a `defaults` prop spread into
 * the insert, which is exactly the "prefill from the OCR result" edit E2 might invite. The axes
 * below are the ones that survived that attack:
 *
 *   1. source text, comments stripped — Latin `bank` AND Hebrew `בנק`, since the concept has two
 *      spellings here and only one was being checked;
 *   2. exactly one write in the file, pinned to the closed row builder at the call site — this is
 *      what stops both a `{...defaults}` spread and a second fire-and-forget `.update()`;
 *   3. the builder driven directly, so the column set is not inferred from whichever scenario a
 *      UI test happens to drive;
 *   4. the wire with EVERY rendered control filled first — a field behind a disclosure, or one
 *      whose key is only attached when non-empty, now reaches the payload and is caught;
 *   5. a control inventory queried from the DOM, not by role, so `type="password"` cannot hide.
 *
 * What this still does not catch: an editor who rewrites `quickSupplierRow` itself to accept and
 * spread a caller-supplied object. Axis 2 makes that a deliberate, visible edit to this file
 * rather than an accident — which is the most a test in this repo can honestly claim.
 */
describe('bank_details must never appear in this component', () => {
  const source = componentSource;
  /** Comments removed — the rationale is allowed to name the column; the code is not. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('names no bank identifier — Latin or Hebrew — outside a comment', () => {
    expect(code).not.toMatch(/bank/i);
    expect(code).not.toMatch(/בנק/);
  });

  it('keeps the reason in the file, so the omission reads as a boundary and not an oversight', () => {
    // Fails if someone deletes the header comment: the column has to be named, and the decision
    // it belongs to has to be findable, or the next editor will "fix" the missing field.
    expect(source).toMatch(/bank_details/);
    expect(source).toMatch(/#106/);
    expect(source).toMatch(/DEBT-REGISTER/);
  });

  it('performs exactly one write, and it is the closed row builder', () => {
    // A second `.update({[key]: …})` after the insert was one of the edits that passed review
    // untouched. One write, and its argument pinned, is what closes that door.
    expect(code.match(/\.(insert|update|upsert|delete|rpc)\(/g)).toEqual(['.insert(']);
    expect(code).toMatch(/\.insert\(quickSupplierRow\(profile\.org_id, name, taxId\)\)/);
  });

  it('builds exactly three columns for any input, not just the one a UI test drives', () => {
    expect(Object.keys(quickSupplierRow('org', 'name', 'tax')).sort()).toEqual(['name', 'org_id', 'tax_id']);
    expect(quickSupplierRow('org-test', '  ACME  ', '   ')).toEqual({
      org_id: 'org-test', name: 'ACME', tax_id: null,
    });
  });

  it('renders exactly two controls, counting the ones a role query cannot see', async () => {
    await renderDialog();
    expect(dialogControls().map((control) => control.id)).toEqual([
      'quick-supplier-name',
      'quick-supplier-tax-id',
    ]);
  });

  it('puts exactly three columns on the wire with every rendered field filled', async () => {
    const user = userEvent.setup();
    const bodies = useInsertEndpoint(created);
    await renderDialog();

    // Fill everything the dialog renders, not only the name: a key attached conditionally on a
    // non-empty value is invisible to a test that leaves that value empty.
    for (const control of dialogControls()) await user.type(control, 'x');
    await user.click(saveButton());

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(Object.keys(bodies[0]).sort()).toEqual(['name', 'org_id', 'tax_id']);
  });
});
