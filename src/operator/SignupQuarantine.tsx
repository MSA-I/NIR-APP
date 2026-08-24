import { useState } from 'react';
import { MailWarning, ShieldAlert } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { ConfirmDialog, ErrorNote, Note, PageLoader, useToast } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  fetchAbandonedSignupCandidates, fetchMyCapabilities, fetchQuarantineQueue, resolveQuarantine,
  type AbandonedSignupCandidate, type PlatformCapability, type QuarantineEntry,
} from '../lib/platform';

/**
 * Abandoned self-signup (#175), operator side.
 *
 * The two halves of this screen are not two views of the same thing. The top table is a
 * REPORT — `platform_abandoned_signup_candidates` is declared STABLE, so it structurally cannot
 * write, and nothing on this screen deletes anything. The bottom table is the QUARANTINE QUEUE:
 * organizations that never confirmed an address but DID do business, which #175 says are never
 * removed automatically. An operator releases or escalates them; the product does not decide.
 *
 * Deletion of an empty organization happens in a server-only command with no browser grant
 * (`service_cleanup_abandoned_signup`), which re-checks owner verification and activity under a
 * row lock inside the deleting transaction. There is deliberately no button for it here.
 */
export default function SignupQuarantine() {
  const toast = useToast();
  const [pending, setPending] = useState<{ entry: QuarantineEntry; resolution: 'released' | 'escalated' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const { data, loading, error } = useQuery(
    async () => {
      const capabilities = await fetchMyCapabilities();
      if (!capabilities.includes('customer.view')) {
        return { capabilities, candidates: [] as AbandonedSignupCandidate[], queue: [] as QuarantineEntry[] };
      }
      const [candidates, queue] = await Promise.all([
        fetchAbandonedSignupCandidates(30),
        fetchQuarantineQueue(),
      ]);
      return { capabilities, candidates, queue };
    },
    [nonce],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];

  async function resolve(entry: QuarantineEntry, resolution: 'released' | 'escalated', reason: string) {
    setBusy(true);
    try {
      await resolveQuarantine({ queueId: entry.id, resolution, reason });
    } catch (rpcError) {
      setBusy(false);
      toast(toHebrewError((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setPending(null);
    toast(resolution === 'released' ? 'הארגון שוחרר מהבידוד' : 'הארגון הועבר להסלמה');
    setNonce((value) => value + 1);
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;
  if (!capabilities.includes('customer.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          מסך ההרשמות הנטושות פתוח למפעילים בעלי הרשאת צפייה בלקוחות. ההרשאה מוקצית מחוץ למוצר.
        </span>
      </Note>
    );
  }

  const candidates = data?.candidates ?? [];
  const queue = data?.queue ?? [];
  const openQueue = queue.filter((entry) => !entry.resolved_at);

  return (
    <div className="space-y-6">
      <h1 className="page-title flex items-center gap-2">
        <MailWarning size={22} /> הרשמות שלא אושרו
      </h1>

      <Note tone="info">
        <span className="min-w-0 flex-1">
          תזכורות המייל נבנו אך אינן נשלחות: אין ספק מייל מוגדר (#236), והמערכת רושמת «לא נשלח»
          במקום להצהיר על שליחה שלא קרתה.
        </span>
      </Note>

      <section className="card p-4">
        <h2 className="section-title mb-3">מועמדים אחרי 30 יום</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-muted">אין ארגונים שהבעלים שלהם לא אישר מייל מעל 30 יום.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-muted">
                  <th className="text-start py-2">ארגון</th>
                  <th className="text-start py-2">נפתח</th>
                  <th className="text-start py-2 num">ימים</th>
                  <th className="text-start py-2">מצב</th>
                  <th className="text-start py-2 num">תזכורות שלא נשלחו</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((row) => (
                  <tr key={row.org_id} className="border-t border-hairline">
                    <td className="py-2">{row.organization_name}</td>
                    <td className="py-2">{fmtDate(row.created_at)}</td>
                    <td className="py-2 num">{fmtNum(row.days_since_signup)}</td>
                    <td className="py-2">
                      {row.disposition === 'quarantine_required'
                        ? <span className="text-alert">פעילות עסקית — בידוד</span>
                        : <span className="text-ink-muted">ריק — מועמד לניקוי</span>}
                    </td>
                    <td className="py-2 num">{fmtNum(row.reminders_not_sent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="section-title mb-3 flex items-center gap-2">
          <ShieldAlert size={18} /> תור בידוד
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          ארגונים עם פעילות עסקית שהבעלים שלהם לא אישר מייל. הם אינם נמחקים אוטומטית לעולם —
          אדם מכריע.
        </p>
        {openQueue.length === 0 ? (
          <p className="text-sm text-ink-muted">אין ארגונים בבידוד.</p>
        ) : (
          <ul className="space-y-2">
            {openQueue.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
                <span className="min-w-0 flex-1 font-medium text-ink">{entry.organization_name}</span>
                <span className="text-xs text-ink-muted">נפתח {fmtDate(entry.opened_at)}</span>
                {capabilities.includes('customer.edit') && (
                  <>
                    <button type="button" className="btn-secondary"
                      onClick={() => setPending({ entry, resolution: 'released' })}>
                      שחרור
                    </button>
                    <button type="button" className="btn-secondary"
                      onClick={() => setPending({ entry, resolution: 'escalated' })}>
                      הסלמה
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!pending}
        busy={busy}
        requireReason
        title={pending?.resolution === 'released'
          ? `שחרור ${pending.entry.organization_name} מהבידוד`
          : `הסלמת ${pending?.entry.organization_name ?? ''}`}
        message="ההכרעה נרשמת עם שם המפעיל, מועד וסיבה. היא אינה מוחקת דבר."
        confirmLabel={pending?.resolution === 'released' ? 'שחרור' : 'הסלמה'}
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) void resolve(pending.entry, pending.resolution, reason ?? '');
        }}
      />
    </div>
  );
}
