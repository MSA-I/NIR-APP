import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowRight, Building2, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useQuery } from '../lib/useQuery';
import {
  Disclosure, ErrorNote, Modal, Note, PageLoader, StatusBadge, ConfirmDialog, useToast,
} from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  CONTACT_CHANNEL, CUSTOMER_CONTACT_KIND, CUSTOMER_NOTE_KIND, ORG_STATUS, PLATFORM_EVENT_ACTION,
} from '../lib/status';
import {
  addInternalNote, fetchCustomerContacts, fetchCustomerDetail, fetchCustomerNotes,
  fetchCustomerTimeline, fetchMyCapabilities, fetchOrgEntitlements, fetchOrgSubscription,
  fetchOrgUsage, fetchPlatformOperators, fetchSubscriptionPlans, removeCustomerContact,
  resolveFollowUp, setCustomerAccount, upsertCustomerContact,
  type CustomerContact, type CustomerNote, type PlatformCapability,
} from '../lib/platform';
import CustomerSubscription from './CustomerSubscription';
import CustomerUsage from './CustomerUsage';

const CONTACT_KINDS = ['primary', 'billing', 'technical'] as const;

/** A value the console has no measurement for renders as an em dash. Never a zero, and never a
    plausible-looking blank — both read as facts about the customer. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-body">{children ?? <span className="text-ink-muted">—</span>}</dd>
    </div>
  );
}

export default function CustomerDetail() {
  const { orgId = '' } = useParams();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editingAccount, setEditingAccount] = useState(false);
  const [editingContact, setEditingContact] = useState<{ kind: string; existing?: CustomerContact } | null>(null);
  const [removingContact, setRemovingContact] = useState<CustomerContact | null>(null);
  const [resolving, setResolving] = useState<CustomerNote | null>(null);
  const [noteDraft, setNoteDraft] = useState({ kind: 'note', body: '', due: '' });

  const { data, loading, error, refetch } = useQuery(
    async () => {
      const capabilities = await fetchMyCapabilities();
      if (!capabilities.includes('customer.view')) {
        return {
          capabilities, detail: null, contacts: [], notes: [], timeline: [], operators: [],
          subscription: null, entitlements: [], plans: [], usage: [],
        };
      }
      const billing = capabilities.includes('billing.view');
      const [detail, contacts, timeline, operators, notes, subscription, entitlements, plans, usage]
        = await Promise.all([
          fetchCustomerDetail(orgId),
          fetchCustomerContacts(orgId),
          fetchCustomerTimeline(orgId),
          fetchPlatformOperators(),
          capabilities.includes('notes.view') ? fetchCustomerNotes(orgId) : Promise.resolve([]),
          billing ? fetchOrgSubscription(orgId) : Promise.resolve(null),
          billing ? fetchOrgEntitlements(orgId) : Promise.resolve([]),
          billing ? fetchSubscriptionPlans() : Promise.resolve([]),
          capabilities.includes('usage.view') ? fetchOrgUsage(orgId) : Promise.resolve([]),
        ]);
      return {
        capabilities, detail, contacts, notes, timeline, operators,
        subscription, entitlements, plans, usage,
      };
    },
    [orgId],
  );

  const capabilities: PlatformCapability[] = data?.capabilities ?? [];
  const may = (capability: PlatformCapability) => capabilities.includes(capability);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast(done);
      setEditingAccount(false);
      setEditingContact(null);
      setRemovingContact(null);
      setResolving(null);
      setNoteDraft({ kind: 'note', body: '', due: '' });
      await refetch();
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;
  if (!may('customer.view')) {
    return (
      <Note tone="alert">
        <span className="min-w-0 flex-1">
          כרטיס הלקוח פתוח למפעילים בעלי הרשאת צפייה בלקוחות. ההרשאה מוקצית מחוץ למוצר.
        </span>
      </Note>
    );
  }

  const detail = data?.detail;
  if (!detail) return <ErrorNote message="הלקוח לא נמצא." />;

  const contacts = data?.contacts ?? [];
  const notes = data?.notes ?? [];
  const timeline = data?.timeline ?? [];
  const operators = data?.operators ?? [];

  return (
    <div className="space-y-5">
      <div>
        <Link to="/admin/customers" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowRight size={15} aria-hidden="true" /> חזרה לרשימת הלקוחות
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="page-title flex items-center gap-2"><Building2 size={22} /> {detail.name}</h1>
          <StatusBadge meta={ORG_STATUS[detail.status]} />
          {detail.access_mode === 'offboarding' && (
            <span className="badge-await">בתהליך סיום שירות</span>
          )}
        </div>
      </div>

      {detail.open_follow_up_count > 0 && (
        <Note tone="await">
          <span className="min-w-0 flex-1">
            {fmtNum(detail.open_follow_up_count)} משימות מעקב פתוחות מול הלקוח הזה.
          </span>
        </Note>
      )}

      <section className="card card-pad space-y-3" aria-labelledby="overview-heading">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="overview-heading" className="section-title">תמונת מצב</h2>
          {may('customer.edit') && (
            <button type="button" className="btn-ghost ms-auto py-1! text-xs"
              onClick={() => setEditingAccount(true)}>
              <Pencil size={13} /> עריכת פרטי החשבון
            </button>
          )}
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Fact label="משתמשים פעילים">{fmtNum(detail.active_user_count)}</Fact>
          <Fact label="פעילות אחרונה">{detail.last_activity_at ? fmtDate(detail.last_activity_at) : null}</Fact>
          <Fact label="ארגון נוצר">{fmtDate(detail.created_at)}</Fact>
          <Fact label="לקוח מאז">{detail.customer_since ? fmtDate(detail.customer_since) : null}</Fact>
          <Fact label="אחראי מטעמנו">{detail.internal_owner_email}</Fact>
          <Fact label="שיעור מע״מ">{`${fmtNum(detail.vat_rate)}%`}</Fact>
        </dl>
        {/* Waves 3-5 own plan, usage, onboarding and health. Saying so beats an empty card that
            looks like a measurement returning nothing. */}
        <p className="text-xs text-ink-muted">
          השלמת onboarding ומצב בריאות אינם נמדדים עדיין ואינם מוצגים.
        </p>
      </section>

      {may('billing.view') && (
        <CustomerSubscription
          orgId={orgId}
          subscription={data?.subscription ?? null}
          entitlements={data?.entitlements ?? []}
          plans={data?.plans ?? []}
          may={may}
          busy={busy}
          run={(action, done) => void run(action, done)}
        />
      )}

      {may('usage.view') && <CustomerUsage rows={data?.usage ?? []} />}

      <section className="card card-pad space-y-3" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading" className="section-title">אנשי קשר</h2>
        <p className="text-sm text-ink-muted">
          רשומות פנימיות לניהול הקשר — אינן משתמשי המערכת של הלקוח ואינן מעניקות גישה.
        </p>
        <ul className="divide-y divide-line-soft">
          {CONTACT_KINDS.map((kind) => {
            const contact = contacts.find((row) => row.kind === kind);
            return (
              <li key={kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="min-w-32 text-xs text-ink-muted">{CUSTOMER_CONTACT_KIND[kind]}</span>
                {contact ? (
                  <>
                    <span className="font-medium text-ink">{contact.name}</span>
                    {contact.title && <span className="text-sm text-ink-muted">{contact.title}</span>}
                    {contact.email && <span dir="ltr" className="text-sm text-ink-body">{contact.email}</span>}
                    {contact.phone && <span dir="ltr" className="text-sm text-ink-body num">{contact.phone}</span>}
                    {contact.preferred_channel && (
                      <span className="badge-idle">{CONTACT_CHANNEL[contact.preferred_channel]}</span>
                    )}
                  </>
                ) : (
                  <span className="text-sm text-ink-muted">—</span>
                )}
                {may('customer.edit') && (
                  <span className="ms-auto flex gap-1">
                    <button type="button" className="btn-ghost py-1! text-xs"
                      onClick={() => setEditingContact({ kind, existing: contact })}>
                      <Pencil size={13} /> {contact ? 'עריכה' : 'הוספה'}
                    </button>
                    {contact && (
                      <button type="button" className="btn-ghost py-1! text-xs text-alert-fg"
                        onClick={() => setRemovingContact(contact)}>
                        <Trash2 size={13} /> הסרה
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {may('notes.view') && (
        <section className="card card-pad space-y-3" aria-labelledby="notes-heading">
          <h2 id="notes-heading" className="section-title">הערות פנימיות</h2>
          <p className="text-sm text-ink-muted">
            נכתבות לעינינו בלבד, אינן נחשפות ללקוח ואינן ניתנות לעריכה או למחיקה לאחר השמירה.
          </p>

          {may('notes.add') && (
            <div className="space-y-2 rounded-lg bg-surface-sunken p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="note-kind">סוג הרשומה</label>
                <select id="note-kind" className="input w-auto" value={noteDraft.kind}
                  onChange={(event) => setNoteDraft({ ...noteDraft, kind: event.target.value, due: '' })}>
                  <option value="note">הערה</option>
                  <option value="support">פנייה מהלקוח</option>
                  <option value="follow_up">משימת מעקב</option>
                </select>
                {noteDraft.kind === 'follow_up' && (
                  <>
                    <label className="text-sm text-ink-muted" htmlFor="note-due">לטיפול עד</label>
                    <input id="note-due" type="date" className="input w-auto" value={noteDraft.due}
                      onChange={(event) => setNoteDraft({ ...noteDraft, due: event.target.value })} />
                  </>
                )}
              </div>
              <label className="sr-only" htmlFor="note-body">תוכן הרשומה</label>
              <textarea id="note-body" className="input" rows={2} maxLength={4000}
                placeholder="מה קרה, ומה צריך לקרות."
                value={noteDraft.body}
                onChange={(event) => setNoteDraft({ ...noteDraft, body: event.target.value })} />
              <div className="flex justify-end">
                <button type="button" className="btn-primary py-1.5! text-sm"
                  disabled={busy || noteDraft.body.trim().length < 2
                    || (noteDraft.kind === 'follow_up' && !noteDraft.due)}
                  onClick={() => void run(() => addInternalNote({
                    orgId,
                    kind: noteDraft.kind,
                    body: noteDraft.body,
                    followUpDueAt: noteDraft.kind === 'follow_up' ? noteDraft.due : null,
                  }), 'הרשומה נשמרה')}>
                  <MessageSquarePlus size={15} /> שמירה
                </button>
              </div>
            </div>
          )}

          {notes.length === 0 ? (
            <p className="text-sm text-ink-muted">אין רשומות פנימיות ללקוח הזה.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {notes.map((note) => (
                <li key={note.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge meta={CUSTOMER_NOTE_KIND[note.kind]} />
                    {note.kind === 'follow_up' && note.follow_up_due_at && !note.resolved_at && (
                      <span className="text-xs text-await-fg">לטיפול עד {fmtDate(note.follow_up_due_at)}</span>
                    )}
                    {note.resolved_at && <span className="badge-done">נסגר {fmtDate(note.resolved_at)}</span>}
                    <span className="ms-auto text-xs text-ink-muted" dir="ltr">{note.author_email}</span>
                    <span className="text-xs text-ink-muted">{fmtDateTime(note.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-ink-body">{note.body}</p>
                  {note.resolution && (
                    <p className="text-sm text-ink-muted">סגירה: {note.resolution}</p>
                  )}
                  {note.kind === 'follow_up' && !note.resolved_at && may('notes.add') && (
                    <button type="button" className="btn-ghost py-1! text-xs"
                      onClick={() => setResolving(note)}>סגירת המעקב</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Disclosure title="יומן פעולות הפלטפורמה" className="card">
        {timeline.length === 0 ? (
          <p className="text-sm text-ink-muted">לא בוצעו פעולות פלטפורמה מול הלקוח הזה.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {timeline.map((event) => (
              <li key={event.id} className="space-y-0.5 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {/* An action this map has not caught up with still happened; show it raw. */}
                  <span className="text-sm font-medium text-ink">
                    {PLATFORM_EVENT_ACTION[event.action] ?? event.action}
                  </span>
                  <span className="ms-auto text-xs text-ink-muted" dir="ltr">{event.actor_email}</span>
                  <span className="text-xs text-ink-muted">{fmtDateTime(event.occurred_at)}</span>
                </div>
                <p className="text-sm text-ink-muted">{event.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>

      {editingAccount && (
        <AccountModal
          busy={busy}
          operators={operators}
          initialOwner={detail.internal_owner}
          initialSince={detail.customer_since}
          onClose={() => setEditingAccount(false)}
          onSubmit={(form) => void run(() => setCustomerAccount({
            orgId,
            internalOwner: form.owner || null,
            customerSince: form.since || null,
            reason: form.reason,
          }), 'פרטי החשבון עודכנו')}
        />
      )}

      {editingContact && (
        <ContactModal
          busy={busy}
          kind={editingContact.kind}
          existing={editingContact.existing}
          onClose={() => setEditingContact(null)}
          onSubmit={(form) => void run(() => upsertCustomerContact({
            orgId,
            kind: editingContact.kind,
            name: form.name,
            title: form.title || null,
            email: form.email || null,
            phone: form.phone || null,
            preferredChannel: form.channel || null,
            reason: form.reason,
          }), 'איש הקשר נשמר')}
        />
      )}

      <ConfirmDialog
        open={!!removingContact}
        busy={busy}
        danger
        requireReason
        title={`הסרת ${removingContact ? CUSTOMER_CONTACT_KIND[removingContact.kind] : ''}`}
        message="הרשומה תוסר מהתצוגה ותישמר בהיסטוריה — איש הקשר שאליו נכתבו הערות בעבר נשאר חלק מהתיעוד."
        confirmLabel="הסרה"
        onClose={() => setRemovingContact(null)}
        onConfirm={(reason) => {
          if (removingContact) {
            void run(() => removeCustomerContact(removingContact.id, reason ?? ''), 'איש הקשר הוסר');
          }
        }}
      />

      <ConfirmDialog
        open={!!resolving}
        busy={busy}
        requireReason
        reasonLabel="מה סגר את המעקב"
        title="סגירת משימת מעקב"
        message="המעקב ייסגר פעם אחת ולא ניתן לפתוח אותו מחדש — פתיחה מחדש היא רשומה חדשה."
        confirmLabel="סגירה"
        onClose={() => setResolving(null)}
        onConfirm={(reason) => {
          if (resolving) void run(() => resolveFollowUp(resolving.id, reason ?? ''), 'המעקב נסגר');
        }}
      />
    </div>
  );
}

function AccountModal({ busy, operators, initialOwner, initialSince, onClose, onSubmit }: {
  busy: boolean;
  operators: { user_id: string; email: string }[];
  initialOwner: string | null;
  initialSince: string | null;
  onClose: () => void;
  onSubmit: (form: { owner: string; since: string; reason: string }) => void;
}) {
  const [form, setForm] = useState({
    owner: initialOwner ?? '',
    since: initialSince ?? '',
    reason: '',
  });
  return (
    <Modal open onClose={onClose} title="פרטי החשבון" busy={busy}>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="account-owner">אחראי מטעמנו</label>
          {/* Only the platform operator roster (0153) — never a directory of tenant users. */}
          <select id="account-owner" className="input" value={form.owner}
            onChange={(event) => setForm({ ...form, owner: event.target.value })}>
            <option value="">ללא אחראי</option>
            {operators.map((operator) => (
              <option key={operator.user_id} value={operator.user_id}>{operator.email}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="account-since">לקוח מאז</label>
          <input id="account-since" type="date" className="input" value={form.since}
            onChange={(event) => setForm({ ...form, since: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="account-reason">סיבת השינוי</label>
          <textarea id="account-reason" className="input" rows={2} maxLength={1000} value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy || !form.reason.trim()}
            onClick={() => onSubmit(form)}>שמירה</button>
        </div>
      </div>
    </Modal>
  );
}

function ContactModal({ busy, kind, existing, onClose, onSubmit }: {
  busy: boolean;
  kind: string;
  existing?: CustomerContact;
  onClose: () => void;
  onSubmit: (form: {
    name: string; title: string; email: string; phone: string; channel: string; reason: string;
  }) => void;
}) {
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    title: existing?.title ?? '',
    email: existing?.email ?? '',
    phone: existing?.phone ?? '',
    channel: existing?.preferred_channel ?? '',
    reason: '',
  });
  // The server rejects both of these too; refusing here as well means the operator finds out
  // while typing rather than after a round trip.
  const reachable = !!(form.email.trim() || form.phone.trim());
  const channelReachable = !form.channel
    || (form.channel === 'email' ? !!form.email.trim() : !!form.phone.trim());
  const ready = !!form.name.trim() && !!form.reason.trim() && reachable && channelReachable;

  return (
    <Modal open onClose={onClose} title={CUSTOMER_CONTACT_KIND[kind]} busy={busy}>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="contact-name">שם</label>
          <input id="contact-name" className="input" value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="contact-title">תפקיד</label>
          <input id="contact-title" className="input" value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="contact-email">אימייל</label>
            <input id="contact-email" type="email" dir="ltr" className="input" value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="contact-phone">טלפון</label>
            <input id="contact-phone" type="tel" dir="ltr" className="input" value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="contact-channel">ערוץ מועדף</label>
          <select id="contact-channel" className="input" value={form.channel}
            onChange={(event) => setForm({ ...form, channel: event.target.value })}>
            <option value="">ללא העדפה</option>
            <option value="email">אימייל</option>
            <option value="phone">טלפון</option>
            <option value="whatsapp">וואטסאפ</option>
          </select>
          {!channelReachable && (
            <p className="mt-1 text-xs text-alert-fg">
              נבחר ערוץ מועדף שאין עבורו כתובת — יש למלא אימייל או טלפון בהתאם.
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="contact-reason">סיבת השינוי</label>
          <textarea id="contact-reason" className="input" rows={2} maxLength={1000} value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </div>
        {!reachable && (
          <p className="text-xs text-alert-fg">איש קשר ללא אימייל וללא טלפון אינו ניתן לשמירה.</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy || !ready}
            onClick={() => onSubmit(form)}>שמירה</button>
        </div>
      </div>
    </Modal>
  );
}
