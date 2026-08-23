import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CHANNEL_STATE,
  EMAIL_RETRYABLE_STATUSES,
  emailDeliveryReason,
  type EmailOrderMessage,
} from './orderEmail';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function message(overrides: Partial<EmailOrderMessage> = {}): EmailOrderMessage {
  return {
    id: 'm1', org_id: 'o1', order_id: 'po1', supplier_id: 's1', link_id: 'l1', kind: 'order',
    status: 'accepted', delivery_state: 'accepted', to_email: 'supplier@example.test',
    locale: 'he', template_name: 'new_purchase_order', template_version: 1,
    provider_message_id: 'prov-1', attempt_count: 1, last_attempt_at: null, accepted_at: null,
    delivered_at: null, failed_at: null, error_code: null, error_message: null,
    created_at: '2026-08-23T09:00:00Z', updated_at: '2026-08-23T09:00:00Z',
    ...overrides,
  };
}

// #238: an order email that was accepted and then bounced leaves the ORDER `sent`; the email
// CHANNEL becomes delivery_failed and a resend is offered. Showing `delivered` is forbidden.
describe('the email channel state (#238)', () => {
  it('every channel state has its own Hebrew claim, and failure is not delivery', () => {
    for (const state of ['pending', 'accepted', 'delivered', 'delivery_failed', 'unknown'] as const) {
      expect(EMAIL_CHANNEL_STATE[state]?.label, state).toBeTruthy();
    }
    const labels = Object.values(EMAIL_CHANNEL_STATE).map((meta) => meta.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(EMAIL_CHANNEL_STATE.delivered.tone).toBe('done');
    expect(EMAIL_CHANNEL_STATE.delivery_failed.tone).toBe('alert');
    // "נמסרה לספק המייל" and "נמסרה לנמען" are different claims and stay different (#187).
    expect(EMAIL_CHANNEL_STATE.accepted.label).not.toBe(EMAIL_CHANNEL_STATE.delivered.label);
  });

  it('a resend is offered after a bounce, and never while the provider still holds it', () => {
    expect(EMAIL_RETRYABLE_STATUSES).toContain('bounced');
    expect(EMAIL_RETRYABLE_STATUSES).toContain('failed');
    expect(EMAIL_RETRYABLE_STATUSES).toContain('queued');
    expect(EMAIL_RETRYABLE_STATUSES).not.toContain('accepted');
    expect(EMAIL_RETRYABLE_STATUSES).not.toContain('delivered');
    expect(EMAIL_RETRYABLE_STATUSES).not.toContain('sending');
    // A frozen thread needs a human, not a button (0168's `unknown` rule).
    expect(EMAIL_RETRYABLE_STATUSES).not.toContain('unknown');
  });
});

describe('the bounded delivery reason', () => {
  it('says nothing when there is nothing to say', () => {
    expect(emailDeliveryReason(message())).toBeNull();
    expect(emailDeliveryReason(message({ status: 'delivered', delivery_state: 'delivered' })))
      .toBeNull();
  });

  it('turns each bounded bounce code into one Hebrew sentence', () => {
    const codes = [
      'bounce_permanent', 'bounce_transient', 'bounce_undetermined', 'bounce_unclassified',
    ];
    const sentences = codes.map((code) => {
      const reason = emailDeliveryReason(message({
        status: 'bounced', delivery_state: 'delivery_failed', error_code: code,
      }));
      expect(reason, code).not.toBeNull();
      return reason!.sentence;
    });
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(10);
    expect(new Set(sentences).size, 'each bounce classification reads differently')
      .toBe(sentences.length);
  });

  it('falls back rather than inventing a diagnosis for an unseen code', () => {
    const reason = emailDeliveryReason(message({
      status: 'bounced', delivery_state: 'delivery_failed', error_code: 'something_new',
    }));
    expect(reason?.sentence).toBeTruthy();
    expect(reason?.sentence).not.toContain('something_new');
  });

  it('passes the provider sentence through as bounded secondary detail only', () => {
    const reason = emailDeliveryReason(message({
      status: 'bounced', delivery_state: 'delivery_failed', error_code: 'bounce_permanent',
      error_message: 'The recipient mailbox does not exist.',
    }));
    expect(reason?.providerDetail).toBe('The recipient mailbox does not exist.');
    expect(emailDeliveryReason(message({
      status: 'bounced', delivery_state: 'delivery_failed', error_code: 'bounce_permanent',
      error_message: '   ',
    }))?.providerDetail).toBeNull();
  });

  it('covers a send that never left as well as one that came back', () => {
    const failed = emailDeliveryReason(message({
      status: 'failed', delivery_state: 'delivery_failed', error_code: 'provider_500',
    }));
    const bounced = emailDeliveryReason(message({
      status: 'bounced', delivery_state: 'delivery_failed', error_code: 'bounce_permanent',
    }));
    expect(failed?.sentence).toBeTruthy();
    expect(bounced?.sentence).toBeTruthy();
    expect(failed?.sentence).not.toBe(bounced?.sentence);
  });
});

// The honesty rules of the delivery webhook, pinned as source contracts (the
// orderEmailContract.spec.ts idiom). These are the properties a later edit is most likely to
// break quietly, because breaking them still compiles and still renders.
describe('the delivery webhook boundary', () => {
  const webhookFiles = [
    'supabase/functions/email-webhook/core.ts',
    'supabase/functions/email-webhook/index.ts',
  ];
  const migration = () => source('supabase/migrations/0190_email_delivery_events.sql');

  it('the webhook never moves the order lifecycle (#238)', () => {
    for (const file of webhookFiles) {
      expect(source(file), file).not.toContain('purchase_orders');
      expect(source(file), file).not.toContain('transition_purchase_order_status');
    }
    // The migration may DISCUSS the order in prose; it may not write it.
    expect(migration()).not.toMatch(/\b(update|insert\s+into|delete\s+from)\s+purchase_orders\b/i);
  });

  it('de-duplication and the monotonic ladder are database facts, not Edge opinions', () => {
    expect(migration()).toMatch(/create unique index[\s\S]*?email_delivery_events \(provider, provider_event_id\)/);
    expect(migration()).toContain('private.email_delivery_rank');
    // The rank comparison — the thing that stops a late `delivered` overwriting a `bounced` —
    // must live in SQL. core.ts must not grow its own copy.
    expect(source('supabase/functions/email-webhook/core.ts')).not.toContain('rank');
  });

  it('the signature is verified over the raw body, with the contract cited and dated', () => {
    const core = source('supabase/functions/email-webhook/core.ts');
    expect(core).toContain('https://docs.svix.com/receiving/verifying-payloads/how-manual');
    expect(core).toContain('https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests');
    expect(core).toContain('read 2026-08-23');
    expect(core).toContain('svix-signature');
    const index = source('supabase/functions/email-webhook/index.ts');
    // request.text() must be reached before JSON.parse, or the signature can never match.
    expect(index.indexOf('request.text()')).toBeGreaterThan(-1);
    expect(index.indexOf('request.text()')).toBeLessThan(index.indexOf('JSON.parse'));
    // No SDK is imported to do eight lines of Web Crypto, and core.ts imports nothing at all —
    // that is what lets core.test.ts run with zero permissions and no network.
    expect(index).not.toMatch(/from\s+['"][^'"]*svix/i);
    expect(core).not.toMatch(/^\s*import\s/m);
    // Nothing provider-shaped is ever logged: a bounce payload carries a supplier's address.
    expect(index).not.toMatch(/console\.(log|error|warn)\([^)]*(rawBody|signingSecret|payload)/);
  });

  it('no raw provider payload is stored anywhere, and the reason is capped by the database', () => {
    expect(migration()).toMatch(/char_length\(reason_message\) <= 500/);
    expect(migration()).not.toMatch(/\b(payload|raw_body|raw_event)\s+jsonb\b/i);
    expect(migration()).toContain('revoke all on table email_delivery_events');
  });
});

describe('the order email card', () => {
  const card = () => source('src/components/EmailOrderCard.tsx');

  it('renders the channel state, not the raw provider word', () => {
    expect(card()).toContain('EMAIL_CHANNEL_STATE');
    expect(card()).toContain('delivery_state');
    expect(card()).toContain('EMAIL_RETRYABLE_STATUSES');
  });

  it('never claims delivery it cannot prove, and never shows a credential', () => {
    expect(card()).not.toContain('api.resend.com');
    expect(card()).not.toContain('RESEND');
    expect(card()).not.toContain('provider_message_id');
  });

  it('stays RTL-safe: logical properties only, numbers marked', () => {
    const value = card();
    expect(value).not.toMatch(/\b(ml|mr|pl|pr|left|right)-[0-9]/);
    expect(value).not.toMatch(/\btext-(left|right)\b/);
    expect(value).toContain('className="num"');
  });
});
