import type { TKey } from '../lib/i18n/t';
import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { Link } from 'react-router';
import { Settings as SettingsIcon, Users, MailPlus, Send, Ban, KeyRound, ClipboardCheck, ImageUp, Download, Undo2, UserCog, LogOut } from 'lucide-react';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Card, PageHeader, SkeletonCards, useToast, ErrorNote, ICON, Note, DataTable, Disclosure, StatusBadge, SubPanel, ConfirmDialog, Modal, type Column } from '../components/ui';
import { ActionMenu, type ActionMenuItem } from '../components/ActionMenu';
import { ExportTemplatesPanel } from '../components/ExportTemplatesPanel';
import { ReauthModal } from '../components/ReauthModal';
import { LanguageSetting } from '../lib/i18n/LanguageSetting';
import { INVITATION_STATUS } from '../lib/status';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import {
  ASSIGNABLE_ROLES, INVITABLE_ROLES, INVITATION_COLUMNS, invitationStatusOf,
  sendInvite, resendInvite, revokeInvite, type Invitation,
} from '../lib/invitations';
import { isActiveRole, type ActiveRole, type Profile } from '../lib/types';
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

const OFFBOARDING_STATUS_KEYS: Record<OffboardingState['status'], TKey> = {
  requested: 'settings.offboardingRequested',
  approved: 'settings.offboardingApproved',
  export_building: 'settings.offboardingExportBuilding',
  export_ready: 'settings.offboardingExportReady',
  export_failed: 'settings.offboardingExportFailed',
  cancelled: 'settings.offboardingCancelled',
  reactivated: 'settings.offboardingReactivated',
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
  const { errorText, t } = useT();
  const { profile, org, roleLabels, organizationAccess, refreshOrganizationAccess } = useAuth();
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
  const [inviteRole, setInviteRole] = useState<ActiveRole>('office');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Separate from inviteError on purpose: the invitation WAS created, so an error tone would
  // contradict the sentence it carries. This is a standing "needs your attention" fact.
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<Invitation | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);
  const [accessTarget, setAccessTarget] = useState<Profile | null>(null);
  const [roleTarget, setRoleTarget] = useState<Profile | null>(null);
  const [nextRole, setNextRole] = useState<ActiveRole>('office');
  const [roleReason, setRoleReason] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  // Step-up gate (migration 0061): `manage_profile_access` asserts a fresh password AMR entry on
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
        toast(t('settings.toast'));
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
        toast(t('settings.toast_2'));
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
      toast(errorText(actionError), 'error');
    } finally {
      setOffboardingBusy(false);
    }
  }

  async function saveOrg() {
    const name = orgName.trim();
    if (!name || name.length > 120) {
      toast(t('settings.toast_3'), 'error');
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('settings.toast_4'));
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
        ? t('settings.text')
        : t('settings.text_2'));
    } catch (error) {
      if (keyName && brandFailureAllowsNewCorrelation(error)) {
        window.sessionStorage.removeItem(keyName);
      }
      toast(errorText(error), 'error');
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
        ? t('settings.text_3')
        : t('settings.text_4'));
    } catch (error) {
      if (brandFailureAllowsNewCorrelation(error)) {
        window.sessionStorage.removeItem(keyName);
      }
      toast(errorText(error), 'error');
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
    if (res.error) { setPasswordError(errorText(res.error.message)); return; }
    setNewPassword('');
    setConfirmPassword('');
    toast(t('settings.toast_5'));
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(u.active ? t('settings.toast_6') : t('settings.toast_7'));
    setAccessTarget(null);
    void refetch();
  }

  function openRoleChange(u: Profile) {
    // A roster row opens on its own role, exactly as before. A historical row has no assignable
    // role to preselect, so it opens on the default — otherwise the attention strip's "move to an
    // active role" would be a button that does nothing, which is worse than no strip at all.
    // `manage_profile_access` stays the boundary either way: it refuses any p_role outside the
    // three active ones, and refuses a supplier-linked profile whatever the requested role.
    setNextRole(isActiveRole(u.role) ? u.role : 'office');
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('settings.roleUpdated', { role: roleLabels[nextRole] ?? nextRole }));
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
        t('settings.inviteCreatedNoDomain', { invitee }) + t('settings.text_5'),
      );
    } else {
      toast(t('settings.inviteSent', { invitee }));
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

    toast(t('settings.toast_8'));
    setResendTarget(null);
    void refetchInvites();
  }

  async function onRevoke(reason?: string) {
    if (!revokeTarget) return;
    setDialogBusy(true);
    const err = await revokeInvite(revokeTarget.id, reason?.trim() ?? '');
    setDialogBusy(false);
    if (err) { toast(err, 'error'); return; }

    toast(t('settings.toast_9'));
    setRevokeTarget(null);
    void refetchInvites();
  }

  const inviteColumns: Column<Invitation>[] = [
    {
      key: 'email', header: t('settings.text_6'),
      render: (r) => <span dir="ltr" className="font-medium">{r.email}</span>,
      sortValue: (r) => r.email,
    },
    { key: 'role', header: t('settings.text_7'), render: (r) => roleLabels[r.role] ?? r.role },
    {
      key: 'status', header: t('settings.text_8'),
      render: (r) => <StatusBadge meta={INVITATION_STATUS[invitationStatusOf(r)]} />,
      sortValue: (r) => invitationStatusOf(r),
    },
    { key: 'expires', header: t('settings.fmtDate'), render: (r) => fmtDate(r.expires_at), sortValue: (r) => r.expires_at },
    {
      key: 'sent', header: t('settings.text_9'),
      render: (r) => (
        <span className="text-ink-muted">
          {fmtDateTime(r.last_sent_at)}{r.send_count > 1 && ` (×${r.send_count})`}
        </span>
      ),
      sortValue: (r) => r.last_sent_at,
    },
  ];

  /**
   * The invitation row actions. They used to be a DataTable COLUMN called `actions` that
   * hand-rolled two quiet buttons — beside a table that has had a `rowActions` prop for exactly
   * this since ADR-0007. The gates are unchanged: a read-only organization sees none, and an
   * invitation already accepted or revoked has nothing left to do.
   */
  function invitationActions(r: Invitation): ActionMenuItem[] {
    const status = invitationStatusOf(r);
    const settled = status === 'accepted' || status === 'revoked';
    return [
      { key: 'resend', label: t('settings.setResendTarget'), icon: Send, hidden: !canWrite || settled, onSelect: () => setResendTarget(r) },
      { key: 'revoke', label: t('settings.setRevokeTarget'), icon: Ban, tone: 'danger', hidden: !canWrite || settled, onSelect: () => setRevokeTarget(r) },
    ];
  }

  /**
   * The two user row actions, defined once and rendered by both the roster table and the
   * attention strip — the same division of labour as before, now expressed as menu items instead
   * of a second local function called `rowActions` that shadowed the DataTable prop of that name.
   * The gates are the existing ones, unchanged: only an owner acting on somebody else sees them,
   * a deactivated row loses "שינוי תפקיד", and re-activation is offered only for a role the
   * product still assigns — which is what keeps a retired account from being switched back on.
   */
  function userActions(u: Profile): ActionMenuItem[] {
    const mine = !canWrite || u.id === profile?.id;
    return [
      {
        key: 'role', label: t('settings.text_10'), icon: UserCog,
        hidden: mine || !u.active,
        onSelect: () => openRoleChange(u),
      },
      {
        key: 'access', label: u.active ? t('settings.text_11') : t('settings.text_12'),
        icon: u.active ? Ban : Undo2,
        tone: u.active ? 'danger' : 'default',
        hidden: mine || !(u.active || (isActiveRole(u.role) && ASSIGNABLE_ROLES.includes(u.role))),
        onSelect: () => setAccessTarget(u),
      },
    ];
  }

  const userColumns: Column<Profile>[] = [
    {
      key: 'name', header: t('settings.text_13'), priority: 1,
      render: (u) => (
        <span className="font-medium">
          {u.full_name}
          {u.id === profile?.id && <span className="ms-2 text-xs text-ink-muted">{t('settings.text_14')}</span>}
        </span>
      ),
      sortValue: (u) => u.full_name ?? '',
    },
    { key: 'role', header: t('settings.text_15'), render: (u) => roleLabels[u.role] ?? u.role, sortValue: (u) => u.role },
    { key: 'phone', header: t('settings.text_16'), className: 'num', render: (u) => <span dir="ltr">{u.phone ?? '—'}</span> },
    {
      key: 'status', header: t('settings.text_17'), mobileLabel: null,
      render: (u) => (u.active ? <span className="badge-done">{t('settings.text_18')}</span> : <span className="badge-idle">{t('settings.text_19')}</span>),
      sortValue: (u) => (u.active ? 0 : 1),
    },
  ];

  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error) return <ErrorNote message={error} />;

  /**
   * One profiles query, three surfaces — and the archive predicate is deliberately a pair of
   * columns the system already has, not a new `archived_at`.
   *
   * `0133` makes the fourth quadrant — `active = true` with a retired role — unrepresentable:
   * `manage_profile_access` raises `account_role_retired` on any attempt to activate such a
   * profile, `create_invitation` and `accept_invitation` refuse the role outright, and
   * `auth_role()` resolves it to NULL so the sign-in is refused besides. With that quadrant
   * closed, `!isActiveRole(role) && !active` IS "archived". An `archived_at` column would be a
   * second answer to a question the enum guard already settles, and two answers drift: the day
   * they disagree, nobody can say which one the roster should believe. `profiles` carries no
   * soft-delete column at all — `active` is the whole lifecycle it stores.
   */
  const roster = users?.filter((u) => isActiveRole(u.role)) ?? [];
  /**
   * Empty against today's data — every retired-role profile in production is already inactive —
   * and kept anyway. This is the one state an owner has to resolve by hand, so a screen that
   * dropped it would hide the defect rather than report it, and a tenant could still arrive here
   * from a profile row written before `0133` closed the door.
   */
  const historicalActive = users?.filter((u) => !isActiveRole(u.role) && u.active) ?? [];
  const archived = users?.filter((u) => !isActiveRole(u.role) && !u.active) ?? [];

  return (
    <div className="space-y-5 max-w-3xl">
      {/* `meta`: "מדיניות עבודה" went with the autonomy switches to the operator app
          (19.08.2026) and the subscription moved to /settings/subscription (25.08.2026); the
          header kept advertising both. A meta line that names areas the screen no longer has
          sends people scrolling for something that is not there. */}
      <PageHeader title={<span className="flex items-center gap-2"><SettingsIcon size={ICON.xl} aria-hidden="true" /> {t('settings.text_20')}</span>}
        meta={t('settings.meta')}
        actions={<Link className="btn-secondary" to="/onboarding"><ClipboardCheck size={ICON.sm} aria-hidden="true" /> {t('settings.text_21')}</Link>} />

      <Card className="space-y-4">
        <h2 className="section-title">{t('settings.text_22')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-3"><label className="label" htmlFor="settings-org-name">{t('settings.setOrgName')}</label><input id="settings-org-name" className="input" maxLength={120} value={orgName} disabled={!canWrite} onChange={(e) => setOrgName(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-vat-rate">{t('settings.setVatRate')}</label><input id="settings-vat-rate" type="number" step="0.5" className="input num" value={vatRate} disabled={!canWrite} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-match-days">{t('settings.setMatchDays')}</label><input id="settings-match-days" type="number" className="input num" value={matchDays} disabled={!canWrite} onChange={(e) => setMatchDays(e.target.value)} /></div>
          <div><label className="label" htmlFor="settings-tolerance">{t('settings.setTolerance')}</label><input id="settings-tolerance" type="number" step="0.5" className="input num" value={tolerance} disabled={!canWrite} onChange={(e) => setTolerance(e.target.value)} /></div>
        </div>
        {canWrite && <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void saveOrg()}>{t('settings.saveOrg')}</button></div>}
      </Card>

      {/* Every role, not just owner: this is the language a person reads their own screen in. */}
      <LanguageSetting />

      <Card className="space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><ImageUp size={ICON.md} aria-hidden="true" /> {t('settings.text_23')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('settings.text_24')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {logoUrl ? <img src={logoUrl} alt={t('settings.logoAlt', { org: orgName })} className="h-14 w-28 rounded-lg border border-line bg-white object-contain p-1" /> : <div className="flex h-14 w-28 items-center justify-center rounded-lg border border-dashed border-line text-xs text-ink-muted">{t('settings.noLogo')}</div>}
          {canWrite && <label className="btn-secondary cursor-pointer">
            <ImageUp size={ICON.sm} aria-hidden="true" /> {logoPath ? t('settings.text_25') : t('settings.text_26')}
            <input type="file" className="sr-only" accept={BRAND_LOGO_TYPES.join(',')} disabled={logoBusy}
              onChange={(event) => { void uploadLogo(event.target.files?.[0]); event.currentTarget.value = ''; }} />
          </label>}
          {canWrite && logoPath && <button type="button" className="btn-ghost" disabled={logoBusy} onClick={() => void removeLogo()}>{t('settings.removeLogo')}</button>}
        </div>
      </Card>

      {/* The commercial subscription moved to `/settings/subscription` (owner report 25.08.2026)
          and is reached from its own drawer group. It is NOT reduced to a link here: this screen
          is the operational settings of the business, the plan is the contract the business runs
          under, and a card pointing sideways would be a ninth thing to scroll past on a screen
          whose complaint was that it had too many.

          OWNER ONLY has not changed (owner decision 23.08.2026) — the boundary simply moved from
          this conditional to the route guard in App.tsx, which is the stronger place for it:
          `office` and `accountant` now cannot reach the surface at all, rather than reaching a
          screen that renders nothing for them. */}

      {/* The autonomy switches left this screen for the operator application (src/operator/,
          19.08.2026): they were never the owner's control — platform_set_autonomy_policy
          (0076:270-272) raises `not_platform_admin` for anyone who is not a platform operator,
          and tenant settings must hold only what the tenant can actually operate. */}

      {/* Package K. Gated on the same two roles 0126's commands accept: a control that refuses
          on submit is worse than a control that is not there. `resolve_export_report_template`
          also admits the accountant, but reading which template their report uses belongs beside
          the report, not in the owner's settings. */}
      {canWrite && org && isOffice && <ExportTemplatesPanel orgId={org.id} />}

      <Card className="space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><LogOut size={ICON.md} aria-hidden="true" /> {t('settings.text_27')}</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {t('settings.text_28')}
          </p>
        </div>
        {offboardingError && <ErrorNote message={offboardingError} />}
        {offboarding && (
          <SubPanel className="text-sm">
            <div className="font-medium text-ink">{t(OFFBOARDING_STATUS_KEYS[offboarding.status])}</div>
            <div className="mt-1 text-ink-muted">
              {t('settings.offboardingOpenedAt')}<span className="num">{fmtDateTime(offboarding.requested_at)}</span>{t('settings.fmtDateTime')} <span className="num">{fmtDateTime(offboarding.cancellation_deadline)}</span>.
            </div>
            {offboarding.status === 'export_ready' && offboarding.export_completed_at && (
              <div className="mt-1 text-ink-muted">
                {t('settings.offboardingExportDoneAt')}<span className="num">{fmtDateTime(offboarding.export_completed_at)}</span>{t('settings.offboardingExportDoneTail')}
              </div>
            )}
            {offboarding.status === 'export_building' && offboarding.export_parts_total > 0 && (
              <div className="mt-1 text-ink-muted" role="status">
                {t('settings.offboardingPartsBefore')}<span className="num">{fmtNum(offboarding.export_parts_completed)}</span> {t('settings.fmtNum')} <span className="num">{fmtNum(offboarding.export_parts_total)}</span>{t('settings.offboardingPartsTail')}
              </div>
            )}
            {offboarding.status === 'export_failed' && (
              <div role="alert" className="mt-2 text-alert-fg">{t('settings.text_29')}</div>
            )}
          </SubPanel>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {!offboardingOpen && (
            <button type="button" className="btn-secondary text-alert-fg" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('request')}>
              <LogOut size={ICON.sm} aria-hidden="true" /> {t('settings.requestClosure')}
            </button>
          )}
          {offboarding?.status === 'export_ready' && (
            <button type="button" className="btn-primary" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('download')}>
              <Download size={ICON.sm} aria-hidden="true" /> {t('settings.createDownloadLink')}
            </button>
          )}
          {offboardingOpen && offboarding.can_owner_cancel && (
            <button type="button" className="btn-secondary" disabled={offboardingBusy}
              onClick={() => setOffboardingAction('cancel')}>
              <Undo2 size={ICON.sm} aria-hidden="true" /> {t('settings.cancelClosure')}
            </button>
          )}
        </div>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><KeyRound size={ICON.md} aria-hidden="true" /> {t('settings.text_30')}</h2>
          {/* OPEN-DECISIONS #114, decided 09.08.2026: employees recover their own password via
              "שכחתי סיסמה" on the login screen (ForgotPassword → ResetPassword). An org owner
              still cannot reset another user's password — that stays closed by decision, and the
              operator valve (admin-provision reset_password) remains the fallback when mail
              delivery fails. */}
          {/* One paragraph, not two (owner report 25.08.2026: "טקסט שלא אמור להיות והוא די
              מעוך"). The second one explained the employee's own recovery path — a route that
              starts on the LOGIN screen, is signposted there, and has nothing to do with the two
              password fields underneath it. Two stacked muted paragraphs were also the only place
              on this screen where helper text piled up on itself. The decision it recorded
              (#114) is unchanged and is still in the comment above. */}
          <p className="text-sm text-ink-muted mt-1">
            {t('settings.text_31')}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 sm:items-end">
          <div>
            <label className="label" htmlFor="new-password">{t('settings.newPasswordLabel', { min: MIN_PASSWORD_LENGTH })}</label>
            {/* `passwordProblem` judges the PAIR, so both fields are marked and both point at the
                one message. A banner nobody's field is tied to leaves a screen-reader user to
                guess which of the two boxes the sentence is about. */}
            <input id="new-password" type="password" className="input" dir="ltr" autoComplete="new-password"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={passwordError ? 'settings-password-problem' : undefined}
              value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setPasswordError(null); }} />
          </div>
          <div>
            <label className="label" htmlFor="confirm-password">{t('settings.text_32')}</label>
            <input id="confirm-password" type="password" className="input" dir="ltr" autoComplete="new-password"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={passwordError ? 'settings-password-problem' : undefined}
              value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(null); }} />
          </div>
          <button className="btn-primary" disabled={passwordBusy || !newPassword || !confirmPassword}
            onClick={() => void changePassword()}>{t('settings.changePassword')}</button>
        </div>
        {passwordError && <div id="settings-password-problem"><ErrorNote message={passwordError} /></div>}
      </Card>

      {/* A labelled <section>, not a bare card: the roster is now a DataTable, which brings its
          own card, its own scroll region and a phone-card branch the hand-rolled table never had.
          The section is what still names the whole surface for a screen reader. */}
      <section className="space-y-2" aria-labelledby="settings-users-heading">
        <h2 id="settings-users-heading" className="section-title flex items-center gap-2">
          <Users size={ICON.md} aria-hidden="true" /> {t('settings.usersHeading')}
        </h2>
        <DataTable
          tableLabel={t('settings.tableLabel')}
          rows={roster}
          columns={userColumns}
          rowActions={userActions}
          rowLabel={(u) => u.full_name ?? u.id}
          emptyTitle={t('settings.emptyTitle')}
          emptySubtitle={t('settings.emptySubtitle')}
        />
        {historicalActive.length > 0 && (
          <SubPanel>
            <Note tone="await" role="status">
              <span className="min-w-0 flex-1">
                {t('settings.text_33')}
              </span>
            </Note>
            <ul className="mt-3 divide-y divide-line-soft">
              {historicalActive.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-medium text-ink">{u.full_name}</span>
                  <span className="text-sm text-ink-muted">{roleLabels[u.role] ?? u.role}</span>
                  {/* Same items as the table row, same menu — this strip is a second view of a
                      roster row, not a second set of controls. */}
                  <span className="ms-auto"><ActionMenu items={userActions(u)} label={t('settings.userActionsLabel', { name: u.full_name ?? u.id })} /></span>
                </li>
              ))}
            </ul>
          </SubPanel>
        )}
      </section>

      {/* חוק החשיפה המדורגת: an account that closed is history, and history is read-only. The
          fold keeps it out of the roster's way while leaving it findable — including by
          find-in-page, which a native <details> still answers. */}
      {archived.length > 0 && (
        <Card pad={false} clip>
          <Disclosure title={t('settings.title')} count={archived.length}
            summary={t('settings.summary')}>
            {/* Stays a raw table on purpose: it is read-only history behind a fold, and a
                DataTable here would put a search box, a page footer and a row count inside a
                closed <details>. It carries the full table contract instead — `.table-scroll`,
                `.th`/`.td` with `scope`, and a focusable, named scroll region. */}
            <div className="table-scroll overflow-x-auto [contain:layout]" role="region" aria-label={t('settings.aria_label')} tabIndex={0}>
              <table className="w-full">
                <thead className="table-head"><tr><th scope="col" className="th">{t('settings.text_34')}</th><th scope="col" className="th">{t('settings.text_35')}</th><th scope="col" className="th">{t('settings.text_36')}</th><th scope="col" className="th">{t('settings.text_37')}</th></tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {archived.map((u) => (
                    <tr key={u.id}>
                      <td className="td font-medium">{u.full_name}</td>
                      <td className="td">{roleLabels[u.role] ?? u.role}</td>
                      <td className="td" dir="ltr">{u.phone ?? '—'}</td>
                      <td className="td"><span className="badge-idle">{t('settings.text_38')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </Card>
      )}

      {canWrite && <Card className="space-y-4">
        <div>
          <h2 className="section-title flex items-center gap-2"><MailPlus size={ICON.md} aria-hidden="true" /> {t('settings.text_39')}</h2>
          <p className="text-sm text-ink-muted mt-1">
            {t('settings.text_40')}
          </p>
          <p className="text-sm text-ink-muted mt-1">
            {t('settings.text_41')}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_11rem_auto] gap-3 sm:items-end">
          <div>
            <label className="label" htmlFor="inviteEmail">{t('settings.text_42')}</label>
            <input id="inviteEmail" type="email" className="input" dir="ltr" placeholder="name@example.com"
              aria-invalid={inviteError ? true : undefined}
              aria-describedby={inviteError ? 'invite-email-problem' : undefined}
              value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setInviteError(null); }} />
          </div>
          <div>
            <label className="label" htmlFor="inviteRole">{t('settings.text_43')}</label>
            <select id="inviteRole" className="input" value={inviteRole}
              onChange={(e) => { setInviteRole(e.target.value as ActiveRole); setInviteError(null); }}>
              {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
            </select>
          </div>
          <button className="btn-primary" disabled={inviting || !inviteEmail.trim()} onClick={() => void onInvite()}>
            {inviting ? t('settings.text_44') : t('settings.text_45')}
          </button>
        </div>
        {inviteError && <div id="invite-email-problem"><ErrorNote message={inviteError} /></div>}
        {inviteNotice && <Note tone="await">{inviteNotice}</Note>}
      </Card>}

      <div className="space-y-2">
        <h2 className="section-title">{t('settings.text_46')}</h2>
        <DataTable
          rows={invitations ?? []}
          columns={inviteColumns}
          searchable
          searchFn={(r, q) => r.email.toLowerCase().includes(q)}
          tableLabel={t('settings.tableLabel_2')}
          searchLabel={t('settings.searchLabel')}
          rowActions={invitationActions}
          rowLabel={(r) => t('settings.invitationRowLabel', { email: r.email })}
          emptyTitle={t('settings.emptyTitle_2')}
          emptySubtitle={t('settings.emptySubtitle_2')}
        />
      </div>

      <ConfirmDialog
        open={!!accessTarget}
        onClose={() => setAccessTarget(null)}
        onConfirm={(reason) => { if (accessTarget) setPendingSensitive({ run: () => void toggleActive(accessTarget, reason) }); }}
        title={accessTarget?.active ? t('settings.text_47') : t('settings.text_48')}
        message={accessTarget?.active
          ? t('settings.accessWillBlock', { name: accessTarget?.full_name ?? '' })
          : t('settings.accessWillRestore', { name: accessTarget?.full_name ?? '' })}
        confirmLabel={accessTarget?.active ? t('settings.text_49') : t('settings.text_50')}
        danger={accessTarget?.active}
        requireReason
        busy={dialogBusy}
      />

      <Modal
        open={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title={t('settings.roleChangeTitle', { name: roleTarget?.full_name ?? '' })}
        description={t('settings.currentRole', { role: roleTarget ? (roleLabels[roleTarget.role] ?? roleTarget.role) : '' })}
        busy={dialogBusy}
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="role-change-select">{t('settings.text_51')}</label>
            {/* The enum carries historical roles; ASSIGNABLE_ROLES is the active product contract. */}
            <select id="role-change-select" className="input" value={nextRole}
              onChange={(e) => setNextRole(e.target.value as ActiveRole)}>
              {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabels[r] ?? r}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="role-change-reason">{t('settings.text_52')}</label>
            <input id="role-change-reason" className="input" value={roleReason}
              onChange={(e) => setRoleReason(e.target.value)} placeholder={t('settings.placeholder')} />
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={dialogBusy} onClick={() => setRoleTarget(null)}>{t('settings.setRoleTarget')}</button>
            <button className="btn-primary"
              disabled={dialogBusy || nextRole === roleTarget?.role || !roleReason.trim()}
              onClick={() => setPendingSensitive({ run: () => void changeRole() })}>{t('settings.setPendingSensitive')}</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!resendTarget}
        onClose={() => setResendTarget(null)}
        onConfirm={() => void onResend()}
        title={t('settings.title_2')}
        message={t('settings.resendMessage', { email: resendTarget?.email ?? '' })}
        confirmLabel={t('settings.confirmLabel')}
        busy={dialogBusy}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={(reason) => void onRevoke(reason)}
        title={t('settings.title_3')}
        message={t('settings.revokeMessage', { email: revokeTarget?.email ?? '' })}
        confirmLabel={t('settings.confirmLabel_2')}
        danger
        requireReason
        busy={dialogBusy}
      />

      <ReauthModal
        open={!!pendingSensitive}
        title={t('settings.title_4')}
        onConfirm={() => { const pending = pendingSensitive; setPendingSensitive(null); pending?.run(); }}
        onCancel={() => setPendingSensitive(null)}
      />
      <ReauthModal
        open={offboardingAction !== null}
        title={offboardingAction === 'request'
          ? t('settings.text_53')
          : offboardingAction === 'cancel'
            ? t('settings.text_54')
            : t('settings.text_55')}
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
