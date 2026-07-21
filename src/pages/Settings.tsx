import { useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Settings as SettingsIcon, Users, MailPlus, Send, Ban } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ErrorNote, DataTable, StatusBadge, ConfirmDialog, type Column } from '../components/ui';
import { INVITATION_STATUS } from '../lib/status';
import { fmtDate, fmtDateTime } from '../lib/format';
import { logAction } from '../lib/audit';
import {
  INVITABLE_ROLES, INVITATION_COLUMNS, invitationStatusOf,
  sendInvite, resendInvite, revokeInvite, type Invitation,
} from '../lib/invitations';
import type { Profile, Role } from '../lib/types';

export default function Settings() {
  const { profile, org, roleLabels } = useAuth();
  const toast = useToast();
  const [vatRate, setVatRate] = useState(org?.vat_rate?.toString() ?? '18');
  const [matchDays, setMatchDays] = useState(org?.settings?.bank_match_days?.toString() ?? '7');
  const [tolerance, setTolerance] = useState(org?.settings?.bank_match_amount_tolerance?.toString() ?? '1');
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('office');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<Invitation | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  const { data: users, loading, error, refetch } = useQuery<Profile[]>(async () =>
    unwrap(await supabase.from('profiles').select('*').order('full_name')));

  const { data: invitations, refetch: refetchInvites } = useQuery<Invitation[]>(async () =>
    unwrap(await supabase.from('invitations').select(INVITATION_COLUMNS).order('created_at', { ascending: false })));

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

  async function toggleActive(u: Profile) {
    const res = await supabase.from('profiles').update({ active: u.active! }).eq('id', u.id);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast(u.active ? 'המשתמש הושבת' : 'המשתמש הופעל');
    void refetch();
  }

  async function onInvite() {
    setInviteError(null);
    setInviting(true);
    const { error: err, result } = await sendInvite(inviteEmail.trim(), inviteRole);
    setInviting(false);
    if (err) { setInviteError(err); return; }

    await logAction({
      orgId: profile!.org_id,
      action: 'invitation_sent',
      entityType: 'invitations',
      entityId: result?.invitationId,
      newValues: { email: inviteEmail.trim().toLowerCase(), role: inviteRole },
    });
    toast(`ההזמנה נשלחה אל ${result?.email ?? inviteEmail.trim()}`);
    setInviteEmail('');
    void refetchInvites();
  }

  async function onResend() {
    if (!resendTarget) return;
    setDialogBusy(true);
    const { error: err } = await resendInvite(resendTarget.id);
    setDialogBusy(false);
    if (err) { toast(err, 'error'); return; }

    await logAction({
      orgId: profile!.org_id,
      action: 'invitation_resent',
      entityType: 'invitations',
      entityId: resendTarget.id,
      newValues: { email: resendTarget.email },
    });
    toast('ההזמנה נשלחה מחדש — הקישור הקודם בוטל');
    setResendTarget(null);
    void refetchInvites();
  }

  async function onRevoke(reason?: string) {
    if (!revokeTarget) return;
    setDialogBusy(true);
    const err = await revokeInvite(revokeTarget.id);
    setDialogBusy(false);
    if (err) { toast(err, 'error'); return; }

    await logAction({
      orgId: profile!.org_id,
      action: 'invitation_revoked',
      entityType: 'invitations',
      entityId: revokeTarget.id,
      reason,
      oldValues: { email: revokeTarget.email, role: revokeTarget.role },
    });
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
        <span className="text-slate-500">
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
            <button className="btn-ghost py-1! text-xs text-rose-600 hover:bg-rose-50" onClick={() => setRevokeTarget(r)}>
              <Ban size={13} /> ביטול
            </button>
          </div>
        );
      },
    },
  ];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="page-title flex items-center gap-2"><SettingsIcon size={22} /> הגדרות מערכת</h1>

      <div className="card card-pad space-y-4">
        <h2 className="section-title">הגדרות עסק</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><label className="label">שיעור מע״מ (%)</label><input type="number" step="0.5" className="input num" value={vatRate} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label">טווח ימים להתאמת בנק</label><input type="number" className="input num" value={matchDays} onChange={(e) => setMatchDays(e.target.value)} /></div>
          <div><label className="label">סטיית סכום מותרת (₪)</label><input type="number" step="0.5" className="input num" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></div>
        </div>
        <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void saveOrg()}>שמירה</button></div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 section-title flex items-center gap-2"><Users size={17} /> משתמשים והרשאות</div>
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">שם</th><th className="th">תפקיד</th><th className="th">טלפון</th><th className="th">סטטוס</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {users?.map((u) => (
              <tr key={u.id}>
                <td className="td font-medium">{u.full_name}{u.id === profile?.id && <span className="text-xs text-slate-400 ms-2">(אתה)</span>}</td>
                <td className="td">{roleLabels[u.role]}</td>
                <td className="td" dir="ltr">{u.phone ?? '—'}</td>
                <td className="td">{u.active ? <span className="badge-done">פעיל</span> : <span className="badge-idle">מושבת</span>}</td>
                <td className="td">
                  {u.id !== profile?.id && (
                    <button className="btn-ghost py-1! text-xs" onClick={() => void toggleActive(u)}>{u.active ? 'השבתה' : 'הפעלה'}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><MailPlus size={17} /> הזמנת עובד</h2>
          <p className="text-sm text-slate-500 mt-1">
            נשלח מייל עם קישור אישי להגדרת שם וסיסמה. הקישור תקף 7 ימים.
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
            <select id="inviteRole" className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
            </select>
          </div>
          <button className="btn-primary" disabled={inviting || !inviteEmail.trim()} onClick={() => void onInvite()}>
            {inviting ? 'שולח…' : 'שליחת הזמנה'}
          </button>
        </div>
        {inviteError && <ErrorNote message={inviteError} />}
      </div>

      <div className="space-y-2">
        <h2 className="section-title">הזמנות</h2>
        <DataTable
          rows={invitations ?? []}
          columns={inviteColumns}
          searchable
          searchFn={(r, q) => r.email.toLowerCase().includes(q)}
          emptyTitle="לא נשלחו הזמנות"
          emptySubtitle="הזמנה שנשלחה תופיע כאן עם הסטטוס והתוקף שלה"
        />
      </div>

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
    </div>
  );
}
