// send-feedback -- posts one already-stored feedback note to the vendor's Discord channel.
//
// Why an Edge Function: the Discord webhook URL is a bearer capability. Anyone holding it can
// post to the channel, so it never reaches the browser.
//
// Why the request carries a note ID and not the note text: the row is the record. Taking the id
// means the message can only ever say what the database holds -- a caller cannot compose a
// Discord post that has no matching row, and the vendor can always find the note that produced
// the message.
//
// Two clients, each with exactly one job:
//   * the CALLER's JWT reads the note. That read IS the authorisation -- RLS returns the row only
//     to a member of its organization (0090), so no role check is re-implemented here. Same
//     discipline as send-invite, where the RPCs enforce ownership.
//   * service_role writes sent_at / send_error, because `authenticated` deliberately holds no
//     grant on those columns (0090): "delivered" must be a fact the server recorded, never a
//     claim the client made.
//
// Required environment (supabase secrets set ...):
//   DISCORD_FEEDBACK_WEBHOOK_URL -- channel webhook; Server Settings > Integrations > Webhooks
//   APP_BASE_URL                 -- CORS origin, as in send-invite
//   ALLOWED_ORIGINS              -- optional, comma-separated; add http://localhost:5199 for dev
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';

/** Echo the caller's Origin only when it is on the allowlist -- never a blanket '*'. */
function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';

  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

type ErrorCode = 'unauthenticated' | 'invalid_request' | 'note_unknown' | 'delivery_failed' | 'misconfigured';

/** Hebrew message per code -- the UI shows these verbatim, so each one says what actually happened. */
const MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'נדרשת התחברות',
  invalid_request: 'בקשה לא תקינה',
  note_unknown: 'ההערה לא נמצאה',
  delivery_failed: 'ההערה נשמרה, אך השליחה נכשלה',
  misconfigured: 'ערוץ ההערות אינו מוגדר בסביבה זו',
};

/** MIRROR, NOT AUTHORITY — the same standing as send-push's role list and send-invite's own copy.
 *  The display vocabulary lives in src/lib/status.ts:168; this file runs in Deno and cannot import
 *  it. If a label changes there, change it here in the same commit. */
const ROLE_LABEL: Record<string, string> = {
  owner: 'מנהל/בעלים',
  kitchen: 'מנהל מטבח',
  office: 'מנהל רכש',
  payer: 'מבצע העברות',
  accountant: 'הנהלת חשבונות',
  supplier: 'ספק',
};

interface NoteRow {
  id: string;
  org_id: string;
  user_id: string;
  note: string;
  route: string;
  role: string;
  viewport_width: number | null;
  app_release: string | null;
  created_at: string;
  sent_at: string | null;
}

function fail(cors: Record<string, string>, code: ErrorCode, status: number) {
  return new Response(JSON.stringify({ error: { code, message: MESSAGE[code] } }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function ok(cors: Record<string, string>, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Discord's content limit. The note is capped at 1500 in the schema; the header takes the rest. */
const DISCORD_CONTENT_LIMIT = 2000;

/**
 * The context header comes FIRST and the note last, deliberately: the note is untrusted text, and
 * a note that opens with markdown cannot displace or forge the lines above it. Mentions are
 * disabled at the API level below, so `@everyone` inside a note stays inert text.
 */
function composeMessage(note: NoteRow, orgName: string, authorName: string): string {
  const when = new Intl.DateTimeFormat('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  }).format(new Date(note.created_at));

  const header = [
    `**הערה חדשה מ-${orgName}**`,
    `מסך: \`${note.route}\``,
    `מי: ${authorName} · ${ROLE_LABEL[note.role] ?? note.role}`,
    `מכשיר: ${note.viewport_width ? `${note.viewport_width}px` : 'רוחב לא נמסר'}`
      + ` · גרסה: ${note.app_release ?? 'לא נמסרה'}`,
    `מתי: ${when}`,
    '',
  ].join('\n');

  const room = DISCORD_CONTENT_LIMIT - header.length - 1;
  const body = note.note.length <= room
    ? note.note
    // Only reachable if the header grows; the note itself is capped below the limit by the schema.
    : `${note.note.slice(0, Math.max(0, room - 40))}…\n(נחתך — הטקסט המלא במסך הניהול)`;

  return header + body;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(cors, 'invalid_request', 405);

  const webhookUrl = Deno.env.get('DISCORD_FEEDBACK_WEBHOOK_URL');
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!webhookUrl || !url || !anonKey || !serviceKey) return fail(cors, 'misconfigured', 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail(cors, 'unauthenticated', 401);

  let body: { noteId?: unknown };
  try {
    body = await req.json() as { noteId?: unknown };
  } catch {
    return fail(cors, 'invalid_request', 400);
  }
  if (typeof body.noteId !== 'string' || !body.noteId) return fail(cors, 'invalid_request', 400);

  // Caller-scoped: RLS decides whether this note exists for this user. No role check here.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData?.user) return fail(cors, 'unauthenticated', 401);

  const { data: noteData, error: noteError } = await asCaller
    .from('feedback_notes')
    .select('id, org_id, user_id, note, route, role, viewport_width, app_release, created_at, sent_at')
    .eq('id', body.noteId)
    .maybeSingle();
  if (noteError) {
    console.error('feedback note read failed', noteError.message);
    return fail(cors, 'invalid_request', 400);
  }
  if (!noteData) return fail(cors, 'note_unknown', 404);
  const note = noteData as NoteRow;

  // Already delivered: say so and post nothing. A second click must not duplicate the message.
  if (note.sent_at) return ok(cors, { ok: true, sentAt: note.sent_at, duplicate: true });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Display names only. Read as service_role so the message never depends on how wide the
  // caller's own read policies happen to be.
  const [{ data: org }, { data: author }] = await Promise.all([
    admin.from('organizations').select('name').eq('id', note.org_id).maybeSingle(),
    admin.from('profiles').select('full_name').eq('id', note.user_id).maybeSingle(),
  ]);

  const content = composeMessage(
    note,
    (org?.name as string | undefined) ?? 'ארגון לא מזוהה',
    (author?.full_name as string | undefined) ?? 'משתמש לא מזוהה',
  );

  let sendError: string | null = null;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        // A customer's note is untrusted text: no mention in it may ever ping the channel.
        allowed_mentions: { parse: [] },
      }),
    });
    // Discord answers 204 with no body on success.
    if (!res.ok) sendError = `discord_status_${res.status}`;
  } catch (e) {
    sendError = e instanceof Error ? `discord_unreachable: ${e.message}` : 'discord_unreachable';
  }

  const sentAt = sendError ? null : new Date().toISOString();
  const { error: writeError } = await admin.from('feedback_notes')
    .update({ sent_at: sentAt, send_error: sendError })
    .eq('id', note.id);
  if (writeError) {
    // The note is stored and may well have been delivered; only the bookkeeping failed. Say the
    // weaker of the two truths rather than claiming delivery.
    console.error('feedback send bookkeeping failed', writeError.message);
    return fail(cors, 'delivery_failed', 502);
  }

  // ponytail: one attempt, no retry machinery. The row is the record and /admin is the fallback
  // view; wire the existing outbox-worker in only if notes actually start getting lost.
  if (sendError) {
    console.error('feedback delivery failed', sendError);
    return fail(cors, 'delivery_failed', 502);
  }

  return ok(cors, { ok: true, sentAt });
});
