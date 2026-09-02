import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { MailWarning, ShieldAlert } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { Card, ConfirmDialog, ErrorNote, ICON, Note, PageHeader, SkeletonTable, useToast } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
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
  const { errorText } = useT();
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
        // One DAY, not thirty. `private.abandoned_signup_grace()` (0287) is 24 hours since owner
        // ruling #332 removed the password from the moment of signup, and a report that still
        // listed only month-old tenants would never show what the cleanup is about to release.
        fetchAbandonedSignupCandidates(1),
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
      toast(errorText((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setPending(null);
    toast(resolution === 'released' ? 'הארגון שוחרר מהבידוד' : 'הארגון הועבר להסלמה');
    setNonce((value) => value + 1);
  }

  if (loading) return <SkeletonTable rows={6} cols={5} />;
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
      <PageHeader
        title={<span className="flex items-center gap-2"><MailWarning size={ICON.xl} aria-hidden="true" /> הרשמות שלא אושרו</span>}
      />

      <Note tone="info">
        <span className="min-w-0 flex-1">
          תזכורות המייל נבנו אך אינן נשלחות: אין ספק מייל מוגדר (#236), והמערכת רושמת «לא נשלח»
          במקום להצהיר על שליחה שלא קרתה.
        </span>
      </Note>

      <Card className="space-y-3">
        <h2 className="section-title">מועמדים אחרי 24 שעות</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-muted">אין ארגונים שהבעלים שלהם לא אישר מייל מעל 24 שעות.</p>
        ) : (
          // A read-only report, kept as a scroll region rather than moved to DataTable: the
          // screen's other half is the queue an operator acts on, and giving the REPORT a search
          // box, pagination and a row count would make it read like the work list beside it.
          <div className="table-scroll overflow-x-auto" role="region"
            aria-label="מועמדים אחרי 24 שעות — ניתן לגלול אופקית" tabIndex={0}>
            <table className="w-full">
              <thead className="table-head border-b border-line-soft">
                <tr>
                  <th scope="col" className="th">ארגון</th>
                  <th scope="col" className="th">נפתח</th>
                  <th scope="col" className="th num">ימים</th>
                  <th scope="col" className="th">מצב</th>
                  <th scope="col" className="th num">תזכורות שלא נשלחו</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {candidates.map((row) => (
                  <tr key={row.org_id}>
                    <td className="td">{row.organization_name}</td>
                    <td className="td num">{fmtDate(row.created_at)}</td>
                    <td className="td num">{fmtNum(row.days_since_signup)}</td>
                    <td className="td">
                      {row.disposition === 'quarantine_required'
                        ? <span className="text-alert-fg">פעילות עסקית — בידוד</span>
                        : <span className="text-ink-muted">ריק — מועמד לניקוי</span>}
                    </td>
                    <td className="td num">{fmtNum(row.reminders_not_sent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="section-title flex items-center gap-2">
          <ShieldAlert size={ICON.md} aria-hidden="true" /> תור בידוד
        </h2>
        <p className="text-sm text-ink-muted">
          ארגונים עם פעילות עסקית שהבעלים שלהם לא אישר מייל. הם אינם נמחקים אוטומטית לעולם —
          אדם מכריע.
        </p>
        {openQueue.length === 0 ? (
          <p className="text-sm text-ink-muted">אין ארגונים בבידוד.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {openQueue.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 font-medium text-ink">{entry.organization_name}</span>
                <span className="text-xs text-ink-muted">נפתח {fmtDate(entry.opened_at)}</span>
                {capabilities.includes('customer.edit') && (
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary btn-sm"
                      onClick={() => setPending({ entry, resolution: 'released' })}>
                      שחרור
                    </button>
                    <button type="button" className="btn-secondary btn-sm"
                      onClick={() => setPending({ entry, resolution: 'escalated' })}>
                      הסלמה
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

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
