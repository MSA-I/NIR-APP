// send-push — delivers Web Push notifications to subscribed devices.
//
// Callers are NOT browsers: the price/duplicate DB triggers and the pg_cron due-payments
// scan (supabase/migrations/0016_push_triggers.sql and 0017_notifications.sql) invoke this
// over pg_net.
// A database trigger cannot mint a user JWT, so authentication is a shared secret in
// the `x-push-secret` header, compared against PUSH_FN_SECRET. That secret — not a JWT —
// is the security boundary here, which is why the function must be deployed with
// `supabase functions deploy send-push --no-verify-jwt` (otherwise the platform rejects
// the pg_net calls before this code runs).
//
// service_role is used deliberately and stays server-side (CLAUDE.md iron rule):
// the function must read every org's subscriptions and delete dead ones, which no
// single user's RLS view allows. It never mutates financial/business rows — only the durable
// notification outbox/delivery state and push_subscriptions cleanup on 404/410.
//
// Required environment (supabase secrets set ...):
//   PUSH_FN_SECRET     -- shared secret; the SAME value is seeded into private.push_config
//                         (see 0016_push_triggers.sql) so the DB can present it
//   VAPID_PUBLIC_KEY   -- from `npx web-push generate-vapid-keys`; the public half is also
//   VAPID_PRIVATE_KEY     the SPA's VITE_VAPID_PUBLIC_KEY build-time env (.env.example)
//   VAPID_SUBJECT      -- e.g. mailto:ops@example.co.il (push services require a contact)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
//
// Request contract (POST JSON):
//   { event: 'price_increase', org_id: uuid, payload: { count, event_key } }
//   { event: 'duplicate_invoice_check', org_id: uuid,
//     payload: { entity_key, active, count } }
//   { event: 'payment_due_scan' }
// Response: { ok: true, results: { sent, failed, removed } } (+ per-org breakdown for the scan).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { organizationWriteAllowed } from '../_shared/organization-access.ts';
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from '../_shared/organization-egress.ts';
import { runReservedEgress } from '../_shared/reserved-egress.ts';

/* ---------- thresholds mirrored from src/lib/alerts.ts ----------
 * scanPaymentsDueSoon (alerts.ts:150) is the on-screen twin of the cron scan below.
 * DUE_SOON_DAYS mirrors alerts.ts:42 and PR_ACTIVE mirrors alerts.ts:45 — they are
 * duplicated here knowingly (this file runs in Deno, the app in the browser; there is
 * no shared module). If one side changes, change the other in the same commit. */
const DUE_SOON_DAYS = 7;
const PR_ACTIVE = ['draft', 'pending_approval', 'approved', 'sent_for_execution'];
const PUSH_PROVIDER_TIMEOUT_MS = 10_000;

/** MIRROR, NOT AUTHORITY. The audience is decided in ONE place: the `eligible` CTE of
 *  enqueue_notification_delivery (supabase/migrations/0024_p2_data_reliability.sql:96-102,
 *  narrowed by notification preferences in 0068). This array is a Deno-side copy of the role
 *  half of that line, used only for the coarse org discovery below; it must never grow into a
 *  second audience decision. The roles are the App.tsx FINANCE guard, so a notification never
 *  links to a page the recipient may not open.
 *
 *  Since 0068 the bell and Push audiences MAY DIVERGE, by the recipient's own choice: muting
 *  Push leaves the notification row standing (the unread-badge contract of OPEN-DECISIONS #39)
 *  and only settles its Push leg. Preference filtering therefore happens in the database and
 *  must NOT be re-implemented here -- which also means the row set returned by the delivery
 *  RPC is the PUSH WORK LIST, not a count of notifications created. */
const ALERT_ROLES = ['owner', 'office'];
type NotificationSeverity = 'warning' | 'critical';

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface PendingNotification {
  notification_id: string;
  user_id: string;
  notification_dedupe_key: string;
  created: boolean;
}

interface PushPayload {
  title: string;
  body: string;
  url: string; // in-app path; public/sw.js routes the notification click there
}

interface SendCounts {
  sent: number;
  failed: number;
  removed: number;
}

interface NotificationAttemptRow {
  id: string;
  push_attempts: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function businessDate(n = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  // Add calendar days to Jerusalem's Y-M-D, rather than adding 24-hour blocks to the
  // instant. The latter drifts by one date in the narrow window around DST transitions.
  const date = new Date(Date.UTC(
    Number(value('year')),
    Number(value('month')) - 1,
    Number(value('day')) + n,
  ));
  return date.toISOString().slice(0, 10);
}

async function organizationCanNotify(admin: SupabaseClient, orgId: string): Promise<boolean> {
  const { data, error } = await admin.rpc('service_organization_access_mode', {
    p_org_id: orgId,
  });
  if (error) throw new Error('organization_access_unavailable');
  return organizationWriteAllowed(data ? { access_mode: String(data) } : null);
}

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

async function enqueueNotification(
  admin: SupabaseClient,
  values: {
    orgId: string;
    eventCode: string;
    entityKey: string;
    severity: NotificationSeverity;
    title: string;
    body: string;
    targetUrl: string;
    dedupeKey: string;
  },
): Promise<PendingNotification[]> {
  if (!await organizationCanNotify(admin, values.orgId)) {
    throw new Error('organization_unavailable');
  }
  const { data, error } = await admin.rpc('enqueue_notification_delivery', {
    p_org_id: values.orgId,
    p_event_code: values.eventCode,
    p_entity_key: values.entityKey,
    p_severity: values.severity,
    p_title: values.title,
    p_body: values.body,
    p_target_url: values.targetUrl,
    p_dedupe_key: values.dedupeKey,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as PendingNotification[];
}

async function subscriptionsForUsers(
  admin: SupabaseClient,
  orgId: string,
  userIds: string[],
): Promise<SubRow[]> {
  if (!userIds.length) return [];
  const { data, error } = await admin.from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .eq('org_id', orgId).in('user_id', [...new Set(userIds)]);
  if (error) throw new Error(error.message);
  return (data ?? []) as SubRow[];
}

/** Claims a standing condition and persists every recipient row in the same DB transaction.
 *  A repeated call returns only rows whose Push delivery is still pending. */
async function claimStandingEventAndNotify(
  admin: SupabaseClient,
  values: {
    orgId: string;
    eventCode: string;
    entityKey: string;
    severity: NotificationSeverity;
    title: string;
    body: string;
    targetUrl: string;
  },
): Promise<PendingNotification[]> {
  if (!await organizationCanNotify(admin, values.orgId)) {
    throw new Error('organization_unavailable');
  }
  const { data, error } = await admin.rpc('claim_notification_event_and_notify', {
    p_org_id: values.orgId,
    p_event_code: values.eventCode,
    p_entity_key: values.entityKey,
    p_severity: values.severity,
    p_title: values.title,
    p_body: values.body,
    p_target_url: values.targetUrl,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as PendingNotification[];
}

async function closeStandingEvent(
  admin: SupabaseClient,
  orgId: string,
  eventCode: string,
  entityKeys: string[],
): Promise<void> {
  if (!entityKeys.length) return;
  if (!await organizationCanNotify(admin, orgId)) {
    throw new Error('organization_unavailable');
  }
  const { error } = await admin.from('notification_event_states')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('org_id', orgId).eq('event_code', eventCode).in('entity_key', entityKeys);
  if (error) throw new Error(error.message);
}

/**
 * Pushes one payload to every subscription. A dead endpoint (404/410 from the push
 * service) means the browser discarded the subscription — the row is deleted so the
 * next run stops paying for it. Any other failure only counts; one bad endpoint must
 * not stop delivery to the rest.
 */
async function sendToSubs(
  admin: SupabaseClient,
  subs: SubRow[],
  payload: PushPayload,
): Promise<SendCounts> {
  const counts: SendCounts = { sent: 0, failed: 0, removed: 0 };
  const message = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message,
        { timeout: PUSH_PROVIDER_TIMEOUT_MS },
      );
      counts.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        const del = await admin.from('push_subscriptions').delete().eq('id', sub.id);
        if (del.error) console.error('failed to remove dead subscription', sub.id, del.error.message);
        else counts.removed++;
      } else {
        // Endpoint host is enough for diagnosis; the full endpoint is a capability URL.
        let host = 'invalid_endpoint';
        try {
          host = new URL(sub.endpoint).host;
        } catch {
          // The invalid marker is intentionally not the capability URL.
        }
        console.error('push send failed', status ?? 'no-status', host);
        counts.failed++;
      }
    }
  }));

  return counts;
}

async function recordPushResult(
  admin: SupabaseClient,
  rows: PendingNotification[],
  outcome: 'delivered' | 'partial' | 'no_delivery' | 'failed',
  error: string | null,
): Promise<void> {
  await Promise.all(rows.map(async (row) => {
    const { error: writeError } = await admin.rpc('record_notification_push_delivery_outcome', {
      p_notification_id: row.notification_id,
      p_outcome: outcome,
      p_error: error,
    });
    if (writeError) throw new Error(writeError.message);
  }));
}

async function pushAttemptCorrelation(
  admin: SupabaseClient,
  orgId: string,
  rows: PendingNotification[],
): Promise<string> {
  const ids = rows.map((row) => row.notification_id).sort();
  const { data, error } = await admin.from('notifications')
    .select('id, push_attempts')
    .eq('org_id', orgId)
    .in('id', ids);
  if (error) throw new Error(error.message);
  const attempts = new Map(
    ((data ?? []) as NotificationAttemptRow[]).map((row) => [row.id, row.push_attempts]),
  );
  if (attempts.size !== ids.length || ids.some((id) => !attempts.has(id))) {
    throw new Error('notification_attempt_state_incomplete');
  }

  const seed = `${orgId}:${ids.map((id) => `${id}:${attempts.get(id)}`).join(',')}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

/** Sends at most one Push payload per user for this invocation. Notification rows are the
 * durable outbox. A partial delivery is terminal because at least one endpoint accepted it;
 * its failure count remains in the egress evidence. A zero-success failure stays pending and
 * its incremented attempt counter produces a distinct, deterministic reservation on retry. */
async function deliverQueuedNotifications(
  admin: SupabaseClient,
  orgId: string,
  rows: PendingNotification[],
  payloadFor: (userRows: PendingNotification[]) => PushPayload,
): Promise<SendCounts> {
  const totals: SendCounts = { sent: 0, failed: 0, removed: 0 };
  if (!rows.length) return totals;

  const byUser = new Map<string, PendingNotification[]>();
  for (const row of rows) {
    const current = byUser.get(row.user_id) ?? [];
    current.push(row);
    byUser.set(row.user_id, current);
  }
  const subs = await subscriptionsForUsers(admin, orgId, [...byUser.keys()]);
  const rpc = serviceRpc(admin);

  const results = await Promise.all([...byUser.entries()].map(async ([userId, userRows]) => {
    const correlationId = await pushAttemptCorrelation(admin, orgId, userRows);
    const reservation = await reserveOrganizationEgress(rpc, {
      orgId,
      kind: 'push_notification',
      correlationId,
      ttlSeconds: 30,
    });
    if (!reservation.lease) {
      if (reservation.settledOutcome === 'delivered') {
        return { sent: 0, failed: 0, removed: 0 };
      }
      if (reservation.settledOutcome) {
        throw new Error(`push_egress_settled_${reservation.settledOutcome}`);
      }
      throw new Error('organization_unavailable');
    }
    if (reservation.lease.idempotent) {
      throw new Error('push_egress_attempt_in_progress');
    }
    const lease = reservation.lease;

    return await runReservedEgress({
      reserve: () => Promise.resolve(lease),
      perform: () =>
        sendToSubs(
          admin,
          subs.filter((sub) => sub.user_id === userId),
          payloadFor(userRows),
        ),
      settle: async (activeLease, attempt) => {
        if (!attempt.ok) {
          try {
            await recordPushResult(admin, userRows, 'failed', 'push_provider_attempt_failed');
          } catch (error) {
            await releaseOrganizationEgress(rpc, activeLease, {
              outcome: 'ambiguous',
              evidenceCode: 'push_result_ambiguous',
            });
            throw error;
          }
          await releaseOrganizationEgress(rpc, activeLease, {
            outcome: 'failed',
            evidenceCode: 'push_provider_attempt_failed',
          });
          return;
        }

        const result = attempt.result;
        const pushOutcome = result.sent > 0 && result.failed > 0
          ? 'partial'
          : result.sent > 0
          ? 'delivered'
          : result.failed > 0
          ? 'failed'
          : 'no_delivery';
        const delivered = pushOutcome === 'delivered' || pushOutcome === 'partial';
        const errorCode = result.failed > 0
          ? `${result.failed}_push_delivery_failures`
          : null;
        try {
          await recordPushResult(admin, userRows, pushOutcome, errorCode);
        } catch (error) {
          await releaseOrganizationEgress(rpc, activeLease, {
            outcome: 'ambiguous',
            evidenceCode: 'push_result_ambiguous',
            evidence: {
              notification_ids: userRows.map((row) => row.notification_id),
              sent: result.sent,
              failed: result.failed,
              removed: result.removed,
              push_outcome: pushOutcome,
            },
          });
          throw error;
        }

        const evidenceCode = result.sent > 0 && result.failed > 0
          ? `push_partial_delivery_${result.failed}_failures`
          : result.sent > 0
          ? 'push_delivered'
          : result.removed > 0
          ? 'push_endpoints_removed'
          : result.failed > 0
          ? 'push_failed'
          : 'push_no_subscription';
        await releaseOrganizationEgress(rpc, activeLease, {
          outcome: delivered ? 'delivered' : 'failed',
          evidenceCode,
          evidence: {
            notification_ids: userRows.map((row) => row.notification_id),
            sent: result.sent,
            failed: result.failed,
            removed: result.removed,
            push_outcome: pushOutcome,
          },
        });
      },
    });
  }));

  for (const result of results) {
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.removed += result.removed;
  }
  return totals;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  const secret = Deno.env.get('PUSH_FN_SECRET');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !vapidPublic || !vapidPrivate || !vapidSubject || !url || !serviceKey) {
    return fail('misconfigured', 'missing environment', 500);
  }

  if (req.headers.get('x-push-secret') !== secret) {
    return fail('forbidden', 'bad or missing x-push-secret', 403);
  }

  let body: {
    event?: string;
    org_id?: string;
    payload?: { count?: number; event_key?: string; entity_key?: string; active?: boolean };
  };
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'body is not valid JSON', 400);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ===== event: price_increase — fired by the supplier_products trigger (0016) =====
  if (body.event === 'price_increase') {
    if (typeof body.org_id !== 'string' || typeof body.payload?.count !== 'number'
      || body.payload.count < 1 || typeof body.payload.event_key !== 'string') {
      return fail('invalid_request', 'price_increase requires org_id, count >= 1 and event_key', 400);
    }
    const count = Math.floor(body.payload.count);
    const title = 'עליית מחיר אצל ספק';
    const message = count === 1
      ? 'מחיר אחד עודכן כלפי מעלה במחירון'
      : `${count} מחירים עודכנו כלפי מעלה במחירון`;
    try {
      if (!await organizationCanNotify(admin, body.org_id)) {
        return fail('org_unavailable', 'organization is not writable', 409);
      }
      const pending = await enqueueNotification(admin, {
        orgId: body.org_id,
        eventCode: 'price_increase',
        entityKey: body.payload.event_key,
        severity: 'warning',
        title,
        body: message,
        targetUrl: '/prices',
        dedupeKey: `price_increase:${body.payload.event_key}`,
      });
      const results = await deliverQueuedNotifications(
        admin,
        body.org_id,
        pending,
        () => ({ title, body: message, url: '/prices' }),
      );
      return json({ ok: true, notifications: pending.filter((row) => row.created).length, results }, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'notification write failed';
      return fail(message === 'organization_unavailable' ? 'org_unavailable' : 'query_failed', message,
        message === 'organization_unavailable' ? 409 : 500);
    }
  }

  // ===== event: duplicate_invoice_check — fired on identifying invoice changes (0017) =====
  if (body.event === 'duplicate_invoice_check') {
    if (typeof body.org_id !== 'string' || typeof body.payload?.entity_key !== 'string'
      || typeof body.payload.active !== 'boolean' || typeof body.payload.count !== 'number') {
      return fail('invalid_request', 'duplicate_invoice_check payload is incomplete', 400);
    }
    try {
      if (!await organizationCanNotify(admin, body.org_id)) {
        return fail('org_unavailable', 'organization is not writable', 409);
      }
      if (!body.payload.active) {
        await closeStandingEvent(admin, body.org_id, 'duplicate_invoice', [body.payload.entity_key]);
        return json({ ok: true, notifications: 0 }, 200);
      }
      const count = Math.max(2, Math.floor(body.payload.count));
      const title = 'חשד לחשבונית כפולה';
      const message = `${count} חשבוניות של אותו ספק נושאות אותו מספר`;
      const pending = await claimStandingEventAndNotify(admin, {
        orgId: body.org_id,
        eventCode: 'duplicate_invoice',
        entityKey: body.payload.entity_key,
        severity: 'critical',
        title,
        body: message,
        targetUrl: '/invoices',
      });
      const results = await deliverQueuedNotifications(
        admin,
        body.org_id,
        pending,
        () => ({ title, body: message, url: '/invoices' }),
      );
      return json({ ok: true, notifications: pending.filter((row) => row.created).length, results }, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'notification write failed';
      return fail(message === 'organization_unavailable' ? 'org_unavailable' : 'query_failed', message,
        message === 'organization_unavailable' ? 409 : 500);
    }
  }

  // ===== event: payment_due_scan — fired daily by pg_cron (0016) =====
  if (body.event === 'payment_due_scan') {
    // A COARSE ORG FILTER, deliberately not preference-aware: it answers "which organizations
    // hold anybody who could be notified at all", so the scan can skip the rest. Narrowing it
    // by notification preferences would be wrong twice over -- an organization where every
    // recipient muted Push must still get its notification rows (OPEN-DECISIONS #39), and the
    // per-recipient decision belongs to enqueue_notification_delivery, which applies it.
    const { data: orgRows, error: orgErr } = await admin
      .from('profiles')
      .select('org_id')
      .eq('active', true).in('role', ALERT_ROLES);
    if (orgErr) return fail('query_failed', orgErr.message, 500);

    const orgIds = [...new Set((orgRows ?? []).map((r) => r.org_id as string))];
    const perOrg: Record<string, SendCounts & { due: number }> = {};
    const totals: SendCounts = { sent: 0, failed: 0, removed: 0 };

    for (const orgId of orgIds) {
      try {
        if (!await organizationCanNotify(admin, orgId)) continue;
      } catch (e) {
        return fail('query_failed', e instanceof Error ? e.message : 'organization access failed', 500);
      }
      // Same standing condition as alerts.ts scanPaymentsDueSoon: a due_date exists,
      // it is within DUE_SOON_DAYS (or already past — no lower bound, on purpose),
      // and the request still represents money owed (PR_ACTIVE).
      const { data: dueRows, error } = await admin
        .from('payment_requests')
        .select('id, number, due_date')
        .eq('org_id', orgId)
        .not('due_date', 'is', null)
        .lte('due_date', businessDate(DUE_SOON_DAYS))
        .in('status', PR_ACTIVE);
      if (error) {
        console.error('due scan failed for org', orgId, error.message);
        continue; // one broken org must not silence the others
      }
      const currentKeys = new Set((dueRows ?? []).map((row) => row.id as string));
      const { data: stateRows, error: stateErr } = await admin.from('notification_event_states')
        .select('entity_key').eq('org_id', orgId).eq('event_code', 'payment_due').eq('active', true);
      if (stateErr) {
        console.error('due state fetch failed for org', orgId, stateErr.message);
        continue;
      }
      const resolvedKeys = (stateRows ?? []).map((row) => row.entity_key as string)
        .filter((key) => !currentKeys.has(key));

      try {
        await closeStandingEvent(admin, orgId, 'payment_due', resolvedKeys);
        const rows: PendingNotification[] = [];
        const today = businessDate();
        for (const due of dueRows ?? []) {
          const severity: NotificationSeverity = String(due.due_date) < today ? 'critical' : 'warning';
          const title = severity === 'critical' ? 'תשלום עבר את מועד הפירעון' : 'תשלום מתקרב לפירעון';
          const message = `דרישת תשלום #${due.number} · מועד ${due.due_date}`;
          rows.push(...await claimStandingEventAndNotify(admin, {
            orgId,
            eventCode: 'payment_due',
            entityKey: due.id as string,
            severity,
            title,
            body: message,
            targetUrl: '/payment-requests',
          }));
        }

        const results = await deliverQueuedNotifications(
          admin,
          orgId,
          rows,
          (userRows) => ({
            title: 'תשלומים דורשים תשומת לב',
            body: userRows.length === 1 ? 'דרישת תשלום חדשה דורשת טיפול' : `${userRows.length} דרישות תשלום חדשות דורשות טיפול`,
            url: '/payment-requests',
          }),
        );
        perOrg[orgId] = { ...results, due: (dueRows ?? []).length };
      } catch (e) {
        console.error('due notification failed for org', orgId, e instanceof Error ? e.message : e);
        continue;
      }
      const orgResult = perOrg[orgId];
      totals.sent += orgResult.sent;
      totals.failed += orgResult.failed;
      totals.removed += orgResult.removed;
    }

    return json({ ok: true, results: totals, orgs: perOrg }, 200);
  }

  return fail('invalid_request', `unknown event ${String(body.event)}`, 400);
});
