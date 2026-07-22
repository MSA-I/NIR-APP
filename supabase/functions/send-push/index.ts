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
// single user's RLS view allows. It never mutates business data — only
// push_subscriptions cleanup on 404/410 (subscription expired at the push service).
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

/* ---------- thresholds mirrored from src/lib/alerts.ts ----------
 * scanPaymentsDueSoon (alerts.ts:150) is the on-screen twin of the cron scan below.
 * DUE_SOON_DAYS mirrors alerts.ts:42 and PR_ACTIVE mirrors alerts.ts:45 — they are
 * duplicated here knowingly (this file runs in Deno, the app in the browser; there is
 * no shared module). If one side changes, change the other in the same commit. */
const DUE_SOON_DAYS = 7;
const PR_ACTIVE = ['draft', 'pending_approval', 'approved', 'sent_for_execution'];

/** The in-app alerts screen is an owner/office decision surface (App.tsx FINANCE guard).
 *  The bell and Push use the same audience so a notification never links to a forbidden page. */
const ALERT_ROLES = ['owner', 'office'];
type NotificationSeverity = 'warning' | 'critical';

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface NotificationInsert {
  org_id: string;
  user_id: string;
  event_code: string;
  entity_key: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  target_url: string;
  dedupe_key: string;
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

async function recipientIds(admin: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await admin.from('profiles').select('id')
    .eq('org_id', orgId).eq('active', true).in('role', ALERT_ROLES);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.id as string);
}

/** Inserts only genuinely new events. The unique user_id+dedupe_key constraint turns an
 *  Edge retry into a no-op; the returned ids are exactly the users eligible for Push. */
async function insertNotifications(
  admin: SupabaseClient,
  rows: NotificationInsert[],
): Promise<string[]> {
  if (!rows.length) return [];
  const { data, error } = await admin.from('notifications')
    .upsert(rows, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true })
    .select('user_id');
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.user_id as string);
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

/** Claims a standing condition once per lifecycle, and once more on warning→critical.
 *  The SQL function locks the event-state row, so concurrent triggers cannot double-claim. */
async function claimStandingEvent(
  admin: SupabaseClient,
  orgId: string,
  eventCode: string,
  entityKey: string,
  severity: NotificationSeverity,
): Promise<string | null> {
  const { data, error } = await admin.rpc('claim_notification_event', {
    p_org_id: orgId,
    p_event_code: eventCode,
    p_entity_key: entityKey,
    p_severity: severity,
  });
  if (error) throw new Error(error.message);
  return typeof data === 'string' && data ? data : null;
}

async function closeStandingEvent(
  admin: SupabaseClient,
  orgId: string,
  eventCode: string,
  entityKeys: string[],
): Promise<void> {
  if (!entityKeys.length) return;
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
      );
      counts.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        const del = await admin.from('push_subscriptions').delete().eq('id', sub.id);
        if (del.error) console.error('failed to remove dead subscription', sub.id, del.error.message);
        counts.removed++;
      } else {
        // Endpoint host is enough for diagnosis; the full endpoint is a capability URL.
        console.error('push send failed', status ?? 'no-status', new URL(sub.endpoint).host);
        counts.failed++;
      }
    }
  }));

  return counts;
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
      const recipients = await recipientIds(admin, body.org_id);
      const insertedUsers = await insertNotifications(admin, recipients.map((userId) => ({
        org_id: body.org_id!, user_id: userId, event_code: 'price_increase',
        entity_key: body.payload!.event_key!, severity: 'warning', title, body: message,
        target_url: '/prices', dedupe_key: `price_increase:${body.payload!.event_key}`,
      })));
      const subs = await subscriptionsForUsers(admin, body.org_id, insertedUsers);
      const results = await sendToSubs(admin, subs, { title, body: message, url: '/prices' });
      return json({ ok: true, notifications: insertedUsers.length, results }, 200);
    } catch (e) {
      return fail('query_failed', e instanceof Error ? e.message : 'notification write failed', 500);
    }
  }

  // ===== event: duplicate_invoice_check — fired on identifying invoice changes (0017) =====
  if (body.event === 'duplicate_invoice_check') {
    if (typeof body.org_id !== 'string' || typeof body.payload?.entity_key !== 'string'
      || typeof body.payload.active !== 'boolean' || typeof body.payload.count !== 'number') {
      return fail('invalid_request', 'duplicate_invoice_check payload is incomplete', 400);
    }
    try {
      if (!body.payload.active) {
        await closeStandingEvent(admin, body.org_id, 'duplicate_invoice', [body.payload.entity_key]);
        return json({ ok: true, notifications: 0 }, 200);
      }
      const dedupeKey = await claimStandingEvent(
        admin, body.org_id, 'duplicate_invoice', body.payload.entity_key, 'critical',
      );
      if (!dedupeKey) return json({ ok: true, notifications: 0 }, 200);

      const recipients = await recipientIds(admin, body.org_id);
      const count = Math.max(2, Math.floor(body.payload.count));
      const title = 'חשד לחשבונית כפולה';
      const message = `${count} חשבוניות של אותו ספק נושאות אותו מספר`;
      const insertedUsers = await insertNotifications(admin, recipients.map((userId) => ({
        org_id: body.org_id!, user_id: userId, event_code: 'duplicate_invoice',
        entity_key: body.payload!.entity_key!, severity: 'critical', title, body: message,
        target_url: '/invoices', dedupe_key: dedupeKey,
      })));
      const subs = await subscriptionsForUsers(admin, body.org_id, insertedUsers);
      const results = await sendToSubs(admin, subs, { title, body: message, url: '/invoices' });
      return json({ ok: true, notifications: insertedUsers.length, results }, 200);
    } catch (e) {
      return fail('query_failed', e instanceof Error ? e.message : 'notification write failed', 500);
    }
  }

  // ===== event: payment_due_scan — fired daily by pg_cron (0016) =====
  if (body.event === 'payment_due_scan') {
    const { data: orgRows, error: orgErr } = await admin
      .from('profiles')
      .select('org_id').eq('active', true).in('role', ALERT_ROLES);
    if (orgErr) return fail('query_failed', orgErr.message, 500);

    const orgIds = [...new Set((orgRows ?? []).map((r) => r.org_id as string))];
    const perOrg: Record<string, SendCounts & { due: number }> = {};
    const totals: SendCounts = { sent: 0, failed: 0, removed: 0 };

    for (const orgId of orgIds) {
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
        const recipients = await recipientIds(admin, orgId);
        const rows: NotificationInsert[] = [];
        const today = businessDate();
        for (const due of dueRows ?? []) {
          const severity: NotificationSeverity = String(due.due_date) < today ? 'critical' : 'warning';
          const dedupeKey = await claimStandingEvent(admin, orgId, 'payment_due', due.id as string, severity);
          if (!dedupeKey) continue;
          const title = severity === 'critical' ? 'תשלום עבר את מועד הפירעון' : 'תשלום מתקרב לפירעון';
          const message = `דרישת תשלום #${due.number} · מועד ${due.due_date}`;
          rows.push(...recipients.map((userId) => ({
            org_id: orgId, user_id: userId, event_code: 'payment_due',
            entity_key: due.id as string, severity, title, body: message,
            target_url: '/payment-requests', dedupe_key: `${dedupeKey}:${userId}`,
          })));
        }

        const insertedUsers = await insertNotifications(admin, rows);
        const subs = await subscriptionsForUsers(admin, orgId, insertedUsers);
        const countsByUser = new Map<string, number>();
        for (const userId of insertedUsers) countsByUser.set(userId, (countsByUser.get(userId) ?? 0) + 1);
        const results: SendCounts = { sent: 0, failed: 0, removed: 0 };
        for (const [userId, count] of countsByUser) {
          const sent = await sendToSubs(admin, subs.filter((sub) => sub.user_id === userId), {
            title: 'תשלומים דורשים תשומת לב',
            body: count === 1 ? 'דרישת תשלום חדשה דורשת טיפול' : `${count} דרישות תשלום חדשות דורשות טיפול`,
            url: '/payment-requests',
          });
          results.sent += sent.sent; results.failed += sent.failed; results.removed += sent.removed;
        }
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
