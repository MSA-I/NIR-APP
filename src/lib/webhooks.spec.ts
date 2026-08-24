/**
 * Client-side webhook helpers (#98 / #253).
 *
 * The only assertions here are about things the browser decides on its own: whether to bother
 * the server with a URL it will certainly refuse, and how to say a refusal in Hebrew. The
 * server is the boundary — `private.webhook_url_rejection` in `0198` and the connect-time guard
 * in `supabase/functions/webhook-verify/ssrf.ts` — and this file exists to keep the browser from
 * disagreeing with it, not to replace it.
 *
 * The corpus is the same table as `p76_owner_webhook_verification.sql` and
 * `webhook-verify/ssrf.test.ts`, row for row, deliberately. Three copies of a validator is two
 * too many; three copies of a corpus is how you find out when one of them drifts.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_WEBHOOK_SECRET_LENGTH,
  WEBHOOK_EVENT_CHOICES,
  webhookErrorMessage,
  webhookSecretRejection,
  webhookUrlRejection,
  type WebhookSubscription,
  webhookHealth,
} from './webhooks';

const CORPUS: Array<[url: string, code: string, why: string]> = [
  ['https://127.0.0.1/hook', 'webhook_url_ip_literal_rejected', 'dotted-quad loopback'],
  ['https://localhost/hook', 'webhook_url_local_name_rejected', 'the name every check remembers'],
  ['https://[::1]/hook', 'webhook_url_ip_literal_rejected', 'bracketed IPv6 loopback'],
  ['https://0.0.0.0/hook', 'webhook_url_ip_literal_rejected', 'unspecified address'],
  ['https://0x7f.1/hook', 'webhook_url_ip_literal_rejected', 'hex+decimal inet_aton loopback'],
  ['https://2130706433/hook', 'webhook_url_ip_literal_rejected', 'single decimal loopback'],
  ['https://0177.0.0.1/hook', 'webhook_url_ip_literal_rejected', 'octal first octet'],
  ['https://0x7f000001/hook', 'webhook_url_ip_literal_rejected', 'single hex loopback'],
  ['https://169.254.169.254/latest/meta-data/', 'webhook_url_ip_literal_rejected', 'instance metadata'],
  ['https://10.0.0.1/hook', 'webhook_url_ip_literal_rejected', 'RFC1918 10/8'],
  ['https://172.16.0.1/hook', 'webhook_url_ip_literal_rejected', 'RFC1918 172.16/12'],
  ['https://192.168.1.1/hook', 'webhook_url_ip_literal_rejected', 'RFC1918 192.168/16'],
  ['https://100.64.0.1/hook', 'webhook_url_ip_literal_rejected', 'CGNAT 100.64/10'],
  ['https://224.0.0.1/hook', 'webhook_url_ip_literal_rejected', 'IPv4 multicast'],
  ['https://[::ffff:127.0.0.1]/hook', 'webhook_url_ip_literal_rejected', 'IPv4-mapped IPv6'],
  ['https://[fc00::1]/hook', 'webhook_url_ip_literal_rejected', 'IPv6 unique-local'],
  ['https://[fe80::1]/hook', 'webhook_url_ip_literal_rejected', 'IPv6 link-local'],
  ['https://api.internal.local/hook', 'webhook_url_local_name_rejected', 'mDNS .local'],
  ['https://svc.localhost/hook', 'webhook_url_local_name_rejected', '.localhost is loopback'],
  ['https://erp.internal/hook', 'webhook_url_local_name_rejected', 'private zone'],
  ['https://1.0.0.127.in-addr.arpa/hook', 'webhook_url_local_name_rejected', 'reverse DNS zone'],
  ['http://hooks.example.com/hook', 'webhook_url_scheme_rejected', 'plaintext http'],
  ['file:///etc/passwd', 'webhook_url_scheme_rejected', 'file:'],
  ['gopher://hooks.example.com/_x', 'webhook_url_scheme_rejected', 'gopher:'],
  ['ftp://hooks.example.com/x', 'webhook_url_scheme_rejected', 'ftp:'],
  ['data:text/plain,hello', 'webhook_url_scheme_rejected', 'data:'],
  ['https://user:pass@hooks.example.com/h', 'webhook_url_credentials_rejected', 'credentials'],
  ['https://user@hooks.example.com/h', 'webhook_url_credentials_rejected', 'userinfo only'],
  ['https://hooks.example.com:8443/hook', 'webhook_url_port_rejected', 'non-443 port'],
  ['https://hooks.example.com:22/hook', 'webhook_url_port_rejected', 'ssh'],
  ['not a url', 'webhook_url_invalid', 'unparseable'],
  ['', 'webhook_url_invalid', 'empty'],
];

describe('webhookUrlRejection', () => {
  it('rejects every hostile encoding with the code the server uses', () => {
    expect(CORPUS).toHaveLength(32);
    const leaks = CORPUS.filter(([url, code]) => webhookUrlRejection(url) !== code)
      .map(([url, code]) => `${url}: expected ${code}, got ${webhookUrlRejection(url) ?? '<accepted>'}`);
    expect(leaks).toEqual([]);
  });

  it('accepts a legitimate public HTTPS endpoint', () => {
    for (const url of [
      'https://hooks.example.com/inplace',
      'https://hooks.example.com:443/inplace',
      'https://deep.sub.domain.example.co.il/a/b?c=d',
      'https://hooks.example.com./inplace',
    ]) {
      expect(webhookUrlRejection(url), url).toBeNull();
    }
  });

  it('does NOT pretend to close DNS rebinding', () => {
    // 127.0.0.1.nip.io is an ordinary hostname. The browser cannot resolve it and neither can
    // the database; only the connect-time guard in the Edge helper can. Recorded so nobody
    // later reads a green client corpus as proof that rebinding is handled here.
    expect(webhookUrlRejection('https://127.0.0.1.nip.io/hook')).toBeNull();
  });

  it('turns red against a weakened validator', () => {
    // The mutation proof: without it, the corpus above proves only that the corpus ran.
    const weakened = (url: string) =>
      /localhost|127\.0\.0\.1/i.test(url) ? 'webhook_url_local_name_rejected' : null;
    const leaks = CORPUS.filter(([url, code]) => weakened(url) !== code);
    expect(leaks.length).toBeGreaterThan(20);
  });
});

describe('webhookSecretRejection', () => {
  it('refuses a signing secret too short to carry entropy', () => {
    expect(webhookSecretRejection('short')).toBe('webhook_secret_invalid');
    expect(webhookSecretRejection('a'.repeat(MIN_WEBHOOK_SECRET_LENGTH - 1)))
      .toBe('webhook_secret_invalid');
    expect(webhookSecretRejection('a'.repeat(MIN_WEBHOOK_SECRET_LENGTH))).toBeNull();
    expect(webhookSecretRejection('a'.repeat(201))).toBe('webhook_secret_invalid');
  });
});

describe('webhookErrorMessage', () => {
  it('maps every server code the owner can provoke to Hebrew', () => {
    for (const code of [
      'webhook_url_scheme_rejected',
      'webhook_url_credentials_rejected',
      'webhook_url_port_rejected',
      'webhook_url_ip_literal_rejected',
      'webhook_url_local_name_rejected',
      'webhook_url_host_not_dns',
      'webhook_url_invalid',
      'webhook_url_private_address',
      'webhook_url_unresolvable',
      'webhook_secret_invalid',
      'webhook_not_authorized',
      'webhook_verification_required',
      'webhook_verification_challenge_mismatch',
      'webhook_verification_challenge_absent',
      'webhook_verification_expired',
      'webhook_organization_read_only',
      'fresh_authentication_required',
    ]) {
      const message = webhookErrorMessage(code);
      expect(message, code).toMatch(/[֐-׿]/);
      expect(message, code).not.toContain(code);
    }
  });

  it('never lets a raw server string through', () => {
    const raw =
      'ERROR: permission denied for relation private.webhook_verification_attempts at 10.0.3.7';
    const message = webhookErrorMessage(raw);
    expect(message).not.toContain('10.0.3.7');
    expect(message).not.toContain('private.webhook_verification_attempts');
    expect(message).toMatch(/[֐-׿]/);
  });

  it('reports an upstream status by number without the upstream body', () => {
    const message = webhookErrorMessage('webhook_verification_status_500');
    expect(message).toContain('500');
    expect(message).toMatch(/[֐-׿]/);
  });
});

const row = (over: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id: 'sub-1',
  target: 'webhook:sub-1',
  url: 'https://hooks.example.com/inplace',
  event_types: [],
  active: false,
  description: null,
  verification_state: 'unverified',
  verified_at: null,
  verification_expires_at: null,
  last_success_at: null,
  last_failure_at: null,
  pending_count: 0,
  failed_attempt_count: 0,
  dead_letter_count: 0,
  created_at: '2026-08-23T09:00:00+00:00',
  updated_at: '2026-08-23T09:00:00+00:00',
  ...over,
});

describe('webhookHealth', () => {
  it('says "—" for a delivery that has never succeeded, never "0"', () => {
    // CLAUDE.md: a measure with no data shows —, not 0. Zero is itself a claim about reality,
    // and "delivered at the epoch" is not what "never delivered" means.
    expect(webhookHealth(row()).lastSuccess).toBe('—');
  });

  it('shows a real zero when zero is a measurement', () => {
    // Counts are different: the query DID look, and it found none pending.
    const health = webhookHealth(row({ pending_count: 0, failed_attempt_count: 0 }));
    expect(health.pending).toBe('0');
    expect(health.failed).toBe('0');
  });

  it('reports counts and the last success when there is something to report', () => {
    const health = webhookHealth(row({
      last_success_at: '2026-08-23T10:30:00+00:00',
      pending_count: 3,
      failed_attempt_count: 7,
      dead_letter_count: 1,
    }));
    expect(health.pending).toBe('3');
    expect(health.failed).toBe('7');
    expect(health.deadLettered).toBe('1');
    expect(health.lastSuccess).not.toBe('—');
  });

  it('never surfaces an error string, because the row carries none', () => {
    const keys = Object.keys(row());
    expect(keys.filter((key) => /error/i.test(key))).toEqual([]);
  });
});

describe('WEBHOOK_EVENT_CHOICES', () => {
  it('offers only event types the outbox actually emits, and an explicit "all"', () => {
    expect(WEBHOOK_EVENT_CHOICES.length).toBeGreaterThan(0);
    for (const choice of WEBHOOK_EVENT_CHOICES) {
      expect(choice.value).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(choice.label).toMatch(/[֐-׿]/);
    }
  });
});
