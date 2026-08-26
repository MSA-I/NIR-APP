import { useState } from 'react';
import { Check, Trash2, X } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import { Card, ConfirmDialog, ErrorNote, ICON, Note, PageHeader, SkeletonTable, useToast } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  approvePurgeBatch, fetchMyCapabilities, fetchPurgeBatches, fetchPurgeCandidates,
  type PlatformCapability, type PurgeBatch, type PurgeCandidate,
} from '../lib/platform';

/**
 * Physical purge candidates (#261), operator side.
 *
 * #261 is explicit that this decision does NOT authorize a purge: what exists is a report, a
 * per-gate view of why each tenant is or is not a candidate, and an approval that produces an
 * immutable manifest. Execution is a separate command that replays that manifest, is reachable
 * only by a signed-in Platform Admin with a fresh password, and has no button on this screen.
 *
 * The four gates are rendered SEPARATELY rather than reduced to one "eligible" tick, because an
 * operator approving an irreversible deletion has to be able to see which gate is open, not just
 * that one is.
 */
const GATES: { key: keyof PurgeCandidate; label: string }[] = [
  { key: 'retention_eligible', label: 'תקופת שמירה' },
  { key: 'legal_hold_clear', label: 'ללא עיכוב משפטי' },
  { key: 'export_ready', label: 'ייצוא מוכן' },
  { key: 'backup_present', label: 'גיבוי ושחזור' },
];

function GateMark({ ok }: { ok: boolean }) {
  return ok
    ? <Check size={ICON.sm} className="text-ok" aria-label="עומד בתנאי" />
    : <X size={ICON.sm} className="text-alert-fg" aria-label="אינו עומד בתנאי" />;
}

export default function PurgeCandidates() {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const { data, loading, error } = useQuery(
    async () => {
      const capabilities = await fetchMyCapabilities();
      if (!capabilities.includes('offboarding.handle')) {
        return { capabilities, candidates: [] as PurgeCandidate[], batches: [] as PurgeBatch[] };
      }
      const [candidates, batches] = await Promise.all([
        fetchPurgeCandidates(),
        fetchPurgeBatches(),
      ]);
      return { capabilities, candidates, batches };
    },
    [nonce],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];

  async function approve(reason: string) {
    setBusy(true);
    try {
      await approvePurgeBatch({ orgIds: [...selected], reason });
    } catch (rpcError) {
      setBusy(false);
      toast(toHebrewError((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setConfirming(false);
    setSelected(new Set());
    toast('האצווה אושרה. המחיקה עצמה היא פעולה נפרדת ואינה מתבצעת מהמסך הזה.');
    setNonce((value) => value + 1);
  }

  if (loading) return <SkeletonTable rows={6} cols={6} />;
  if (error) return <ErrorNote message={error} />;
  if (!capabilities.includes('offboarding.handle')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          מסך המחיקה הסופית פתוח למפעילים בעלי הרשאת טיפול בסיום שירות. ההרשאה מוקצית מחוץ למוצר.
        </span>
      </Note>
    );
  }

  const candidates = data?.candidates ?? [];
  const batches = data?.batches ?? [];
  const eligible = candidates.filter((row) => row.eligible);

  function toggle(orgId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orgId)) next.delete(orgId); else next.add(orgId);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2"><Trash2 size={ICON.xl} aria-hidden="true" /> מחיקה סופית לאחר סיום שירות</span>}
      />

      <Note tone="alert">
        <span className="min-w-0 flex-1">
          אישור אצווה אינו מוחק דבר. הוא יוצר manifest חתום שאינו ניתן לשינוי; הביצוע הוא פקודה
          נפרדת שדורשת אימות סיסמה טרי ואינה נגישה לשום מתזמן.
        </span>
      </Note>

      <Card className="space-y-3">
        <h2 className="section-title">מועמדים</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-muted">אין ארגונים בתהליך סיום שירות עם ייצוא שהושלם.</p>
        ) : (
          // A four-gate matrix is the one shape DataTable's mobile CARDS cannot carry: collapsing
          // the gates into a label:value list is exactly the „one eligible tick" #261 forbids. So
          // it stays the app's other sanctioned model — a keyboard-reachable scroll region, the
          // same one DataTable renders for `mobile="scroll"`.
          <div className="table-scroll overflow-x-auto" role="region"
            aria-label="מועמדים למחיקה סופית — ניתן לגלול אופקית" tabIndex={0}>
            <table className="w-full">
              <thead className="table-head border-b border-line-soft">
                <tr>
                  <th scope="col" className="th"><span className="sr-only">בחירה</span></th>
                  <th scope="col" className="th">ארגון</th>
                  <th scope="col" className="th">הבקשה הוגשה</th>
                  {GATES.map((gate) => (
                    <th key={String(gate.key)} scope="col" className="th">{gate.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {candidates.map((row) => (
                  <tr key={row.org_id}>
                    <td className="td">
                      {/* The box itself stays 16px — the app's one checkbox size (ColumnChecklist)
                          — and the LABEL carries the 44px target around it, so the tap area meets
                          the floor without a checkbox that looks like a different control. */}
                      <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-action"
                          aria-label={`בחירת ${row.organization_name} לאצווה`}
                          disabled={!row.eligible}
                          checked={selected.has(row.org_id)}
                          onChange={() => toggle(row.org_id)}
                        />
                      </label>
                    </td>
                    <td className="td">{row.organization_name}</td>
                    <td className="td num">{fmtDate(row.requested_at)}</td>
                    {GATES.map((gate) => (
                      <td key={String(gate.key)} className="td">
                        <GateMark ok={Boolean(row[gate.key])} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-muted">
            {fmtNum(eligible.length)} עומדים בכל ארבעת התנאים · {fmtNum(selected.size)} נבחרו
          </span>
          <button
            type="button"
            className="btn-danger sm:ms-auto"
            disabled={selected.size === 0}
            onClick={() => setConfirming(true)}
          >
            אישור אצווה
          </button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="section-title">אצוות שאושרו</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-ink-muted">לא אושרה אף אצווה.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {batches.map((batch) => (
              <li key={batch.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">{batch.reason}</span>
                  <span className="text-ink-muted">{fmtDate(batch.approved_at)}</span>
                </div>
                <div className="text-xs text-ink-muted">
                  {fmtNum(batch.tenant_count)} ב-manifest · {fmtNum(batch.purged_count)} נמחקו ·{' '}
                  {fmtNum(batch.skipped_count)} דולגו
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirming}
        busy={busy}
        danger
        requireReason
        title={`אישור מחיקה סופית ל-${fmtNum(selected.size)} ארגונים`}
        message="האישור נועל את רשימת הארגונים ב-manifest שאינו ניתן לעריכה. הוא אינו מוחק דבר בעצמו."
        confirmLabel="אישור האצווה"
        onClose={() => setConfirming(false)}
        onConfirm={(reason) => void approve(reason ?? '')}
      />
    </div>
  );
}
