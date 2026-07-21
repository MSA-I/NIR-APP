// send-push — delivers Web Push notifications to subscribed devices.
//
// Callers are NOT browsers: the price-increase DB trigger and the pg_cron due-payments
// scan (both in supabase/migrations/0016_push_triggers.sql) invoke this over pg_net.
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
//   { event: 'price_increase', org_id: uuid, payload: { count: number } }
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

/** Roles that get the price-increase notification — the people who negotiate with
 *  suppliers (matches the audience of the /prices screen: owner + office). */
const PRICE_INCREASE_ROLES = ['owner', 'office'];

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
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

function daysAhead(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

  let body: { event?: string; org_id?: string; payload?: { count?: number } };
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'body is not valid JSON', 400);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ===== event: price_increase — fired by the supplier_products trigger (0016) =====
  if (body.event === 'price_increase') {
    if (typeof body.org_id !== 'string' || typeof body.payload?.count !== 'number' || body.payload.count < 1) {
      return fail('invalid_request', 'price_increase requires org_id and payload.count >= 1', 400);
    }
    const count = Math.floor(body.payload.count);

    // Only the roles that act on prices; the !inner join drops subscriptions whose
    // profile no longer matches (role changed, user deactivated row cascade-deleted).
    const { data, error } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, profiles!inner(role)')
      .eq('org_id', body.org_id)
      .in('profiles.role', PRICE_INCREASE_ROLES);
    if (error) return fail('query_failed', error.message, 500);

    const subs = (data ?? []) as unknown as SubRow[];
    const results = await sendToSubs(admin, subs, {
      title: 'עליית מחיר אצל ספק',
      body: count === 1
        ? 'מחיר אחד עודכן כלפי מעלה במחירון'
        : `${count} מחירים עודכנו כלפי מעלה במחירון`,
      url: '/prices',
    });
    return json({ ok: true, results }, 200);
  }

  // ===== event: payment_due_scan — fired daily by pg_cron (0016) =====
  if (body.event === 'payment_due_scan') {
    const { data: orgRows, error: orgErr } = await admin
      .from('push_subscriptions')
      .select('org_id');
    if (orgErr) return fail('query_failed', orgErr.message, 500);

    const orgIds = [...new Set((orgRows ?? []).map((r) => r.org_id as string))];
    const perOrg: Record<string, SendCounts & { due: number }> = {};
    const totals: SendCounts = { sent: 0, failed: 0, removed: 0 };

    for (const orgId of orgIds) {
      // Same standing condition as alerts.ts scanPaymentsDueSoon: a due_date exists,
      // it is within DUE_SOON_DAYS (or already past — no lower bound, on purpose),
      // and the request still represents money owed (PR_ACTIVE).
      const { count, error } = await admin
        .from('payment_requests')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .not('due_date', 'is', null)
        .lte('due_date', daysAhead(DUE_SOON_DAYS))
        .in('status', PR_ACTIVE);
      if (error) {
        console.error('due scan failed for org', orgId, error.message);
        continue; // one broken org must not silence the others
      }
      if (!count) continue; // nothing due — no notification, never a "0 due" push

      const { data: subData, error: subErr } = await admin
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('org_id', orgId);
      if (subErr) {
        console.error('subscription fetch failed for org', orgId, subErr.message);
        continue;
      }

      const results = await sendToSubs(admin, (subData ?? []) as SubRow[], {
        title: 'תשלומים מתקרבים',
        body: count === 1
          ? `דרישת תשלום אחת לפירעון תוך ${DUE_SOON_DAYS} ימים או שמועדה עבר`
          : `${count} דרישות תשלום לפירעון תוך ${DUE_SOON_DAYS} ימים או שמועדן עבר`,
        url: '/payment-requests',
      });
      perOrg[orgId] = { ...results, due: count };
      totals.sent += results.sent;
      totals.failed += results.failed;
      totals.removed += results.removed;
    }

    return json({ ok: true, results: totals, orgs: perOrg }, 200);
  }

  return fail('invalid_request', `unknown event ${String(body.event)}`, 400);
});
