import { describe, expect, it } from 'vitest';
import {
  summarizeConnection,
  toConnectionView,
  WHATSAPP_CONNECTION_STATUS_KEY,
  WHATSAPP_PROVIDER_LABEL,
} from './whatsappConnection';
import libSource from './whatsappConnection.ts?raw';
import { translateIn } from './i18n/LocaleProvider';

const tHe = (key: Parameters<typeof translateIn>[1], vars?: Record<string, string | number>) =>
  translateIn('he', key, vars);

describe('summarizeConnection', () => {
  it('says nothing it does not know: an unconfigured tenant shows — and never 0', () => {
    const summary = summarizeConnection(null, tHe);
    expect(summary.configured).toBe(false);
    expect(summary.providerLabel).toBe('—');
    expect(summary.maskedSender).toBe('—');
    expect(summary.credentialLabel).toBe('—');
    expect(summary.languageLabel).toBe('—');
    expect(summary.statusLabel).toBe('לא מחובר');
  });

  it('a configured but not-yet-enabled channel cannot carry an order', () => {
    const summary = summarizeConnection(toConnectionView({
      configured: true, provider: 'twilio', status: 'pending',
      masked_sender: '••••0001', credential_configured: true, language_code: 'he',
    }), tHe);
    expect(summary.providerDeliveryAvailable).toBe(false);
    expect(summary.statusLabel).toBe(tHe(WHATSAPP_CONNECTION_STATUS_KEY.pending));
    expect(summary.providerLabel).toBe(WHATSAPP_PROVIDER_LABEL.twilio);
  });

  it('an active channel with a stored credential is the only state that carries an order', () => {
    const summary = summarizeConnection(toConnectionView({
      configured: true, provider: 'twilio', status: 'active',
      masked_sender: '••••0001', credential_configured: true, language_code: 'he',
    }), tHe);
    expect(summary.providerDeliveryAvailable).toBe(true);
    expect(summary.credentialLabel).toBe('שמור בכספת, אינו ניתן לצפייה');
    expect(summary.languageLabel).toBe('עברית');
  });

  it('an active channel whose credential is gone does NOT claim provider delivery', () => {
    const summary = summarizeConnection(toConnectionView({
      configured: true, provider: 'twilio', status: 'active',
      masked_sender: '••••0001', credential_configured: false, language_code: 'he',
    }), tHe);
    expect(summary.providerDeliveryAvailable).toBe(false);
    expect(summary.credentialLabel).toBe('—');
  });

  it('a disabled or errored channel is never presented as able to deliver', () => {
    for (const status of ['disabled', 'error'] as const) {
      const summary = summarizeConnection(toConnectionView({
        configured: true, provider: 'twilio', status,
        masked_sender: '••••0001', credential_configured: true, language_code: 'he',
      }), tHe);
      expect(summary.providerDeliveryAvailable).toBe(false);
      expect(summary.statusLabel).toBe(tHe(WHATSAPP_CONNECTION_STATUS_KEY[status]));
    }
  });

  it('the manual share stays available in every state -- it is a separate channel', () => {
    expect(summarizeConnection(null, tHe).manualShareAvailable).toBe(true);
    expect(summarizeConnection(toConnectionView({
      configured: true, provider: 'twilio', status: 'active',
      masked_sender: '••••0001', credential_configured: true, language_code: 'he',
    }), tHe).manualShareAvailable).toBe(true);
  });
});

describe('toConnectionView', () => {
  it('a missing field is null, never a fabricated default', () => {
    const view = toConnectionView({});
    expect(view.configured).toBe(false);
    expect(view.provider).toBeNull();
    expect(view.status).toBeNull();
    expect(view.maskedSender).toBeNull();
    expect(view.credentialConfigured).toBe(false);
  });

  it('only the masked sender crosses the boundary -- there is no unmasked field to read', () => {
    const view = toConnectionView({
      configured: true, provider: 'twilio', status: 'active', masked_sender: '••••0001',
    });
    expect(view.maskedSender).toBe('••••0001');
    expect(Object.keys(view)).not.toContain('providerSenderId');
    expect(Object.keys(view)).not.toContain('displayPhoneNumber');
  });
});

describe('the tenant surface never handles a credential it could leak', () => {
  it('no reader in this module asks the server for a credential or a Vault reference', () => {
    // The credential travels one way only: into configure_whatsapp_provider_connection. Nothing
    // here reads one back, and no server surface offers one to a browser role.
    expect(libSource).not.toMatch(/token_secret_id/);
    expect(libSource).not.toMatch(/decrypted_secret/);
    expect(libSource).not.toMatch(/service_get_whatsapp_provider_connection/);
    // The write path exists exactly once, and it is the owner-only, stepped-up command.
    expect(libSource.match(/p_credential/g) ?? []).toHaveLength(1);
  });

  it('every state-changing call carries a reason, because the server records one', () => {
    for (const rpc of [
      'configure_whatsapp_provider_connection',
      'set_whatsapp_provider_connection_enabled',
      'revoke_whatsapp_provider_connection',
    ]) {
      // The CALL site, not the prose about it.
      const index = libSource.indexOf(`rpc('${rpc}'`);
      expect(index, `${rpc} is not called anywhere in this module`).toBeGreaterThan(-1);
      expect(libSource.slice(index, index + 700)).toMatch(/p_reason/);
    }
  });
});
