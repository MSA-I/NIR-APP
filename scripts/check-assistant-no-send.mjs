/**
 * The assistant may compose a supplier reminder DRAFT and nothing else.
 *
 * OPEN-DECISIONS #191 (owner, 21.08.2026): draft-only, owner/office only. The assistant may write
 * Hebrew or English text labelled `טיוטה`, but it does not choose a recipient or a channel, does
 * not send, does not create an action proposal, and never shows `נשלח`. The person copies the text
 * and sends it themselves. #182 keeps the whole assistant read-only at launch and names
 * `purchase_orders` / `purchase_order_items` as forbidden outright. #193 says there are no flags or
 * commands for writing and external messages, because those capabilities do not exist.
 *
 * Why a script and not a code review: all four of these failures are ADDITIONS, and an addition is
 * exactly what a reviewer reading a diff of a feature they asked for is least likely to challenge.
 * "Show the supplier that the reminder went out" is one plausible sentence away from a product that
 * claims it sent an email it never sent — and the claim, not the sending, is the harm. The word on
 * the screen is the promise.
 *
 * The rules, and what each deliberately does NOT flag:
 *
 *   1. sent-claim — `נשלח` and its inflections, the passive "was sent". The product legitimately
 *      says הזמנות שנשלחו about purchase orders that really carry status='sent', so the PAST PLURAL
 *      forms are allowed on a line that names an order or an invoice, and nothing else is. Test and
 *      spec files are exempt from this rule alone, because #191's negative tests must contain the
 *      literal in order to forbid it — a guard that flagged them would make the test unwritable.
 *   2. send-affordance — the ACTIVE side of the verb (שלח / לשלוח / שליחה) next to a delivery
 *      channel. Either half alone is ordinary product vocabulary — `מועד השליחה לספק` is when an
 *      order left, and `אימייל` appears in the input classifier that REFUSES contact details — so
 *      both halves are required before this fires.
 *   3. external-send — a message-delivery vendor, an egress kind other than `assistant`, a
 *      send-shaped identifier, or an absolute URL to a host that is not the model provider. The
 *      other eight egress kinds registered in _shared/organization-egress.ts are the exact names a
 *      future "just reuse the supplier email lease" change would reach for.
 *   4. flag-key — a quoted `assistant.<key>` outside the three flags that exist plus the one POLICY
 *      key. `assistant.confirmed_actions` is not a flag: ENTERPRISE-SECURITY-MODEL §8 forbids a
 *      flag from granting permission, so the confirmed-action switch follows the 0076 policy
 *      pattern instead. p4_flags_identity.sql pins the flag COUNT; this pins the names.
 *   5. order-write — a purchase-order table within reach of a mutating call. #109(ד1) blocks it for
 *      a reason that outlives the assistant: writing there rewrites snapshot price history.
 *
 * Rules 2, 3 and 4 skip comment lines: a comment naming Resend as a sub-processor, or naming the
 * `assistant.enabled` entitlement that was deliberately NOT created, is the documentation working.
 * Code is what can send.
 *
 * Portability note: this runs on Windows under a Hebrew path. It is plain Node with no shell, no
 * grep/tail/tr, and it resolves its own location with fileURLToPath rather than URL.pathname —
 * pathname hands back a percent-encoded string that scandir cannot open.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The assistant surface. `src/components/AssistantPanel.tsx` is listed by name on purpose: the
 * panel lives one directory ABOVE src/components/assistant/, and a guard that stopped at the
 * folder boundary would skip the file that renders everything the user actually reads.
 */
const SURFACE = [
  'supabase/functions/assistant',
  'src/lib/assistant',
  'src/components/assistant',
  'src/components/AssistantPanel.tsx',
];

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs)$/;

/** A comment line. Prose about sending is not a way to send. */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// ------------------------------------------------- rules 1 and 2: the Hebrew send verb

/** Maximal runs of Hebrew letters, geresh and gershayim included (מנכ״ל, צ׳ק). */
const HEBREW_TOKEN = /[\u05D0-\u05EA\u05F3\u05F4]+/g;

/**
 * `נשלח` — the passive perfect, "was sent". Every Hebrew word containing this sequence is a form of
 * it (נשלח, נשלחה, נשלחו, נשלחים, שנשלחה, כשנשלח) and nothing else contains it, so matching the
 * substring matches the family — including the prefixed forms a search for the five bare letters
 * would miss.
 */
const WAS_SENT = 'נשלח';

/**
 * Past plural only — נשלחו / שנשלחו / ונשלחו — and only about an order or an invoice. Those two
 * really carry a sent state in the data model (`purchase_orders.status='sent'`, approved invoices
 * handed to bookkeeping), so "ההזמנות נשלחו לספק" is a fact the database holds. Every singular form
 * stays forbidden: "התזכורת נשלחה" is a claim nothing in this product can back.
 */
const SENT_PAST_PLURAL = new Set(['נשלחו', 'שנשלחו', 'ונשלחו']);

/** הזמנ… / חשבוני… — the two product objects that really carry a sent state. */
const PRODUCT_SENT_SUBJECT = /הזמנ|חשבוני/;

/**
 * The ACTIVE side of the same verb. On its own this is ordinary product vocabulary: `מועד השליחה`
 * is when an order left, `מידע שלא ניתן לשלוח לעוזר` is the input classifier refusing, and
 * `תקן ושלח שוב JSON` is the retry instruction to the model. It becomes an affordance only next to
 * a delivery channel — which is why both halves are required.
 */
const SEND_STEMS = ['שלח', 'שלוח', 'שליח'];

/** A channel, or the thing one would send through it. */
const DELIVERY_CHANNEL = new RegExp(
  'מייל|דוא|וואטס|ווצאפ|מסרון|הודע|תזכור'
  + '|whats?app|\\bsms\\b|\\bmail\\b',
  'i',
);

/**
 * The one line in the product allowed to hold the banned word: its own definition.
 *
 * `validate.ts` REFUSES a draft that claims something was sent, and a refusal has to name the
 * thing it refuses. A guard reading string literals cannot tell a ban from an affordance, so the
 * word lives in exactly one exported constant in contracts.ts and every checker imports it. The
 * allowance is anchored to that file and that symbol — anywhere else, including a second
 * constant with a different name, still fails.
 */
const SENT_MARKER_DEFINITION =
  /^\s*export const ASSISTANT_SENT_CLAIM_MARKER\s*=\s*'[^']+';\s*$/;
const SENT_MARKER_FILE = 'src/lib/assistant/contracts.ts';

function hebrewSendFindings(lines, rel) {
  const found = [];
  lines.forEach((line, index) => {
    if (rel === SENT_MARKER_FILE && SENT_MARKER_DEFINITION.test(line)) return;
    for (const token of line.match(HEBREW_TOKEN) ?? []) {
      if (token.includes(WAS_SENT)) {
        if (SENT_PAST_PLURAL.has(token) && PRODUCT_SENT_SUBJECT.test(line)) continue;
        found.push({
          line: index + 1,
          rule: 'sent-claim',
          detail:
            `"${token}" claims something was sent; the only allowed form is the past plural about an order or an invoice`,
          text: line,
        });
        continue;
      }
      if (!SEND_STEMS.some((stem) => token.includes(stem))) continue;
      if (!DELIVERY_CHANNEL.test(line)) continue;
      found.push({
        line: index + 1,
        rule: 'send-affordance',
        detail: `"${token}" next to a delivery channel — the assistant never picks a channel and never sends`,
        text: line,
      });
    }
  });
  return found;
}

// ------------------------------------------------------------ rule 3: external-send

/**
 * The eight other egress kinds in _shared/organization-egress.ts. The assistant reserves under
 * `assistant` and only `assistant`; naming any of these here is how an external-message path would
 * arrive wearing an existing lease.
 */
const FOREIGN_EGRESS_KINDS = [
  'document_interpretation',
  'invitation_email',
  'push_notification',
  'integration_webhook',
  'document_signed_url',
  'whatsapp_reminder',
  'organization_logo_storage',
  'supplier_order_email',
];

/** Message-delivery vendors and transports. */
const DELIVERY_VENDOR =
  /\b(nodemailer|sendgrid|mailgun|postmark|mailchimp|twilio|vonage|messagebird|resend|smtp)\b/i;

/** A send-shaped identifier: sendEmail, send_sms, whatsappSend, deliverReminder, mailto:. */
const SEND_SHAPED = new RegExp(
  '(send|deliver|dispatch)[_-]?(email|mail|sms|whatsapp|message|reminder|notification)'
  + '|(email|sms|whatsapp|reminder)[_-]?(send|delivery|dispatch)'
  + '|mailto:',
  'i',
);

/**
 * Hosts a product file on this surface may name. `api.openai.com` is the one allowed direction
 * (browser → InPlace boundary → provider); `inplace.invalid` is a parse sentinel in routeAccess.ts
 * and contracts.ts that is never fetched — it exists so a source route trying to be an absolute URL
 * fails to parse as a relative one.
 */
const ALLOWED_HOSTS = new Set(['api.openai.com', 'inplace.invalid']);
const ABSOLUTE_URL = /https?:\/\/([A-Za-z0-9.-]+)/g;

function externalSendFindings(lines, isTest) {
  const found = [];
  lines.forEach((line, index) => {
    const at = (rule, detail) => found.push({ line: index + 1, rule, detail, text: line });

    for (const kind of FOREIGN_EGRESS_KINDS) {
      if (line.includes(`'${kind}'`) || line.includes(`"${kind}"`)) {
        at('external-send', `egress kind "${kind}" — the assistant reserves under "assistant" only`);
      }
    }
    if (isCommentLine(line)) return;

    const vendor = DELIVERY_VENDOR.exec(line);
    if (vendor) {
      at('external-send', `message-delivery vendor "${vendor[1]}" reachable from the assistant boundary`);
    }

    // The last two checks are product-code only. A test may legitimately assert that a forbidden
    // column named `whatsapp` is never projected (tools/reads.test.ts does exactly that), and a
    // fixture may name an example host.
    if (isTest) return;

    const shaped = SEND_SHAPED.exec(line);
    if (shaped) {
      at('external-send', `send-shaped identifier "${shaped[0]}" — the assistant drafts, it never delivers`);
    }
    for (const match of line.matchAll(ABSOLUTE_URL)) {
      if (!ALLOWED_HOSTS.has(match[1])) {
        at('external-send', `absolute URL to "${match[1]}" — the only allowed egress host is api.openai.com`);
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------- rule 4: flag-key

/**
 * The three flags that exist (#193: `assistant.ui` is the surface switch and turns on every
 * approved read tool together), plus the confirmed-actions POLICY key, which is deliberately not a
 * flag. A fifth name means a capability was claimed in the operator UI; #191/#182 say there is
 * nothing behind it.
 */
const KNOWN_ASSISTANT_KEYS = new Set([
  'assistant.ui',
  'assistant.history',
  'assistant.drafts',
  'assistant.confirmed_actions',
]);
const QUOTED_ASSISTANT_KEY = /['"`](assistant\.[A-Za-z0-9_.]+)['"`]/g;

function flagKeyFindings(lines) {
  const found = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    for (const match of line.matchAll(QUOTED_ASSISTANT_KEY)) {
      if (KNOWN_ASSISTANT_KEYS.has(match[1])) continue;
      found.push({
        line: index + 1,
        rule: 'flag-key',
        detail: `"${match[1]}" is not one of the three assistant flags or the confirmed-actions policy key`,
        text: line,
      });
    }
  });
  return found;
}

// -------------------------------------------------------------- rule 5: order-write

const ORDER_TABLE = /purchase_order_items|purchase_orders/g;
const MUTATING_CALL = /\.(insert|update|upsert|delete)\s*\(/;
/** An RPC whose name reads like an order write. Read RPCs (`p2_…_rows`, snapshots) do not match. */
const ORDER_WRITE_RPC =
  /['"`][a-z0-9_]*(create|update|delete|cancel|approve|submit|confirm)_[a-z0-9_]*(order|purchase)[a-z0-9_]*['"`]/i;
/** Characters either side of a table mention that still count as the same statement. */
const STATEMENT_WINDOW = 240;

function orderWriteFindings(text, lines) {
  const found = [];
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  for (const match of text.matchAll(ORDER_TABLE)) {
    const window = text.slice(
      Math.max(0, match.index - STATEMENT_WINDOW),
      match.index + STATEMENT_WINDOW,
    );
    if (!MUTATING_CALL.test(window)) continue;
    const index = lineOf(match.index);
    found.push({
      line: index + 1,
      rule: 'order-write',
      detail: `${match[0]} within reach of a mutating call — #182 forbids the assistant writing there`,
      text: lines[index],
    });
  }

  lines.forEach((line, index) => {
    const rpc = ORDER_WRITE_RPC.exec(line);
    if (rpc) {
      found.push({
        line: index + 1,
        rule: 'order-write',
        detail: `order-write RPC ${rpc[0]} reachable from the assistant surface`,
        text: line,
      });
    }
  });
  return found;
}

// -------------------------------------------------------------------------- driver

function walk(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return SOURCE_EXTENSIONS.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => {
    // node_modules lives INSIDE supabase/functions/assistant (Deno's nodeModulesDir: auto).
    // Walking it would scan a mail library nobody imports and fail the gate on vendored code.
    if (entry === 'node_modules' || entry === '.git') return [];
    return walk(join(path, entry));
  });
}

const findings = [];
let scanned = 0;
for (const entry of SURFACE) {
  for (const file of walk(join(ROOT, entry))) {
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const isTest = TEST_FILE.test(file);
    const rel = relative(ROOT, file).split('\\').join('/');
    const here = [
      ...(isTest ? [] : hebrewSendFindings(lines, rel)),
      ...externalSendFindings(lines, isTest),
      ...flagKeyFindings(lines),
      ...orderWriteFindings(text, lines),
    ];
    for (const finding of here) {
      findings.push({ ...finding, file: rel });
    }
  }
}

if (scanned === 0) {
  // A guard that scans nothing reports clean. That is the one failure mode that would make every
  // future run of this script meaningless, so it is an error rather than a pass.
  console.error('check:assistant-no-send FAILED — the assistant surface was not found.');
  console.error(`  Looked under ${ROOT} for:\n    ${SURFACE.join('\n    ')}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    'check:assistant-no-send FAILED — the assistant drafts text and nothing else (#182/#191/#193).\n',
  );
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.detail}`);
    console.error(`      ${finding.text.trim().slice(0, 140)}`);
  }
  console.error(
    '\n  #191: the assistant composes a draft labelled טיוטה. It does not choose a recipient or a'
    + '\n  channel, does not send, and never displays נשלח — the person copies the text and sends it.'
    + '\n  #182 keeps the assistant read-only and forbids purchase_orders / purchase_order_items.'
    + '\n  #193: there are three flags and no external-message command, because the capability does'
    + '\n  not exist. Adding one reopens all three owner decisions — it is not a code change.',
  );
  process.exit(1);
}

console.log('assistant-no-send: OK');
