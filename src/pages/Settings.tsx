import { useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Link } from 'react-router';
import { Settings as SettingsIcon, Users, MailPlus, Send, Ban, KeyRound, ClipboardCheck } from 'lucide-react';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageHeader, SkeletonCards, useToast, ErrorNote, Note, DataTable, StatusBadge, ConfirmDialog, Modal, type Column } from '../components/ui';
import { AutonomyPolicyPanel } from '../components/AutonomyPolicyPanel';
import { ReauthModal } from '../components/ReauthModal';
import { INVITATION_STATUS } from '../lib/status';
import { fmtDate, fmtDateTime } from '../lib/format';
import {
  ASSIGNABLE_ROLES, INVITABLE_ROLES, INVITATION_COLUMNS, invitationStatusOf,
  sendInvite, resendInvite, revokeInvite, type Invitation,
} from '../lib/invitations';
import type { Profile, Role } from '../lib/types';

export default function Settings() {
  const { profile, org, roleLabels, isPlatformAdmin } = useAuth();
  const toast = useToast();
  const [vatRate, setVatRate] = useState(org?.vat_rate?.toString() ?? '18');
  const [matchDays, setMatchDays] = useState(org?.settings?.bank_match_days?.toString() ?? '7');
  const [tolerance, setTolerance] = useState(org?.settings?.bank_match_amount_tolerance?.toString() ?? '1');
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('office');
  const [inviteSupplierId, setInviteSupplierId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Separate from inviteError on purpose: the invitation WAS created, so an error tone would
  // contradict the sentence it carries. This is a standing "needs your attention" fact.
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<Invitation | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [accessTarget, setAccessTarget] = useState<Profile | null>(null);
  const [roleTarget, setRoleTarget] = useState<Profile | null>(null);
  const [nextRole, setNextRole] = useState<Role>('office');
  const [roleReason, setRoleReason] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  // Step-up gate (PLAN-04 §3.2): `manage_profile_access` asserts a fresh password AMR entry on
  // the server (0061). The pending closure holds the confirmed action while ReauthModal decides —
  // a JWT fresher than ~4 minutes skips the prompt entirely (mandatory for the B23–B24 flow,
  // where the gate logs in seconds before deactivating), a stale one asks for the password.
  const [pendingSensitive, setPendingSensitive] = useState<{ run: () => void } | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const { data: users, loading, error, refetch } = useQuery<Profile[]>(async () =>
    unwrap(await supabase.from('profiles').select('*').order('full_name')));

  const { data: invitations, refetch: refetchInvites } = useQuery<Invitation[]>(async () =>
    unwrap(await supabase.from('invitations').select(INVITATION_COLUMNS).order('created_at', { ascending: false })));

  // For the supplier-agent invitation (OPEN-DECISIONS #17): the invitation must bind to an
  // existing, non-deleted supplier. Owner-only screen, so the read is unrestricted anyway.
  const { data: suppliers } = useQuery<{ id: string; name: string }[]>(async () =>
    unwrap(await supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name')));

  async function saveOrg() {
    setBusy(true);
    const res = await supabase.from('organizations').update({
      vat_rate: Number(vatRate),
      // merge, don't replace — settings also carries keys this screen doesn't edit
      // (e.g. invite_expiry_days, read by invitation_expiry_days() in migration 0007)
      settings: {
        ...(org?.settings ?? {}),
        bank_match_days: Number(matchDays),
        bank_match_amount_tolerance: Number(tolerance),
      },
    }).eq('id', profile!.org_id);
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('ההגדרות נשמרו — ייכנסו לתוקף בכניסה הבאה');
  }

  async function changePassword() {
    const problem = passwordProblem(newPassword, confirmPassword);
    setPasswordError(problem);
    if (problem) return;
    setPasswordBusy(true);
    const res = await supabase.auth.updateUser({ password: newPassword });
    setPasswordBusy(false);
    if (res.error) { setPasswordError(toHebrewError(res.error.message)); return; }
    setNewPassword('');
    setConfirmPassword('');
    toast('הסיסמה הוחלפה. היא תידרש בכניסה הבאה.');
  }

  async function toggleActive(u: Profile, reason?: string) {
    setDialogBusy(true);
    const res = await supabase.rpc('manage_profile_access', {
      p_profile_id: u.id,
      p_role: u.role,
      p_active: !u.active,
      p_supplier_id: u.supplier_id,
      p_reason: reason?.trim() ?? '',
    });
    setDialogBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast(u.active ? 'המשתמש הושבת' : 'המשתמש הופעל');
    setAccessTarget(null);
    void refetch();
  }

  function openRoleChange(u: Profile) {
    setNextRole(u.role);
    setRoleReason('');
    setRoleTarget(u);
  }

  async function changeRole() {
    if (!roleTarget) return;
    setDialogBusy(true);
    // Reuses the same access RPC the deactivate flow uses; it audits with a reason and
    // stays the authorization boundary (only an owner may reassign roles).
    const res = await supabase.rpc('manage_profile_access', {
      p_profile_id: roleTarget.id,
      p_role: nextRole,
      p_active: roleTarget.active,
      p_supplier_id: roleTarget.supplier_id,
      p_reason: roleReason.trim(),
    });
    setDialogBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast(`התפקיד עודכן ל${roleLabels[nextRole] ?? nextRole}`);
    setRoleTarget(null);
    void refetch();
  }

  async function onInvite() {
    setInviteError(null);
    setInviteNotice(null);
    if (inviteRole === 'supplier' && !inviteSupplierId) {
      setInviteError('להזמנת סוכן ספק יש לבחור ספק מהרשימה.');
      return;
    }
    setInviting(true);
    const { error: err, result } = await sendInvite(
      inviteEmail.trim(), inviteRole, inviteRole === 'supplier' ? inviteSupplierId : undefined,
    );
    setInviting(false);
    if (err) { setInviteError(err); return; }

    const invitee = result?.email ?? inviteEmail.trim();
    // "נשלחה" is a claim about the world. With Resend's sandbox sender it was false for every
    // address but one, and the owner found out only when the person said they got nothing.
    if (result?.deliveryLimited) {
      setInviteNotice(
        `ההזמנה נוצרה עבור ${invitee} וממתינה ברשימה — אבל אין דומיין שליחה מאומת, ולכן המייל לא `
        + 'יגיע אליו. יש ליצור קשר בדרך אחרת, ולשלוח מחדש לאחר אימות דומיין.',
      );
    } else {
      toast(`ההזמנה נשלחה אל ${invitee}`);
    }
    setInviteEmail('');
    setInviteSupplierId('');
    void refetchInvites();
  }

  async function onResend() {
    if (!resendTarget) return;
    setDialogBusy(true);
    const { error: err } = await resendInvite(resendTarget.id);
    setDialogBusy(false);
    if (err) { toast(err, 'error'); return; }

    toast('ההזמנה נשלחה מחדש — הקישור הקודם בוטל');
    setResendTarget(null);
    void refetchInvites();
  }

  async function onRevoke(reason?: string) {
    if (!revokeTarget) return;
    setDialogBusy(true);
    const err = await revokeInvite(revokeTarget.id, reason?.trim() ?? '');
    setDialogBusy(false);
    if (err) { toast(err, 'error'); return; }

    toast('ההזמנה בוטלה');
    setRevokeTarget(null);
    void refetchInvites();
  }

  const inviteColumns: Column<Invitation>[] = [
    {
      key: 'email', header: 'אימייל',
      render: (r) => <span dir="ltr" className="font-medium">{r.email}</span>,
      sortValue: (r) => r.email,
    },
    { key: 'role', header: 'תפקיד', render: (r) => roleLabels[r.role] ?? r.role },
    {
      key: 'status', header: 'סטטוס',
      render: (r) => <StatusBadge meta={INVITATION_STATUS[invitationStatusOf(r)]} />,
      sortValue: (r) => invitationStatusOf(r),
    },
    { key: 'expires', header: 'בתוקף עד', render: (r) => fmtDate(r.expires_at), sortValue: (r) => r.expires_at },
    {
      key: 'sent', header: 'נשלחה',
      render: (r) => (
        <span className="text-ink-muted">
          {fmtDateTime(r.last_sent_at)}{r.send_count > 1 && ` (×${r.send_count})`}
        </span>
      ),
      sortValue: (r) => r.last_sent_at,
    },
    {
      key: 'actions', header: '',
      render: (r) => {
        const status = invitationStatusOf(r);
        if (status === 'accepted' || status === 'revoked') return null;
        return (
          <div className="flex gap-1">
            <button className="btn-ghost py-1! text-xs" onClick={() => setResendTarget(r)}>
              <Send size={13} /> שליחה מחדש
            </button>
            <button className="btn-ghost py-1! text-xs text-alert-solid hover:bg-alert-wash" onClick={() => setRevokeTarget(r)}>
              <Ban size={13} /> ביטול
            </button>
          </div>
        );
      },
    },
  ];

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader title={<span className="flex items-center gap-2"><SettingsIcon size={22} /> הגדרות מערכת</span>}
        meta="עסק, אבטחה, צוות ומדיניות עבודה"
        actions={<Link className="btn-secondary" to="/onboarding"><ClipboardCheck size={16} /> רשימת הקמה</Link>} />

      <div className="card card-pad space-y-4">
        <h2 className="section-title">הגדרות עסק</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><label className="label" htmlFor="settings-vat-rate">שיעור מע״מ (%)</label><input id="settings-vat-rate" type="number" step="0.5" className="input num" value={vatRate} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-match-days">טווח ימים להתאמת בנק</label><input id="settings-match-days" type="number" className="input num" value={matchDays} onChange={(e) => setMatchDays(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-tolerance">סטיית סכום מותרת (₪)</label><input id="settings-tolerance" type="number" step="0.5" className="input num" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></div>
        </div>
        <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void saveOrg()}>שמירה</button></div>
      </div>

      {/* The autonomy switch lives here because this is where the owner looked for it. It is
          rendered only for a platform admin, and that gate is not decoration: the command behind
          it (platform_set_autonomy_policy, 0076:270-272) raises `not_platform_admin` for anyone
          else. An owner without the grant would meet a control that refuses on submit — the exact
          shape of screen DEAD-ENDS-AUDIT.md was written about. Absent beats broken. */}
      {isPlatformAdmin && org && <AutonomyPolicyPanel orgId={org.id} orgName={org.name} />}

      <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><KeyRound size={17} /> החלפת הסיסמה שלך</h2>
          {/* OPEN-DECISIONS #114, decided 09.08.2026: employees recover their own password via
              "שכחתי סיסמה" on the login screen (ForgotPassword → ResetPassword). An org owner
              still cannot reset another user's password — that stays closed by decision, and the
              operator valve (admin-provision reset_password) remains the fallback when mail
              delivery fails. */}
          <p className="text-sm text-ink-muted mt-1">
            הסיסמה מוחלפת מיד ותידרש בכניסה הבאה. השדות כאן משנים את הסיסמה שלך בלבד.
          </p>
          <p className="text-sm text-ink-muted mt-1">
            עובד ששכח סיסמה מאפס אותה בעצמו: ״שכחתי סיסמה״ במסך הכניסה שולח קישור איפוס לכתובת המייל שלו.
            אם המייל אינו מגיע — מפעיל המערכת מנפיק סיסמה חדשה ומוסר אותה בערוץ מאובטח.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 sm:items-end">
          <div>
            <label className="label" htmlFor="new-password">סיסמה חדשה ({MIN_PASSWORD_LENGTH} תווים לפחות)</label>
            <input id="new-password" type="password" className="input" dir="ltr" autoComplete="new-password"
              value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setPasswordError(null); }} />
          </div>
          <div>
            <label className="label" htmlFor="confirm-password">אימות סיסמה</label>
            <input id="confirm-password" type="password" className="input" dir="ltr" autoComplete="new-password"
              value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(null); }} />
          </div>
          <button className="btn-primary" disabled={passwordBusy || !newPassword || !confirmPassword}
            onClick={() => void changePassword()}>החלפה</button>
        </div>
        {passwordError && <ErrorNote message={passwordError} />}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-line-soft section-title flex items-center gap-2"><Users size={17} /> משתמשים והרשאות</div>
        <div
          className="overflow-x-auto [contain:layout]"
          role="region"
          aria-label="טבלת משתמשים והרשאות"
          tabIndex={0}
        >
        <table className="w-full">
          <thead className="bg-surface-sunken"><tr><th scope="col" className="th">שם</th><th scope="col" className="th">תפקיד</th><th scope="col" className="th">טלפון</th><th scope="col" className="th">סטטוס</th><th scope="col" className="th"><span className="sr-only">פעולות</span></th></tr></thead>
          <tbody className="divide-y divide-line-soft">
            {users?.map((u) => (
              <tr key={u.id}>
                <td className="td font-medium">{u.full_name}{u.id === profile?.id && <span className="text-xs text-ink-muted ms-2">(אתה)</span>}</td>
                <td className="td">{roleLabels[u.role]}</td>
                <td className="td" dir="ltr">{u.phone ?? '—'}</td>
                <td className="td">{u.active ? <span className="badge-done">פעיל</span> : <span className="badge-idle">מושבת</span>}</td>
                  <td className="td">
                    {u.id !== profile?.id && (
                      <div className="flex flex-wrap gap-1">
                        {u.role !== 'supplier' && (
                          <button className="btn-ghost py-1! text-xs" onClick={() => openRoleChange(u)}>שינוי תפקיד</button>
                        )}
                        <button className="btn-ghost py-1! text-xs" onClick={() => setAccessTarget(u)}>{u.active ? 'השבתה' : 'הפעלה'}</button>
                      </div>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><MailPlus size={17} /> הזמנת עובד</h2>
          <p className="text-sm text-ink-muted mt-1">
            נשלח מייל עם קישור אישי להגדרת שם וסיסמה. הקישור תקף 7 ימים.
          </p>
          {/* OPEN-DECISIONS #17, decided 09.08.2026: supplier agents ARE invited from here. The
              DB path existed since 0025 (invitations.supplier_id + the 3-arg create_invitation);
              what was missing was this picker and the Edge Function forwarding. The binding is
              mandatory — invitations_supplier_role_check refuses a supplier invitation without
              a supplier, and the agent will see that supplier's price list alone. */}
          <p className="text-sm text-ink-muted mt-1">
            הזמנת סוכן ספק מחייבת שיוך לספק קיים — בחרו תפקיד ״ספק״ ואת הספק מהרשימה.
            הסוכן יקבל גישה למחירון של אותו ספק בלבד.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_11rem_auto] gap-3 sm:items-end">
          <div>
            <label className="label" htmlFor="inviteEmail">אימייל</label>
            <input id="inviteEmail" type="email" className="input" dir="ltr" placeholder="name@example.com"
              value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setInviteError(null); }} />
          </div>
          <div>
            <label className="label" htmlFor="inviteRole">תפקיד</label>
            <select id="inviteRole" className="input" value={inviteRole}
              onChange={(e) => { setInviteRole(e.target.value as Role); setInviteError(null); }}>
              {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
            </select>
          </div>
          <button className="btn-primary" disabled={inviting || !inviteEmail.trim()} onClick={() => void onInvite()}>
            {inviting ? 'שולח…' : 'שליחת הזמנה'}
          </button>
        </div>
        {inviteRole === 'supplier' && (
          <div>
            <label className="label" htmlFor="inviteSupplier">שיוך לספק</label>
            <select id="inviteSupplier" className="input" value={inviteSupplierId}
              onChange={(e) => { setInviteSupplierId(e.target.value); setInviteError(null); }}>
              <option value="">בחירת ספק…</option>
              {(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <p className="text-xs text-ink-muted mt-1">
              סוכן הספק יראה ויעדכן אך ורק את המחירון של הספק שנבחר כאן.
            </p>
          </div>
        )}
        {inviteError && <ErrorNote message={inviteError} />}
        {inviteNotice && <Note tone="await">{inviteNotice}</Note>}
      </div>

      <div className="space-y-2">
        <h2 className="section-title">הזמנות</h2>
        <DataTable
          rows={invitations ?? []}
          columns={inviteColumns}
          searchable
          searchFn={(r, q) => r.email.toLowerCase().includes(q)}
          searchLabel="חיפוש בהזמנות עובדים"
          rowLabel={(r) => `הזמנה עבור ${r.email}`}
          emptyTitle="לא נשלחו הזמנות"
          emptySubtitle="הזמנה שנשלחה תופיע כאן עם הסטטוס והתוקף שלה"
        />
      </div>

      <ConfirmDialog
        open={!!accessTarget}
        onClose={() => setAccessTarget(null)}
        onConfirm={(reason) => { if (accessTarget) setPendingSensitive({ run: () => void toggleActive(accessTarget, reason) }); }}
        title={accessTarget?.active ? 'השבתת משתמש' : 'הפעלת משתמש'}
        message={accessTarget?.active
          ? `הגישה של ${accessTarget?.full_name ?? ''} למערכת תיחסם.`
          : `הגישה של ${accessTarget?.full_name ?? ''} למערכת תוחזר.`}
        confirmLabel={accessTarget?.active ? 'השבתה' : 'הפעלה'}
        danger={accessTarget?.active}
        requireReason
        busy={dialogBusy}
      />

      <Modal
        open={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title={`שינוי תפקיד — ${roleTarget?.full_name ?? ''}`}
        description={`תפקיד נוכחי: ${roleTarget ? (roleLabels[roleTarget.role] ?? roleTarget.role) : ''}`}
        busy={dialogBusy}
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="role-change-select">תפקיד חדש</label>
            {/* ASSIGNABLE_ROLES, not INVITABLE_ROLES: an existing employee cannot become a
                supplier agent here — that would need a supplier_id this dialog has no way to
                supply. A supplier account starts as a supplier invitation. */}
            <select id="role-change-select" className="input" value={nextRole}
              onChange={(e) => setNextRole(e.target.value as Role)}>
              {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabels[r] ?? r}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="role-change-reason">סיבה</label>
            <input id="role-change-reason" className="input" value={roleReason}
              onChange={(e) => setRoleReason(e.target.value)} placeholder="למשל: החלפת מנהל רכש" />
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={dialogBusy} onClick={() => setRoleTarget(null)}>ביטול</button>
            <button className="btn-primary"
              disabled={dialogBusy || nextRole === roleTarget?.role || !roleReason.trim()}
              onClick={() => setPendingSensitive({ run: () => void changeRole() })}>שמירת התפקיד</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!resendTarget}
        onClose={() => setResendTarget(null)}
        onConfirm={() => void onResend()}
        title="שליחת ההזמנה מחדש"
        message={`יישלח מייל חדש אל ${resendTarget?.email ?? ''} עם קישור חדש ותוקף מחודש. הקישור הקודם יפסיק לעבוד.`}
        confirmLabel="שליחה"
        busy={dialogBusy}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={(reason) => void onRevoke(reason)}
        title="ביטול ההזמנה"
        message={`הקישור שנשלח אל ${revokeTarget?.email ?? ''} יפסיק לעבוד מיידית.`}
        confirmLabel="ביטול ההזמנה"
        danger
        requireReason
        busy={dialogBusy}
      />

      <ReauthModal
        open={!!pendingSensitive}
        title="אימות זהות לשינוי הרשאות"
        onConfirm={() => { const pending = pendingSensitive; setPendingSensitive(null); pending?.run(); }}
        onCancel={() => setPendingSensitive(null)}
      />
    </div>
  );
}
