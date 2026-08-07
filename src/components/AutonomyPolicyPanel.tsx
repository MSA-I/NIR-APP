import { useId, useState } from 'react';
import { BrainCircuit, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { toHebrewError } from '../lib/errors';
import { ConfirmDialog, ErrorNote, Note, useToast } from './ui';

/**
 * The only caller of `platform_set_autonomy_policy` (0076).
 *
 * Until this panel existed the command had none: the switch that decides whether a model may
 * write a financial record without a human could be moved only by hand-written SQL against the
 * database. That is not a safeguard, it is an absence — the reasoned, audited path existed and
 * nothing could reach it, which left the only *practical* route a direct write that skips the
 * reason and the audit row entirely.
 *
 * SCOPE, stated because the screen must not imply more than it can do: the command accepts any
 * `p_org_id`, but `org_autonomy_policies` is readable only through `org_id = auth_org()`
 * (0076:200-201) and `evaluate_autonomy_policy` resolves through `auth_org()` too. So a platform
 * operator can *read* only their own organization's rule. Rather than render a toggle that cannot
 * show its own state for other tenants — a control that claims a fact it has not got — this panel
 * is deliberately scoped to the operating organization and says so. Configuring a different
 * tenant needs a reader RPC that does not exist yet (DEBT-REGISTER §22).
 */
const POLICY_KEY = 'document.interpretation';

interface AutonomyPolicy {
  policy_key: string;
  configured: boolean;
  autonomy_enabled: boolean;
  min_confidence: number | null;
  kill_switch: boolean;
}

export function AutonomyPolicyPanel({ orgId, orgName }: { orgId: string; orgName: string }) {
  const toast = useToast();
  const thresholdId = useId();
  const [pendingEnable, setPendingEnable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(await supabase.rpc('evaluate_autonomy_policy', { p_policy_key: POLICY_KEY })) as AutonomyPolicy[];
    return rows[0] ?? null;
  });

  // The stored threshold when there is one; otherwise the field starts at the documented floor
  // rather than empty, because an empty number input submits NaN and the command answers that
  // with `autonomy_policy_invalid` — a refusal the operator did not earn.
  const [threshold, setThreshold] = useState<string>('');
  const effectiveThreshold = threshold || (data?.min_confidence != null ? String(data.min_confidence) : '0.900');

  async function apply(enable: boolean, reason: string) {
    setBusy(true);
    const res = await supabase.rpc('platform_set_autonomy_policy', {
      p_org_id: orgId,
      p_policy_key: POLICY_KEY,
      p_autonomy_enabled: enable,
      p_min_confidence: Number(effectiveThreshold),
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setPendingEnable(null);
    toast(enable ? 'האוטונומיה הופעלה — הפעולה נרשמה ביומן הביקורת' : 'האוטונומיה כובתה');
    void refetch();
  }

  if (loading) return <div className="card card-pad text-sm text-ink-muted">טוען את מדיניות האוטונומיה…</div>;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <ErrorNote message="מדיניות האוטונומיה אינה זמינה." />;

  const on = data.autonomy_enabled;

  return (
    <section className="card card-pad space-y-4" data-testid="autonomy-policy-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="section-title flex items-center gap-2">
            <BrainCircuit size={18} aria-hidden="true" /> אוטונומיית מסמכים
          </h2>
          <p className="mt-1 text-sm text-ink-muted">{orgName}</p>
        </div>
        <span className={on ? 'badge-alert' : 'badge-idle'}>{on ? 'מופעלת' : 'כבויה'}</span>
      </div>

      <p className="text-sm text-ink-body">
        כשהמתג <strong>כבוי</strong>, המערכת קוראת את המסמך, מפרשת אותו ומציגה הצעה — <strong>ואדם מכריע</strong>.
        כשהוא <strong>מופעל</strong>, מעל סף הביטחון היא יוצרת את החשבונית בעצמה, מקשרת ספק והזמנה, וכותבת
        את השיוך — <strong>בלי אישור אדם</strong>.
      </p>

      {/* The number that permits a machine to write money is a documented guess, and the screen
          that moves it is the one place that must not let a reader assume otherwise. */}
      <Note tone={on ? 'await' : 'info'}>
        סף הביטחון <span className="num">0.900</span> הוא <strong>ברירת מחדל מתועדת שלא כוילה</strong> מול מסמכים
        אמיתיים (OPEN-DECISIONS ‏#109). הוא חל גם על זיהוי סוג המסמך וגם על התאמת הספק. אפשר רק להחמיר אותו,
        לעולם לא להקל.
      </Note>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={thresholdId}>סף ביטחון מזערי</label>
          <input
            id={thresholdId}
            className="input num"
            type="number"
            min="0.9"
            max="1"
            step="0.005"
            dir="ltr"
            value={effectiveThreshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </div>
        <dl className="grid content-end gap-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-muted">הוגדר לארגון</dt>
            <dd className="text-ink-body">{data.configured ? 'כן' : 'לא — פועל לפי ברירת המחדל'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-muted">סף פעיל</dt>
            <dd className="num text-ink-body">{data.min_confidence ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {data.kill_switch && (
        <Note tone="alert" role="alert">
          מתג החירום הכללי פעיל: האוטונומיה מושבתת בכל הדיירים, ושינוי כאן לא ידליק אותה.
        </Note>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {on && (
          <button className="btn-secondary" disabled={busy} onClick={() => setPendingEnable(false)}>
            כיבוי האוטונומיה
          </button>
        )}
        {!on && (
          <button className="btn-danger flex items-center gap-1.5" disabled={busy || data.kill_switch} onClick={() => setPendingEnable(true)}>
            {busy ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : null}
            הפעלת האוטונומיה
          </button>
        )}
      </div>

      <ConfirmDialog
        open={pendingEnable !== null}
        busy={busy}
        danger={pendingEnable === true}
        requireReason
        title={pendingEnable ? 'הפעלת כתיבה אוטומטית של רשומות כספיות' : 'כיבוי האוטונומיה'}
        message={
          pendingEnable
            ? `מרגע האישור, מסמך שהמערכת מזהה בביטחון של ${effectiveThreshold} ומעלה ייצור חשבונית חיה בלי שאדם יאשר אותה. הסף לא כויל מול מסמכים אמיתיים. כל פעולה אוטומטית ניתנת לביטול מנומק, ונרשמת ביומן הביקורת.`
            : 'המערכת תמשיך לקרוא ולהציע, ואדם יכריע בכל מסמך. רשומות שכבר נוצרו אוטומטית אינן מבוטלות בפעולה הזו.'
        }
        confirmLabel={pendingEnable ? 'הפעלה' : 'כיבוי'}
        onClose={() => setPendingEnable(null)}
        onConfirm={(reason) => { if (pendingEnable !== null) void apply(pendingEnable, reason ?? ''); }}
      />
    </section>
  );
}
