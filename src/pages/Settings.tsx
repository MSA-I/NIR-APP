import { useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { Link } from 'react-router';
import { Settings as SettingsIcon, Users, MailPlus, Send, Ban, KeyRound, ClipboardCheck, ImageUp, Download, Undo2, LogOut } from 'lucide-react';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageHeader, SkeletonCards, useToast, ErrorNote, Note, DataTable, StatusBadge, ConfirmDialog, Modal, type Column } from '../components/ui';
import { AutonomyPolicyPanel } from '../components/AutonomyPolicyPanel';
import { ExportTemplatesPanel } from '../components/ExportTemplatesPanel';
import { ReauthModal } from '../components/ReauthModal';
import { INVITATION_STATUS } from '../lib/status';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import {
  ASSIGNABLE_ROLES, INVITABLE_ROLES, INVITATION_COLUMNS, invitationStatusOf,
  sendInvite, resendInvite, revokeInvite, type Invitation,
} from '../lib/invitations';
import type { Profile, Role } from '../lib/types';
import {
  BRAND_LOGO_TYPES,
  brandFailureAllowsNewCorrelation,
  brandLogoProblem,
} from '../lib/organizationBranding';

interface OffboardingState {
  id: string;
  status: 'requested' | 'approved' | 'export_building' | 'export_ready' | 'export_failed' | 'cancelled' | 'reactivated';
  requested_at: string;
  approved_at: string | null;
  cancellation_deadline: string;
  platform_reactivation_deadline: string;
  operational_purge_eligible_at: string;
  security_logs_retain_until: string;
  financial_records_retain_until: string;
  export_completed_at: string | null;
  export_size_bytes: number | null;
  export_file_count: number | null;
  export_parts_total: number;
  export_parts_completed: number;
  last_export_error: string | null;
  can_owner_cancel: boolean;
}

const OFFBOARDING_STATUS_LABELS: Record<OffboardingState['status'], string> = {
  requested: 'הבקשה נשלחה',
  approved: 'הבקשה אושרה — הייצוא ממתין להכנה',
  export_building: 'מכינים את קובצי הייצוא',
  export_ready: 'הייצוא מוכן להורדה',
  export_failed: 'הכנת הייצוא דורשת טיפול',
  cancelled: 'הבקשה בוטלה',
  reactivated: 'הארגון הופעל מחדש',
};

/** Keep command identity across a lost response or refresh; clear it only after reconciliation. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function stableSessionUuid(key: string): string {
  const existing = window.sessionStorage.getItem(key);
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(key, created);
  return created;
}

async function logoUploadSessionKey(orgId: string, file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `supplyflow:branding:upload:${orgId}:${hex}`;
}

export default function Settings() {
  const { profile, org, roleLabels, isPlatformAdmin, organizationAccess, refreshOrganizationAccess } = useAuth();
  const canWrite = organizationAccess?.canWrite ?? true;
  // The two roles 0126's template commands accept. Named once, used by the panel gate below.
  const isOffice = profile?.role === 'owner' || profile?.role === 'office';
  const toast = useToast();
  const [orgName, setOrgName] = useState(org?.name ?? '');
  const [vatRate, setVatRate] = useState(org?.vat_rate?.toString() ?? '18');
  const [matchDays, setMatchDays] = useState(org?.settings?.bank_match_days?.toString() ?? '7');
  const [tolerance, setTolerance] = useState(org?.settings?.bank_match_amount_tolerance?.toString() ?? '1');
  const [busy, setBusy] = useState(false);
  const [logoPath, setLogoPath] = useState(org?.logo_path ?? null);
  const [logoVersion, setLogoVersion] = useState(org?.logo_updated_at ?? '');
  const [logoBusy, setLogoBusy] = useState(false);
  const [offboardingBusy, setOffboardingBusy] = useState(false);
  const [offboardingAction, setOffboardingAction] = useState<'request' | 'cancel' | 'download' | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('office');
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

  const { data: offboardingRows, error: offboardingError, refetch: refetchOffboarding } = useQuery<OffboardingState[]>(async () =>
    unwrap(await supabase.rpc('organization_offboarding_state')) as OffboardingState[]);
  const offboarding = offboardingRows?.[0] ?? null;
  const offboardingOpen = !!offboarding && !['cancelled', 'reactivated'].includes(offboarding.status);

  async function runOffboardingAction(action: 'request' | 'cancel' | 'download') {
    setOffboardingBusy(true);
    try {
      if (action === 'request') {
        const keyName = `supplyflow:offboarding:request:${profile?.org_id ?? 'unknown'}`;
        const idempotencyKey = stableSessionUuid(keyName);
        const requested = await supabase.rpc('request_organization_offboarding', {
          p_idempotency_key: idempotencyKey,
        });
        if (requested.error) throw requested.error;
        window.sessionStorage.removeItem(keyName);
        toast('בקשת סיום השירות התקבלה. המערכת עברה למצב קריאה בלבד.');
      } else if (action === 'cancel') {
        if (!offboarding?.id) throw new Error('offboarding_request_unknown');
        const keyName = `supplyflow:offboarding:cancel:${offboarding.id}`;
        const idempotencyKey = stableSessionUuid(keyName);
        const cancelled = await supabase.rpc('cancel_organization_offboarding', {
          p_request_id: offboarding.id,
          p_idempotency_key: idempotencyKey,
        });
        if (cancelled.error) throw cancelled.error;
        window.sessionStorage.removeItem(keyName);
        toast('בקשת סיום השירות בוטלה והגישה המלאה שוחזרה.');
      } else {
        if (!offboarding?.id) throw new Error('offboarding_request_unknown');
        const link = await supabase.functions.invoke<{ signed_url: string; expires_at: string }>('tenant-export', {
          body: { action: 'download', request_id: offboarding.id },
        });
        if (link.error || !link.data?.signed_url) throw link.error ?? new Error('export_link_unavailable');
        window.location.assign(link.data.signed_url);
      }
      await Promise.all([refetchOffboarding(), refreshOrganizationAccess()]);
    } catch (actionError) {
      toast(toHebrewError(actionError), 'error');
    } finally {
      setOffboardingBusy(false);
    }
  }

  async function saveOrg() {
    const name = orgName.trim();
    if (!name || name.length > 120) {
      toast('שם הארגון חייב לכלול 1–120 תווים.', 'error');
      return;
    }
    setBusy(true);
    const res = await supabase.from('organizations').update({
      name,
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

  async function uploadLogo(file: File | undefined) {
    if (!file || !org) return;
    const problem = await brandLogoProblem(file);
    if (problem) { toast(problem, 'error'); return; }
    setLogoBusy(true);
    let keyName: string | null = null;
    try {
      keyName = await logoUploadSessionKey(org.id, file);
      const correlationId = stableSessionUuid(keyName);
      const body = new FormData();
      body.append('file', file);
      const uploaded = await supabase.functions.invoke<{
        path: string; updated_at: string; cleanup_failed: boolean;
      }>(
        'upload-organization-logo', {
          body,
          headers: { 'x-correlation-id': correlationId },
        },
      );
      if (uploaded.error || !uploaded.data?.path || !uploaded.data.updated_at) {
        throw uploaded.error ?? new Error('organization_logo_upload_failed');
      }
      setLogoPath(uploaded.data.path);
      setLogoVersion(uploaded.data.updated_at);
      window.sessionStorage.removeItem(keyName);
      toast(uploaded.data.cleanup_failed
        ? 'הלוגו נשמר, אך ניקוי הגרסה הקודמת נכשל.'
        : 'הלוגו נשמר. בכניסה הבאה יופיע בכל הממשק.');
    } catch (error) {
      if (keyName && brandFailureAllowsNewCorrelation(error)) {
        window.sessionStorage.removeItem(keyName);
      }
      toast(toHebrewError(error), 'error');
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeLogo() {
    if (!org || !logoPath) return;
    setLogoBusy(true);
    const keyName = `supplyflow:branding:remove:${org.id}:${logoPath}`;
    try {
      const correlationId = stableSessionUuid(keyName);
      const body = new FormData();
      body.append('action', 'remove');
      const removed = await supabase.functions.invoke<{ cleanup_failed: boolean }>(
        'upload-organization-logo', {
          body,
          headers: { 'x-correlation-id': correlationId },
        },
      );
      if (removed.error) throw removed.error;
      window.sessionStorage.removeItem(keyName);
      setLogoPath(null);
      setLogoVersion('');
      toast(removed.data?.cleanup_failed
        ? 'הלוגו הוסר מהממשק, אך ניקוי קובץ המקור נכשל.'
        : 'הלוגו הוסר.');
    } catch (error) {
      if (brandFailureAllowsNewCorrelation(error)) {
        window.sessionStorage.removeItem(keyName);
      }
      toast(toHebrewError(error), 'error');
    } finally {
      setLogoBusy(false);
    }
  }

  const logoUrl = logoPath
    ? `${supabase.storage.from('organization-branding').getPublicUrl(logoPath).data.publicUrl}?v=${encodeURIComponent(logoVersion)}`
    : null;

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
    setInviting(true);
    const { error: err, result } = await sendInvite(inviteEmail.trim(), inviteRole);
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
        if (!canWrite || status === 'accepted' || status === 'revoked') return null;
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
          <div className="sm:col-span-3"><label className="label" htmlFor="settings-org-name">שם הארגון לתצוגה</label><input id="settings-org-name" className="input" maxLength={120} value={orgName} disabled={!canWrite} onChange={(e) => setOrgName(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-vat-rate">שיעור מע״מ (%)</label><input id="settings-vat-rate" type="number" step="0.5" className="input num" value={vatRate} disabled={!canWrite} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-match-days">טווח ימים להתאמת בנק</label><input id="settings-match-days" type="number" className="input num" value={matchDays} disabled={!canWrite} onChange={(e) => setMatchDays(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-tolerance">סטיית סכום מותרת (₪)</label><input id="settings-tolerance" type="number" step="0.5" className="input num" value={tolerance} disabled={!canWrite} onChange={(e) => setTolerance(e.target.value)} /></div>
        </div>
        {canWrite && <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void saveOrg()}>שמירה</button></div>}
      </div>

      <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><ImageUp size={17} /> לוגו הארגון</h2>
          <p className="mt-1 text-sm text-ink-muted">PNG, JPEG או WebP עד 2MB. הלוגו מופיע בסרגל המערכת ובהדפסת הדוח החודשי.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {logoUrl ? <img src={logoUrl} alt={`לוגו ${orgName}`} className="h-14 w-28 rounded-lg border border-line bg-white object-contain p-1" /> : <div className="flex h-14 w-28 items-center justify-center rounded-lg border border-dashed border-line text-xs text-ink-muted">ללא לוגו</div>}
          {canWrite && <label className="btn-secondary cursor-pointer">
            <ImageUp size={15} /> {logoPath ? 'החלפת לוגו' : 'העלאת לוגו'}
            <input type="file" className="sr-only" accept={BRAND_LOGO_TYPES.join(',')} disabled={logoBusy}
              onChange={(event) => { void uploadLogo(event.target.files?.[0]); event.currentTarget.value = ''; }} />
          </label>}
          {canWrite && logoPath && <button type="button" className="btn-ghost" disabled={logoBusy} onClick={() => void removeLogo()}>הסרת לוגו</button>}
        </div>
      </div>

      {/* The autonomy switch lives here because this is where the owner looked for it. It is
          rendered only for a platform admin, and that gate is not decoration: the command behind
          it (platform_set_autonomy_policy, 0076:270-272) raises `not_platform_admin` for anyone
          else. An owner without the grant would meet a control that refuses on submit — the exact
          shape of screen DEAD-ENDS-AUDIT.md was written about. Absent beats broken. */}
      {canWrite && isPlatformAdmin && org && <AutonomyPolicyPanel orgId={org.id} orgName={org.name} />}

      {/* Package K. Gated on the same two roles 0126's commands accept, for the reason the autonomy
          panel above states: a control that refuses on submit is worse than a control that is not
          there. `resolve_export_report_template` also admits the accountant, but reading which
          template their report uses belongs beside the report, not in the owner's settings. */}
      {canWrite && org && isOffice && <ExportTemplatesPanel orgId={org.id} />}

      <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><LogOut size={17} /> סיום שירות וייצוא מידע</h2>
          <p className="mt-1 text-sm text-ink-muted">
            בקשת סיום שירות מעבירה את הארגון מיד למצב קריאה בלבד. המידע נשאר זמין לצפייה, והמערכת מכינה ייצוא של הנתונים העסקיים ב־CSV וב־JSON יחד עם מסמכי המקור.
          </p>
        </div>
        {offboardingError && <ErrorNote message={offboardingError} />}
        {offboarding && (
          <div className="rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm">
            <div className="font-medium text-ink">{OFFBOARDING_STATUS_LABELS[offboarding.status]}</div>
            <div className="mt-1 text-ink-muted">
              הבקשה נפתחה ב־<span className="num">{fmtDateTime(offboarding.requested_at)}</span>. אפשר לבטל עד <span className="num">{fmtDateTime(offboarding.cancellation_deadline)}</span>.
            </div>
            {offboarding.status === 'export_ready' && offboarding.export_completed_at && (
              <div className="mt-1 text-ink-muted">
                הייצוא הושלם ב־<span className="num">{fmtDateTime(offboarding.export_completed_at)}</span>. קישור חדש יהיה תקף לשבעה ימים וניתן לביטול.
              </div>
            )}
            {offboarding.status === 'export_building' && offboarding.export_parts_total > 0 && (
              <div className="mt-1 text-ink-muted" role="status">
                הושלמו <span className="num">{fmtNum(offboarding.export_parts_completed)}</span> מתוך <span className="num">{fmtNum(offboarding.export_parts_total)}</span> חלקי ייצוא. אפשר לצאת מהמסך; ההתקדמות נשמרת בשרת.
              </div>
            )}
            {offboarding.status === 'export_failed' && (
              <div role="alert" className="mt-2 text-alert-fg">הכנת הייצוא לא הושלמה. מנהל השירות יכול להפעיל ניסיון חוזר בטוח.</div>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {!offboardingOpen && (
            <button type="button" className="btn-secondary text-alert-solid" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('request')}>
              <LogOut size={15} /> בקשת סיום שירות
            </button>
          )}
          {offboarding?.status === 'export_ready' && (
            <button type="button" className="btn-primary" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('download')}>
              <Download size={15} /> יצירת קישור הורדה
            </button>
          )}
          {offboardingOpen && offboarding.can_owner_cancel && (
            <button type="button" className="btn-secondary" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('cancel')}>
              <Undo2 size={15} /> ביטול בקשת הסיום
            </button>
          )}
        </div>
      </div>

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
                    {canWrite && u.id !== profile?.id && (
                      <div className="flex flex-wrap gap-1">
                        {u.active && (
                          <button className="btn-ghost py-1! text-xs" onClick={() => openRoleChange(u)}>שינוי תפקיד</button>
                        )}
                        {(u.active || ASSIGNABLE_ROLES.includes(u.role)) && (
                          <button className="btn-ghost py-1! text-xs" onClick={() => setAccessTarget(u)}>{u.active ? 'השבתה' : 'הפעלה'}</button>
                        )}
                      </div>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {canWrite && <div className="card card-pad space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><MailPlus size={17} /> הזמנת עובד</h2>
          <p className="text-sm text-ink-muted mt-1">
            נשלח מייל עם קישור אישי להגדרת שם וסיסמה. הקישור תקף 7 ימים.
          </p>
          <p className="text-sm text-ink-muted mt-1">
            ניתן להזמין מנהל, מנהל רכש או רואה חשבון. ספקים ועובדי תפעול אינם חשבונות מערכת.
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
        {inviteError && <ErrorNote message={inviteError} />}
        {inviteNotice && <Note tone="await">{inviteNotice}</Note>}
      </div>}

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
            {/* The enum carries historical roles; ASSIGNABLE_ROLES is the active product contract. */}
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
      <ReauthModal
        open={offboardingAction !== null}
        title={offboardingAction === 'request'
          ? 'אימות זהות לפני בקשת סיום שירות'
          : offboardingAction === 'cancel'
            ? 'אימות זהות לפני ביטול בקשת הסיום'
            : 'אימות זהות לפני יצירת קישור ייצוא'}
        onConfirm={() => {
          const action = offboardingAction;
          setOffboardingAction(null);
          if (action) void runOffboardingAction(action);
        }}
        onCancel={() => setOffboardingAction(null)}
      />
    </div>
  );
}
