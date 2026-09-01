import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Signup from './Signup';

const invoke = vi.fn();
const rpc = vi.fn();
const getSession = vi.fn();
const signInWithOAuth = vi.fn();
const resend = vi.fn();

/**
 * `enabledFederatedProviders` reads `import.meta.env` at module scope, which Vite has already
 * substituted before any test runs — `stubEnv` cannot reach it. The module is mocked so a test can
 * say "Google is configured" without pretending to rebuild the bundle.
 */
const federated = vi.hoisted(() => ({
  providers: [] as ('google' | 'apple')[],
  start: vi.fn(async () => ({ error: null })),
  /**
   * Owner decision #270's enforcement switch, which lives beside the provider switches for the
   * same build-time reason. Off by default here because it is off in the product: `DEBT §25`
   * means a verification mail to a customer is accepted and never delivered, so the requirement
   * is switched on in the same change that switches Apple on and not before.
   */
  backupEmailEnforced: false,
}));

vi.mock('../lib/authProviders', () => ({
  FEDERATED_PROVIDERS: ['google', 'apple'],
  FEDERATED_PROVIDER_LABEL: { google: 'Google', apple: 'Apple' },
  enabledFederatedProviders: () => federated.providers,
  startFederatedSignup: federated.start,
  backupEmailRequirementEnforced: () => federated.backupEmailEnforced,
}));

/** The tenant bootstrap as `AuthContext` reports it — null profile means "no organization yet". */
const auth = vi.hoisted(() => ({
  state: { session: null as unknown, profile: null as unknown, loading: false },
}));

vi.mock('../auth/AuthContext', () => ({
  homeFor: () => '/dashboard',
  useAuth: () => auth.state,
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    rpc: (...a: unknown[]) => rpc(...a),
    auth: {
      getSession: () => getSession(),
      signInWithOAuth: (...a: unknown[]) => signInWithOAuth(...a),
      resend: (...a: unknown[]) => resend(...a),
    },
  },
}));

const NEUTRAL = 'אם הכתובת אינה רשומה עדיין — נשלח אליה מייל אישור';

const renderScreen = () => render(<MemoryRouter><Signup /></MemoryRouter>);

const fill = async () => {
  const user = userEvent.setup();
  renderScreen();
  await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
  await user.type(screen.getByLabelText('שם מלא'), 'משה כהן');
  await user.type(screen.getByLabelText('אימייל'), 'owner@example.test');
  await user.type(screen.getByLabelText('סיסמה'), 'a-long-enough-password');
  return user;
};

/** A session as the auth server reports one: the provider lives in app_metadata, never in user_metadata. */
const googleSession = (over: Record<string, unknown> = {}) => ({
  data: {
    session: {
      user: {
        email: 'owner@gmail.test',
        app_metadata: { provider: 'google' },
        user_metadata: { full_name: 'משה כהן' },
        ...over,
      },
    },
  },
});

/** The same shape for any provider — the branch is decided by app_metadata.provider, not by us. */
const federatedSession = (provider: 'google' | 'apple', email: string) => googleSession({
  email,
  app_metadata: { provider },
});

beforeEach(() => {
  invoke.mockResolvedValue({ data: { status: 'pending_confirmation', message: NEUTRAL }, error: null });
  rpc.mockResolvedValue({ data: { org_id: 'org-1', role: 'office' }, error: null });
  getSession.mockResolvedValue({ data: { session: null } });
  signInWithOAuth.mockResolvedValue({ error: null });
  resend.mockResolvedValue({ data: {}, error: null });
  federated.providers = [];
  federated.start.mockClear();
  federated.backupEmailEnforced = false;
  auth.state = { session: null, profile: null, loading: false };
});

describe('פתיחת חשבון', () => {
  it('שולח ארבעה שדות בלבד — מסלול, סטטוס ומע״מ אינם של הנרשם', async () => {
    // A form that could ask for a plan would be a free upgrade. The edge function reads exactly
    // these four keys, and sending more would change nothing — but offering them would mislead.
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'full_name', 'organization_name', 'password']);
  });

  it('מציג את אותה תשובה בדיוק גם כשהכתובת כבר רשומה', async () => {
    // The endpoint answers a duplicate address identically to a fresh signup, so this screen must
    // not add a distinction of its own and turn the page into an account-enumeration tool.
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    expect(await screen.findByText(/בדקו את תיבת הדואר/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(NEUTRAL))).toBeInTheDocument();
  });

  it('שולח שוב מייל אישור בלי לשלוח מחדש סיסמה או פרטי עסק', async () => {
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    await user.click(await screen.findByRole('button', { name: 'שלחו שוב' }));

    await waitFor(() => expect(resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'owner@example.test',
    }));
    expect(await screen.findByText('מייל אישור חדש נשלח.')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('מציג כשל ברור כששליחה חוזרת לא התקבלה ב-Supabase Auth', async () => {
    resend.mockResolvedValue({ data: null, error: { message: 'rate limited' } });
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    await user.click(await screen.findByRole('button', { name: 'שלחו שוב' }));

    expect(await screen.findByText(/לא הצלחנו לשלוח מייל אישור חדש/)).toBeInTheDocument();
  });

  it('משחרר את כפתור השליחה החוזרת גם בכשל רשת', async () => {
    resend.mockRejectedValue(new Error('network offline'));
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    await user.click(await screen.findByRole('button', { name: 'שלחו שוב' }));

    expect(await screen.findByText(/לא הצלחנו לשלוח מייל אישור חדש/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'שלחו שוב' })).toBeEnabled();
  });

  it('אינו מאפשר שליחה עם סיסמה קצרה מדי', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('שם העסק'), 'עסק');
    await user.type(screen.getByLabelText('שם מלא'), 'משה');
    await user.type(screen.getByLabelText('אימייל'), 'owner@example.test');
    await user.type(screen.getByLabelText('סיסמה'), 'short');
    expect(screen.getByRole('button', { name: 'פתיחת חשבון' })).toBeDisabled();
  });

  it('מציג את הודעת הסירוב של השרת כשההרשמה נחסמה בקצב', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({ error: { code: 'rate_limited', message: 'התקבלו יותר מדי בקשות הרשמה. יש לנסות שוב מאוחר יותר.' } }),
        },
      },
    });
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    expect(await screen.findByText(/יותר מדי בקשות הרשמה/)).toBeInTheDocument();
  });

  it('כפתור Google מוסתר כשהספק אינו מוגדר', async () => {
    renderScreen();
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    // The flag is off in the test environment, and a door that leads to "provider not enabled"
    // is worse than no door.
    expect(screen.queryByRole('button', { name: 'המשך עם Google' })).toBeNull();
  });

  it('חזרה מ-Google מבקשת שם עסק בלבד — לא אימייל ולא סיסמה', async () => {
    getSession.mockResolvedValue(googleSession());
    renderScreen();

    await screen.findByText(/מחובר כ/);
    expect(screen.getByLabelText('שם העסק')).toBeInTheDocument();
    // Google proved the address; asking for it again, or for a password, would be theatre.
    expect(screen.queryByLabelText('אימייל')).toBeNull();
    expect(screen.queryByLabelText('סיסמה')).toBeNull();
  });

  it('המסלול הפדרטיבי שולח identity=google ולעולם לא סיסמה', async () => {
    getSession.mockResolvedValue(googleSession());
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body.identity).toBe('google');
    expect(body.organization_name).toBe('מסעדת הגפן');
    expect(body).not.toHaveProperty('password');
    // The address is the server's to read from the token, not the form's to assert.
    expect(body).not.toHaveProperty('email');
  });

  /**
   * Owner decision 31.08.2026. The hole this closes: an invited employee has NO auth user until
   * they open the invitation, so `service_identity_has_profile` says "no standing" and the
   * federated branch used to hand them an organization of their own. `0205` then refuses them
   * inside `accept_invitation` forever, so the invitation they came for becomes unredeemable.
   */
  it('זהות פדרטיבית שהוזמנה לעסק קיים אינה פותחת עסק חדש', async () => {
    getSession.mockResolvedValue(federatedSession('google', 'clerk@gmail.test'));
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({
            error: {
              code: 'invitation_pending',
              message: 'הכתובת הזו הוזמנה להצטרף לעסק קיים. ההצטרפות נעשית מקישור ההזמנה ובסיסמה.',
              organization: 'מסעדת הגפן',
            },
          }),
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'עסק חדש כלשהו');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    // The card names the business that invited them, and stops. Naming it is safe: the provider
    // proved the address, so this discloses nothing the caller did not already hold.
    expect(await screen.findByText(/יש לכם הזמנה ממתינה/)).toBeInTheDocument();
    expect(screen.getByText(/מסעדת הגפן/)).toBeInTheDocument();
    // No business was created and none can be from here: the "open an account" form is gone and
    // what replaced it is the way in to the business that invited them.
    expect(screen.queryByLabelText('שם העסק')).toBeNull();
    expect(screen.queryByRole('button', { name: 'פתיחת חשבון' })).toBeNull();
    expect(screen.getByRole('button', { name: 'הצטרפות לעסק' })).toBeInTheDocument();
  });

  /**
   * Owner decision 31.08.2026, amending `#265`: an invitation belongs to an ADDRESS, and a provider
   * that proved the address may redeem it. `0282` removes `0205`'s password-identity guard and lets
   * the command resolve the invitation from the caller's confirmed address, so no token is sent —
   * the token lives in an email `DEBT §25` says this deployment cannot deliver.
   */
  it('מצטרף לעסק שהזמין אותו בלי טוקן ובלי סיסמה', async () => {
    getSession.mockResolvedValue(federatedSession('google', 'clerk@gmail.test'));
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({
            error: { code: 'invitation_pending', message: 'הוזמנת', organization: 'מסעדת הגפן' },
          }),
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'עסק חדש כלשהו');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    await screen.findByRole('button', { name: 'הצטרפות לעסק' });

    // Consent is its own gate: 0089 closed the consent-free signature, so the button stays shut
    // until the box is ticked no matter what else is filled in.
    expect(screen.getByRole('button', { name: 'הצטרפות לעסק' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'הצטרפות לעסק' }));

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    const [command, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('accept_invitation');
    expect(args.p_token).toBeNull();
    expect(args.p_terms_version).toBeTruthy();
    // The name came from the provider's profile and was never retyped.
    expect(args.p_full_name).toBe('משה כהן');
  });

  it('סירוב ההזמנה עומד גם כששם הארגון לא נמסר', async () => {
    getSession.mockResolvedValue(federatedSession('google', 'clerk@gmail.test'));
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({ error: { code: 'invitation_pending', message: 'הוזמנת', organization: '' } }),
        },
      },
    });
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'עסק חדש כלשהו');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    // The name is a courtesy; the refusal is the point. A failed lookup must not degrade into
    // "here is a brand new business".
    expect(await screen.findByText(/יש לכם הזמנה ממתינה/)).toBeInTheDocument();
    expect(screen.queryByLabelText('שם העסק')).toBeNull();
  });

  it('שליחת הטופס אחרי כניסה עם ספק הולכת למסלול הפדרטיבי, לא לכניסה בסיסמה', async () => {
    // The federated branch draws no credential fields but DOES draw the business ones, inside the
    // same <form>. Any path that submits that form — a browser's implicit submission today, a
    // submit button someone adds tomorrow — used to reach the password sign-in with two empty
    // strings. `fireEvent.submit` exercises the guard directly rather than relying on which
    // markup happens to make Enter submit.
    getSession.mockResolvedValue(googleSession());
    const user = userEvent.setup();
    const { container } = renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body.identity).toBe('google');
    expect(body.organization_name).toBe('מסעדת הגפן');
    expect(body).not.toHaveProperty('password');
  });

  it('כניסה חוזרת של זהות שכבר יש לה ארגון אינה מבקשת שם עסק שוב', async () => {
    // Both entrances send the provider back to /signup, so the SECOND sign-in lands here too.
    // Without the redirect the person is asked to name a business they already have, and
    // public-signup refuses with identity_already_has_organization only after they fill the form.
    auth.state = {
      session: { user: { id: 'u1' } },
      profile: { id: 'u1', role: 'owner', org_id: 'org-1' },
      loading: false,
    };
    getSession.mockResolvedValue(federatedSession('google', 'owner@gmail.test'));
    renderScreen();

    await waitFor(() => expect(screen.queryByLabelText('שם העסק')).toBeNull());
    expect(screen.queryByText(/נשאר רק לתת שם לעסק/)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('זהות פדרטיבית ללא ארגון נשארת במסך ההרשמה', async () => {
    // The mirror of the case above: a first-time federated caller has a session and no profile,
    // and must NOT be redirected — this screen is the only one that can finish their signup.
    auth.state = { session: { user: { id: 'u2' } }, profile: null, loading: false };
    getSession.mockResolvedValue(federatedSession('google', 'newcomer@gmail.test'));
    renderScreen();

    expect(await screen.findByText(/נשאר רק לתת שם לעסק/)).toBeInTheDocument();
    expect(screen.getByLabelText('שם העסק')).toBeInTheDocument();
  });

  it('מצייר כפתור לכל ספק מוגדר, ומוסר לו את פתיחת התהליך', async () => {
    federated.providers = ['google', 'apple'];
    const user = userEvent.setup();
    renderScreen();
    await waitFor(() => expect(getSession).toHaveBeenCalled());

    expect(screen.getAllByRole('button', { name: /^המשך עם/ }).map((b) => b.textContent))
      .toEqual(['המשך עם Google', 'המשך עם Apple']);

    await user.click(screen.getByRole('button', { name: 'המשך עם Apple' }));
    expect(federated.start).toHaveBeenCalledWith('apple');
  });

  it('המסלול הפדרטיבי שולח את הספק שהטוקן מצהיר עליו — apple, לא google', async () => {
    // The body's `identity` follows app_metadata. Sending the wrong one would be refused by
    // public-signup's provider check, so the screen must not be the thing that guesses.
    getSession.mockResolvedValue(federatedSession('apple', 'owner@privaterelay.appleid.test'));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body.identity).toBe('apple');
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('email');
  });

  it('חזרה מ-Apple עם כתובת Private Relay מציגה אותה כפי שהיא', async () => {
    // A relay address is the only address this session proves. Hiding or rewriting it would tell
    // the owner they signed up as somebody else.
    getSession.mockResolvedValue(federatedSession('apple', 'owner@privaterelay.appleid.test'));
    renderScreen();

    expect(await screen.findByText('owner@privaterelay.appleid.test')).toBeInTheDocument();
    expect(screen.queryByLabelText('סיסמה')).toBeNull();
  });

  it('סשן שמצהיר על Google ב-user_metadata בלבד אינו נחשב Google', async () => {
    // user_metadata is self-asserted. If this branch could be entered by writing a value into it,
    // the whole owner-only rule would rest on a field the user controls.
    getSession.mockResolvedValue(googleSession({
      app_metadata: { provider: 'email' },
      user_metadata: { full_name: 'משה כהן', provider: 'google' },
    }));
    renderScreen();

    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(screen.queryByText(/מחובר כ/)).toBeNull();
    expect(screen.getByLabelText('סיסמה')).toBeInTheDocument();
  });
});

/**
 * Owner decision #270 — `require-backup-email`, and the two rulings attached to it:
 *   1. the requirement follows the ADDRESS (a Private Relay forwarder), never the provider;
 *   2. it is built now and enforced only when Apple is switched on.
 */
describe('כתובת דואר חלופית', () => {
  const RELAY = 'owner@privaterelay.appleid.com';
  const BACKUP = 'owner@example.co.il';

  it('אינו מבקש כתובת חלופית כשהאכיפה כבויה — גם מכתובת העברה של Apple', async () => {
    // Ruling 2, and the property DEBT §25 makes non-negotiable: the domain is not verified and
    // Resend is in sandbox, so a verification mail to a customer is accepted and never delivered.
    // A requirement that shipped ON would make signup unreachable for every real customer.
    getSession.mockResolvedValue(federatedSession('apple', RELAY));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    expect(screen.queryByLabelText('כתובת דואר חלופית')).toBeNull();

    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('backup_email');
  });

  it('מבקש כתובת חלופית מכתובת העברה של Apple אחרי שהאכיפה נדלקת, ושולח אותה', async () => {
    federated.backupEmailEnforced = true;
    getSession.mockResolvedValue(federatedSession('apple', RELAY));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);

    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    // Named but not backed up yet: the business name alone is no longer enough.
    expect(screen.getByRole('button', { name: 'פתיחת חשבון' })).toBeDisabled();

    await user.type(screen.getByLabelText('כתובת דואר חלופית'), BACKUP);
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body.backup_email).toBe(BACKUP);
    expect(body.identity).toBe('apple');
  });

  it('אינו מבקש דבר מזהות פדרטיבית שמסרה כתובת אמיתית', async () => {
    // Ruling 1: the rule is about the address. A Google signup, and an Apple signup by somebody
    // who chose to share their real address, are asked for nothing even with enforcement on.
    federated.backupEmailEnforced = true;
    getSession.mockResolvedValue(federatedSession('google', 'owner@gmail.test'));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    expect(screen.queryByLabelText('כתובת דואר חלופית')).toBeNull();

    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    expect(screen.getByRole('button', { name: 'פתיחת חשבון' })).toBeEnabled();
  });

  it('אינו מקבל את אותה כתובת בתור גיבוי של עצמה', async () => {
    federated.backupEmailEnforced = true;
    getSession.mockResolvedValue(federatedSession('apple', RELAY));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);

    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    await user.type(screen.getByLabelText('כתובת דואר חלופית'), RELAY);

    expect(await screen.findByText(/הגיבוי חייב להיות כתובת אחרת/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'פתיחת חשבון' })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('פותח את השדה כשהשרת ביקש כתובת חלופית והחבילה לא ידעה על כך', async () => {
    // The two switches are read at build time on both sides, so one deploy can be ahead of the
    // other. Without this the refusal is a dead end: the visitor is blocked over a field the form
    // never drew. DEBT §79's rule, pointed at the other side of the same request.
    invoke.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({
            error: { code: 'backup_email_required', message: 'יש להוסיף כתובת דואר חלופית.' },
          }),
        },
      },
    });
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    expect(await screen.findByText(/יש להוסיף כתובת דואר חלופית/)).toBeInTheDocument();
    const field = await screen.findByLabelText('כתובת דואר חלופית');
    await user.type(field, BACKUP);
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    const body = invoke.mock.calls[1]![1].body as Record<string, unknown>;
    expect(body.backup_email).toBe(BACKUP);
    expect(body.email).toBe('owner@example.test');
  });
});
