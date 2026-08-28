import { useId, useState } from 'react';
import { ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import {
  DataTable, ErrorNote, ICON, Modal, Note, PageHeader, SkeletonTable, useToast,
  type Column,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDateTime } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  addOperator, fetchMyCapabilities, fetchOperatorEvents, fetchPlatformOperators,
  fetchPlatformRoles, removeOperator, setOperatorRoles,
  type PlatformCapability, type PlatformOperator, type PlatformOperatorEvent, type PlatformRole,
} from '../lib/platform';

const EVENT_LABEL: Record<string, string> = {
  operator_added: 'מפעיל נוסף',
  operator_removed: 'מפעיל הוסר',
  operator_roles_set: 'תפקידים עודכנו',
};

type Command =
  | { kind: 'add'; email: string; note: string; roleKey: string; reason: string }
  | { kind: 'roles'; userId: string; roleKeys: string[]; reason: string }
  | { kind: 'remove'; userId: string; reason: string };

function AddOperatorDialog({ open, roles, busy, onClose, onSubmit }: {
  open: boolean;
  roles: PlatformRole[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; note: string; roleKey: string; reason: string }) => void;
}) {
  const emailId = useId();
  const noteId = useId();
  const roleId = useId();
  const reasonId = useId();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [reason, setReason] = useState('');

  if (!open) return null;
  const chosen = roleKey || roles[0]?.role_key || '';

  return (
    <Modal open onClose={onClose} title="הוספת מפעיל" busy={busy}>
      <div className="space-y-3">
        <Note tone="info">
          <span className="min-w-0 flex-1">
            הפעולה מעניקה הרשאה לחשבון שכבר קיים במערכת — היא אינה פותחת חשבון חדש. אם החשבון
            טרם נפתח, הכניסה הרגילה היא שפותחת אותו.
          </span>
        </Note>
        <div>
          <label htmlFor={emailId} className="block text-sm font-medium text-ink">כתובת דוא״ל</label>
          <input
            id={emailId} dir="ltr" type="email" className="input mt-1 w-full"
            value={email} onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={roleId} className="block text-sm font-medium text-ink">תפקיד</label>
          <select
            id={roleId} className="input mt-1 w-full"
            value={chosen} onChange={(event) => setRoleKey(event.target.value)}
          >
            {roles.map((role) => (
              <option key={role.role_key} value={role.role_key}>{role.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={noteId} className="block text-sm font-medium text-ink">מי זה (לרשומה)</label>
          <input
            id={noteId} className="input mt-1 w-full"
            value={note} onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={reasonId} className="block text-sm font-medium text-ink">סיבה</label>
          <textarea
            id={reasonId} className="input mt-1 min-h-20 w-full"
            value={reason} onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button
            type="button" className="btn-primary"
            disabled={busy || !email.trim() || !reason.trim() || !chosen}
            onClick={() => onSubmit({ email, note, roleKey: chosen, reason })}
          >
            הוספה
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RolesDialog({ operator, roles, busy, onClose, onSubmit }: {
  operator: PlatformOperator | null;
  roles: PlatformRole[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { roleKeys: string[]; reason: string }) => void;
}) {
  const reasonId = useId();
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [lastKey, setLastKey] = useState('');
  if (operator && operator.user_id !== lastKey) {
    setLastKey(operator.user_id);
    setChosen(operator.roles);
    setReason('');
  }
  if (!operator) return null;

  return (
    <Modal open onClose={onClose} title={`תפקידים — ${operator.email}`} busy={busy}>
      <div className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">תפקידים</legend>
          {roles.map((role) => (
            <label key={role.role_key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={chosen.includes(role.role_key)}
                onChange={(event) => setChosen((current) => (event.target.checked
                  ? [...current, role.role_key]
                  : current.filter((key) => key !== role.role_key)))}
              />
              <span className="min-w-0">
                <span className="text-ink">{role.label}</span>
                <span className="block text-xs text-ink-muted">{role.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <label htmlFor={reasonId} className="block text-sm font-medium text-ink">סיבה</label>
          <textarea
            id={reasonId} className="input mt-1 min-h-20 w-full"
            value={reason} onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button
            type="button" className="btn-primary"
            disabled={busy || chosen.length === 0 || !reason.trim()}
            onClick={() => onSubmit({ roleKeys: chosen, reason })}
          >
            שמירה
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RemoveDialog({ operator, busy, onClose, onSubmit }: {
  operator: PlatformOperator | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [lastKey, setLastKey] = useState('');
  if (operator && operator.user_id !== lastKey) {
    setLastKey(operator.user_id);
    setReason('');
  }
  if (!operator) return null;

  return (
    <Modal open onClose={onClose} title={`הסרת מפעיל — ${operator.email}`} busy={busy}>
      <div className="space-y-3">
        <Note tone="alert">
          <span className="min-w-0 flex-1">
            הגישה לקונסולה נשללת מיד. חשבון המשתמש עצמו אינו נמחק, והיומן שומר את הרשומה.
          </span>
        </Note>
        <div>
          <label htmlFor={reasonId} className="block text-sm font-medium text-ink">סיבה</label>
          <textarea
            id={reasonId} className="input mt-1 min-h-20 w-full"
            value={reason} onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button
            type="button" className="btn-danger" disabled={busy || !reason.trim()}
            onClick={() => onSubmit(reason)}
          >
            הסרה
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Our own side of the roster.
 *
 * 0006, 0151 and 0153 all said this table had no write path on purpose. It has one now, on an
 * explicit owner decision, and the screen is built around the two rules that keep it narrow:
 * nobody edits their own authority, and the roster can never be left without a super admin. Both
 * are enforced in the command; the screen states them rather than letting an operator find out
 * by being refused.
 */
export default function Team() {
  const { session } = useAuth();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PlatformOperator | null>(null);
  const [removing, setRemoving] = useState<PlatformOperator | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [capabilities, operators, roles, events] = await Promise.all([
      fetchMyCapabilities(),
      fetchPlatformOperators(),
      fetchPlatformRoles(),
      fetchOperatorEvents(),
    ]);
    return { capabilities, operators, roles, events };
  }, []);

  if (loading) return <SkeletonTable cols={4} />;
  if (error) return <ErrorNote message={error} />;

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const operators: PlatformOperator[] = data?.operators ?? [];
  const roles: PlatformRole[] = data?.roles ?? [];
  const events: PlatformOperatorEvent[] = data?.events ?? [];
  const mayManage = capabilities.includes('operator.manage');
  const me = session?.user.id ?? null;

  async function run(command: Command) {
    setBusy(true);
    try {
      if (command.kind === 'add') {
        await addOperator({
          email: command.email.trim(),
          note: command.note.trim() || null,
          roleKey: command.roleKey,
          reason: command.reason,
        });
      } else if (command.kind === 'roles') {
        await setOperatorRoles({
          userId: command.userId, roleKeys: command.roleKeys, reason: command.reason,
        });
      } else {
        await removeOperator(command.userId, command.reason);
      }
    } catch (rpcError) {
      setBusy(false);
      setPending(null);
      toast(toHebrewError((rpcError as Error).message), 'error');
      return;
    }
    setBusy(false);
    setPending(null);
    setAdding(false);
    setEditing(null);
    setRemoving(null);
    toast('רשימת המפעילים עודכנה');
    void refetch();
  }

  const roleLabel = (key: string) => roles.find((role) => role.role_key === key)?.label ?? key;

  // DataTable keys its rows on `id`; the roster's identity is the user. One mapped field beats
  // teaching the table a second key name.
  type OperatorRow = PlatformOperator & { id: string };
  const operatorRows: OperatorRow[] = operators.map((row) => ({ ...row, id: row.user_id }));

  const operatorColumns: Column<OperatorRow>[] = [
    {
      key: 'email', header: 'מפעיל', priority: 3,
      render: (row) => (
        <div className="min-w-0">
          <div dir="ltr" className="truncate font-medium text-ink">{row.email}</div>
          {row.note && <div className="truncate text-xs text-ink-muted">{row.note}</div>}
        </div>
      ),
    },
    {
      key: 'roles', header: 'תפקידים',
      render: (row) => (row.roles.length
        ? <span className="flex flex-wrap gap-1">
            {row.roles.map((key) => <span key={key} className="badge-idle">{roleLabel(key)}</span>)}
          </span>
        : <span className="badge-alert">ללא תפקיד</span>),
    },
    {
      key: 'actions', header: '', mobileLabel: null,
      render: (row) => {
        if (!mayManage) return null;
        // The self rule, said before it is enforced. An operator who sees the buttons and is
        // then refused learns the same thing more slowly and less kindly.
        if (row.user_id === me) {
          return <span className="text-xs text-ink-muted">אי אפשר לשנות את ההרשאות של עצמך</span>;
        }
        return (
          <span className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => setEditing(row)}>
              תפקידים
            </button>
            <button type="button" className="btn-ghost" onClick={() => setRemoving(row)}>
              <UserMinus size={ICON.sm} aria-hidden="true" /> הסרה
            </button>
          </span>
        );
      },
    },
  ];

  const eventColumns: Column<PlatformOperatorEvent>[] = [
    { key: 'when', header: 'מתי', render: (row) => fmtDateTime(row.occurred_at) },
    { key: 'what', header: 'פעולה', render: (row) => EVENT_LABEL[row.action] ?? row.action },
    { key: 'subject', header: 'על מי', render: (row) => <span dir="ltr">{row.subject_email ?? '—'}</span> },
    { key: 'actor', header: 'בידי', render: (row) => <span dir="ltr">{row.actor_email ?? '—'}</span> },
    { key: 'reason', header: 'סיבה', render: (row) => row.reason },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex items-center gap-2"><ShieldCheck size={ICON.xl} aria-hidden="true" /> צוות הפלטפורמה</span>}
        description="מי מאיתנו מחזיק בגישה לקונסולה, ובאיזו רמה."
        actions={mayManage ? (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <UserPlus size={ICON.sm} aria-hidden="true" /> הוספת מפעיל
          </button>
        ) : null}
      />

      {!mayManage && (
        <Note tone="idle">
          <span className="min-w-0 flex-1">
            הרשימה פתוחה לקריאה לכל מפעיל. שינוי הרכב הצוות שמור למנהל פלטפורמה ראשי.
          </span>
        </Note>
      )}

      <DataTable
        rows={operatorRows}
        columns={operatorColumns}
        emptyTitle="אין מפעילים"
        emptySubtitle="רשימה ריקה כאן משמעה שאף אחד אינו יכול להיכנס לקונסולה"
      />

      <Note tone="idle">
        <span className="min-w-0 flex-1">
          שתי מגבלות שהמערכת אוכפת ואי אפשר לעקוף מהמסך הזה: אף אחד אינו יכול לשנות את ההרשאות
          של עצמו, ולא ניתן להסיר או להוריד בדרגה את מנהל הפלטפורמה הראשי האחרון. כל שינוי דורש
          אימות סיסמה מחדש ונרשם ביומן שלמטה.
        </span>
      </Note>

      <section className="space-y-2" aria-labelledby="team-history-heading">
        <h2 id="team-history-heading" className="section-title">יומן שינויים</h2>
        <DataTable
          rows={events}
          columns={eventColumns}
          emptyTitle="לא נרשם שינוי בהרכב הצוות"
        />
      </section>

      <AddOperatorDialog
        open={adding}
        roles={roles}
        busy={busy}
        onClose={() => setAdding(false)}
        onSubmit={(input) => setPending({ kind: 'add', ...input })}
      />

      <RolesDialog
        operator={editing}
        roles={roles}
        busy={busy}
        onClose={() => setEditing(null)}
        onSubmit={({ roleKeys, reason }) => {
          if (editing) setPending({ kind: 'roles', userId: editing.user_id, roleKeys, reason });
        }}
      />

      <RemoveDialog
        operator={removing}
        busy={busy}
        onClose={() => setRemoving(null)}
        onSubmit={(reason) => {
          if (removing) setPending({ kind: 'remove', userId: removing.user_id, reason });
        }}
      />

      <ReauthModal
        open={!!pending}
        title="אימות זהות לשינוי הרשאות פלטפורמה"
        onConfirm={() => { if (pending) void run(pending); }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
