import { useId, useState } from 'react';
import { useParams } from 'react-router';
import { PauseCircle, PlayCircle, ShieldCheck, UserCog } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  Card, DataTable, EmptyState, ErrorNote, ICON, Modal, Note, PageHeader, RecordSkeleton,
  StatusBadge, useToast, type Column,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtDateTime } from '../lib/format';
import { ORG_STATUS, ACTIVE_ROLE_LABEL, ROLE_LABEL } from '../lib/status';
import { toHebrewError } from '../lib/errors';
import {
  fetchMyCapabilities, fetchPlatformUserDetail, fetchPlatformUserEvents, setPlatformUserAccess,
  type PlatformCapability, type PlatformUserDetail, type PlatformUserEvent,
} from '../lib/platform';
import { ACTIVE_ROLES, isActiveRole, type Role } from '../lib/types';

const EVENT_LABEL: Record<string, string> = {
  user_access_set: 'שינוי גישה בידי הפלטפורמה',
};

interface PendingChange {
  role: Role;
  active: boolean;
  reason: string;
}

/** The reason is not paperwork. Every command in 0214 refuses without one, and the text is what
    the customer's own audit trail will show — so the dialog says where it ends up. */
function ReasonDialog({ pending, busy, onClose, onSubmit }: {
  pending: { role: Role; active: boolean; title: string } | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [lastKey, setLastKey] = useState('');
  const key = pending ? `${pending.role}:${pending.active}` : '';
  if (pending && key !== lastKey) {
    // Reset on open rather than in an effect: a reason typed for one action must never be filed
    // against the next one.
    setLastKey(key);
    setReason('');
  }
  if (!pending) return null;

  return (
    <Modal open onClose={onClose} title={pending.title} busy={busy}>
      <div className="space-y-3">
        <label htmlFor={reasonId} className="block text-sm font-medium text-ink">
          סיבה
        </label>
        <textarea
          id={reasonId}
          className="input min-h-24 w-full"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="למשל: הבקשה הגיעה מבעל הארגון בשיחה מ-28.08"
        />
        <Note tone="info">
          <span className="min-w-0 flex-1">
            הסיבה נרשמת גם ביומן הביקורת של הארגון עצמו — בעל הארגון ומנהל החשבונות שלו יכולים
            לקרוא אותה.
          </span>
        </Note>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !reason.trim()}
            onClick={() => onSubmit(reason)}
          >
            המשך
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function UserDetail() {
  const { userId = '' } = useParams();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ role: Role; active: boolean; title: string } | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [capabilities, user, events] = await Promise.all([
      fetchMyCapabilities(),
      fetchPlatformUserDetail(userId),
      fetchPlatformUserEvents(userId),
    ]);
    return { capabilities, user, events };
  }, [userId]);

  if (loading) return <RecordSkeleton />;
  if (error) return <ErrorNote message={error} />;

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const user: PlatformUserDetail | null = data?.user ?? null;
  const events: PlatformUserEvent[] = data?.events ?? [];

  if (!capabilities.includes('user.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">כרטיס המשתמש פתוח למפעילים בעלי הרשאת צפייה במשתמשים.</span>
      </Note>
    );
  }
  if (!user) {
    return <EmptyState title="המשתמש לא נמצא" subtitle="ייתכן שהחשבון נמחק, או שהקישור שגוי" />;
  }

  const mayChange = capabilities.includes('user.access');
  const roleRetired = !isActiveRole(user.role);
  // The last active owner is the whole organization's ability to administer itself. The command
  // refuses; the screen says so in advance instead of letting the operator discover it.
  const lastOwner = user.role === 'owner' && user.active && user.org_owner_count <= 1;

  async function apply(change: PendingChange) {
    setBusy(true);
    try {
      await setPlatformUserAccess({
        userId, role: change.role, active: change.active, reason: change.reason,
      });
    } catch (rpcError) {
      setBusy(false);
      setPending(null);
      toast(toHebrewError((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setPending(null);
    toast('גישת המשתמש עודכנה');
    void refetch();
  }

  const eventColumns: Column<PlatformUserEvent>[] = [
    { key: 'when', header: 'מתי', render: (row) => fmtDateTime(row.occurred_at) },
    { key: 'what', header: 'פעולה', render: (row) => EVENT_LABEL[row.action] ?? row.action },
    {
      key: 'change', header: 'שינוי',
      render: (row) => {
        const before = row.old_values as { role?: string; active?: boolean } | null;
        const after = row.new_values as { role?: string; active?: boolean } | null;
        if (!before || !after) return <span className="text-ink-muted">—</span>;
        return (
          <span className="text-sm">
            {ROLE_LABEL[before.role ?? ''] ?? before.role} · {before.active ? 'פעיל' : 'מושהה'}
            {' ← '}
            {ROLE_LABEL[after.role ?? ''] ?? after.role} · {after.active ? 'פעיל' : 'מושהה'}
          </span>
        );
      },
    },
    { key: 'who', header: 'בידי', render: (row) => <span dir="ltr">{row.actor_email ?? '—'}</span> },
    { key: 'reason', header: 'סיבה', render: (row) => row.reason },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex items-center gap-2"><UserCog size={ICON.xl} aria-hidden="true" /> {user.full_name}</span>}
        meta={<span dir="ltr" className="text-sm text-ink-muted">{user.email ?? '—'}</span>}
      />

      <Card className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-muted">ארגון</dt>
            <dd className="mt-0.5 flex items-center gap-2 text-ink">
              {user.org_name}
              {user.org_status === 'suspended' && <StatusBadge meta={ORG_STATUS.suspended} />}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">תפקיד</dt>
            <dd className="mt-0.5 text-ink">{ROLE_LABEL[user.role] ?? user.role}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">גישה</dt>
            <dd className="mt-0.5">
              {user.active ? <span className="badge-done">פעיל</span> : <span className="badge-alert">מושהה</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">נפתח</dt>
            <dd className="mt-0.5 num text-ink">{fmtDate(user.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">כניסה אחרונה</dt>
            <dd className="mt-0.5 text-ink">
              {user.last_sign_in_at ? fmtDate(user.last_sign_in_at) : 'לא נכנס מעולם'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">כתובת דוא״ל מאומתת</dt>
            <dd className="mt-0.5 text-ink">{user.email_confirmed ? 'כן' : 'לא'}</dd>
          </div>
        </dl>

        {user.is_operator && (
          <Note tone="info">
            <span className="min-w-0 flex-1 flex items-center gap-2">
              <ShieldCheck size={ICON.sm} aria-hidden="true" />
              המשתמש הזה הוא גם מפעיל פלטפורמה
              {user.operator_roles.length > 0 && ` (${user.operator_roles.join(', ')})`}.
              הרשאות הפלטפורמה שלו נקבעות במסך „צוות הפלטפורמה", לא כאן.
            </span>
          </Note>
        )}
      </Card>

      <section className="space-y-2" aria-labelledby="access-heading">
        <h2 id="access-heading" className="section-title">גישה</h2>

        {!mayChange && (
          <Note tone="idle">
            <span className="min-w-0 flex-1">
              שינוי גישה דורש הרשאת ניהול משתמשים. הקריאה פתוחה לך, הכתיבה לא.
            </span>
          </Note>
        )}

        {mayChange && roleRetired && (
          <Note tone="alert">
            <span className="min-w-0 flex-1">
              המשתמש מחזיק בתפקיד שפרש מהמוצר. אי אפשר להפעיל אותו מחדש בתפקיד הזה — צריך לבחור
              תפקיד פעיל.
            </span>
          </Note>
        )}

        {mayChange && (
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-soft">שינוי תפקיד:</span>
              {ACTIVE_ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  className="btn-secondary"
                  disabled={busy || (role === user.role && user.active)}
                  onClick={() => setDialog({
                    role,
                    active: true,
                    title: `שינוי תפקיד ל„${ACTIVE_ROLE_LABEL[role]}"`,
                  })}
                >
                  {ACTIVE_ROLE_LABEL[role]}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {user.active ? (
                <>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy || lastOwner}
                    onClick={() => setDialog({
                      role: user.role, active: false, title: 'השהיית גישת המשתמש',
                    })}
                  >
                    <PauseCircle size={ICON.sm} aria-hidden="true" /> השהיית גישה
                  </button>
                  {lastOwner && (
                    <span className="text-sm text-ink-muted">
                      זהו הבעלים הפעיל היחיד בארגון — השהיה תשאיר את הארגון בלי מי שינהל אותו.
                    </span>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || roleRetired}
                  onClick={() => setDialog({
                    role: user.role, active: true, title: 'החזרת גישת המשתמש',
                  })}
                >
                  <PlayCircle size={ICON.sm} aria-hidden="true" /> החזרת גישה
                </button>
              )}
            </div>
          </Card>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="history-heading">
        <h2 id="history-heading" className="section-title">מה הפלטפורמה עשתה למשתמש הזה</h2>
        <DataTable
          rows={events}
          columns={eventColumns}
          emptyTitle="הפלטפורמה לא שינתה את המשתמש הזה"
          emptySubtitle="שינויים שבעל הארגון ביצע בעצמו נמצאים ביומן הביקורת של הארגון"
        />
      </section>

      <ReasonDialog
        pending={dialog}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(reason) => {
          if (!dialog) return;
          setPending({ role: dialog.role, active: dialog.active, reason });
          setDialog(null);
        }}
      />

      <ReauthModal
        open={!!pending}
        title="אימות זהות לשינוי גישת משתמש"
        onConfirm={() => { if (pending) void apply(pending); }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
