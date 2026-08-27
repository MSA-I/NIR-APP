import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMAIL_MESSAGE_STATUS, COMMUNICATION_CHANNEL } from './status';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

// The honesty rules of provider-backed delivery (0168), pinned as source contracts: the client
// never stamps `sent` (only the settle RPC does, on the observed provider event), statuses are
// rendered as stored with no optimistic collapse, and the send path goes through the Edge
// Function — never a direct provider call or a direct table write from the browser.
describe('email order delivery boundary', () => {
  const clientFiles = ['src/lib/orderEmail.ts', 'src/components/EmailOrderCard.tsx',
    'src/components/SupplierCommunicationCard.tsx'];

  it('the browser never transitions the order around the provider event', () => {
    for (const file of clientFiles) {
      const value = source(file);
      expect(value, file).not.toContain('transition_purchase_order_status');
      expect(value, file).not.toContain('markOrderSentToSupplier');
    }
  });

  it('the browser never talks to the provider or writes the ledger directly', () => {
    for (const file of clientFiles) {
      const value = source(file);
      expect(value, file).not.toContain('api.resend.com');
      expect(value, file).not.toMatch(/from\('email_order_messages'\)\s*\.\s*(insert|update|delete)/);
    }
    expect(source('src/lib/orderEmail.ts')).toContain("functions.invoke('email-sender'");
  });

  it('every stored status has a Hebrew label, and provider-accepted is not "delivered"', () => {
    for (const status of ['queued', 'sending', 'unknown', 'accepted', 'delivered', 'bounced', 'failed']) {
      expect(EMAIL_MESSAGE_STATUS[status], status).toBeDefined();
    }
    expect(EMAIL_MESSAGE_STATUS.accepted.key).not.toBe(EMAIL_MESSAGE_STATUS.delivered.key);
    // `read` is deliberately absent: the provider cannot honestly claim it for email.
    expect(EMAIL_MESSAGE_STATUS.read).toBeUndefined();
  });

  it('the channel vocabulary is fail-closed: manual is the default and a real state', () => {
    expect(COMMUNICATION_CHANNEL.manual).toBeDefined();
    expect(source('supabase/migrations/0168_supplier_order_email_delivery.sql'))
      .toContain("default 'manual'");
  });

  it('the sender Edge renders versioned templates and stamps the version on the ledger', () => {
    const sender = source('supabase/functions/email-sender/index.ts');
    expect(sender).toContain('renderOrderEmail');
    expect(sender).toContain("kind: 'supplier_order_email'");
    expect(sender).toContain('Idempotency-Key');
    const migration = source('supabase/migrations/0168_supplier_order_email_delivery.sql');
    expect(migration).toContain('template_version');
  });
});
