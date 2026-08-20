import { useState } from 'react';
import { Link } from 'react-router';
import { Building2, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note } from '../components/ui';

const MIN_PASSWORD_LENGTH = 10;

/**
 * Self-service signup (0159) — the screen that reversed OPEN-DECISIONS #12.
 *
 * It asks for four things and nothing else. There is no plan picker, no VAT field and no
 * category list, because none of those are the visitor's to choose: the database sets the
 * starting plan, and a form that could ask for Business would be a free upgrade. Sending them
 * would change nothing either — the Edge Function reads exactly these four keys.
 */
export default function Signup() {
  const [form, setForm] = useState({ organization: '', name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const ready = form.organization.trim().length > 0
    && form.name.trim().length > 0
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
    && form.password.length >= MIN_PASSWORD_LENGTH;

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          organization_name: form.organization.trim(),
          full_name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
        },
      },
    );
    setBusy(false);

    if (failure) {
      const context = (failure as { context?: Response }).context;
      if (context && typeof context.json === 'function') {
        try {
          const payload = await context.json() as { error?: { message?: string } };
          if (payload?.error?.message) { setError(payload.error.message); return; }
        } catch {
          // no JSON body — fall through to the transport message
        }
      }
      setError('ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.');
      return;
    }
    setSent(data?.message ?? null);
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <div className="card card-pad space-y-3 text-center">
          <MailCheck size={28} aria-hidden="true" className="mx-auto text-done-fg" />
          <h1 className="page-title">בדקו את תיבת הדואר</h1>
          {/* Deliberately the same sentence whether the address was new or already registered:
              a different answer per case would turn this page into a way to discover who has an
              account. */}
          <p className="text-sm text-ink-soft">{sent}</p>
          <Link className="btn-secondary" to="/login">מעבר להתחברות</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <div className="card card-pad space-y-4">
        <h1 className="page-title flex items-center gap-2"><Building2 size={22} /> פתיחת חשבון</h1>
        <p className="text-sm text-ink-soft">
          החשבון נפתח מיד, וההתחברות אפשרית לאחר אישור כתובת האימייל.
        </p>

        {error && <ErrorNote message={error} />}

        <div>
          <label className="label" htmlFor="signup-organization">שם העסק</label>
          <input id="signup-organization" className="input" value={form.organization}
            autoComplete="organization"
            onChange={(event) => setForm({ ...form, organization: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="signup-name">שם מלא</label>
          <input id="signup-name" className="input" value={form.name} autoComplete="name"
            onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="signup-email">אימייל</label>
          <input id="signup-email" type="email" dir="ltr" className="input" value={form.email}
            autoComplete="email"
            onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="signup-password">סיסמה</label>
          <input id="signup-password" type="password" dir="ltr" className="input"
            value={form.password} autoComplete="new-password"
            onChange={(event) => setForm({ ...form, password: event.target.value })} />
          <p className="mt-1 text-xs text-ink-muted">לפחות {MIN_PASSWORD_LENGTH} תווים.</p>
        </div>

        <Note tone="idle">
          <span className="min-w-0 flex-1">
            החשבון נפתח במסלול ההתחלתי. שינוי מסלול נעשה מול השירות ואינו נבחר בטופס הזה.
          </span>
        </Note>

        <button type="button" className="btn-primary w-full" disabled={busy || !ready}
          onClick={() => void submit()}>
          {busy ? 'פותח חשבון…' : 'פתיחת חשבון'}
        </button>

        <p className="text-center text-sm text-ink-muted">
          כבר יש חשבון? <Link className="link" to="/login">התחברות</Link>
        </p>
      </div>
    </main>
  );
}
