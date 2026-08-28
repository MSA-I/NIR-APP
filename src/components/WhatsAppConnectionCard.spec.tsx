import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from './ui';
import type { WhatsAppConnectionView } from '../lib/whatsappConnection';

/**
 * The connection card's contract. The server is the boundary -- owner, a fresh password and a
 * reason are enforced by the RPCs themselves (p73 proves that) -- so these assertions are about
 * what the SCREEN does: it never renders a credential, it never renders an unmasked sender, it
 * never lets a state change leave without a reason and a step-up, and it never lets a manual
 * share read as provider delivery.
 */
const calls = vi.hoisted(() => ({
  configure: [] as unknown[],
  enable: [] as unknown[],
  revoke: [] as unknown[],
  view: null as WhatsAppConnectionView | null,
}));

vi.mock('../lib/whatsappConnection', async () => {
  const actual = await vi.importActual<typeof import('../lib/whatsappConnection')>(
    '../lib/whatsappConnection',
  );
  return {
    ...actual,
    fetchWhatsAppConnection: async () => calls.view,
    configureWhatsAppConnection: async (input: unknown) => { calls.configure.push(input); return calls.view; },
    setWhatsAppConnectionEnabled: async (enabled: boolean, reason: string) => {
      calls.enable.push({ enabled, reason });
      return calls.view;
    },
    revokeWhatsAppConnection: async (reason: string) => { calls.revoke.push({ reason }); return calls.view; },
  };
});

/** The step-up dialog is exercised for real in ReauthModal.spec; here it is reduced to the one
 * property this screen depends on -- that a sensitive action cannot run without passing it. */
const stepUp = vi.hoisted(() => ({ shown: 0 }));
vi.mock('./ReauthModal', () => ({
  ReauthModal: ({ open, onConfirm }: { open: boolean; onConfirm: (session: unknown) => void }) => {
    if (!open) return null;
    stepUp.shown += 1;
    return (
      <button type="button" onClick={() => onConfirm({})}>אישור זהות</button>
    );
  },
}));

import { WhatsAppConnectionCard } from './WhatsAppConnectionCard';
import cardSource from './WhatsAppConnectionCard.tsx?raw';

const ACTIVE: WhatsAppConnectionView = {
  configured: true,
  provider: 'twilio',
  status: 'active',
  maskedSender: '••••0001',
  credentialConfigured: true,
  orderTemplateName: 'HXorder',
  reminderTemplateName: 'HXreminder',
  languageCode: 'he',
  configuredAt: '2026-08-23T00:00:00Z',
};

function renderCard(role: string | null) {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider><WhatsAppConnectionCard role={role} /></ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.configure.length = 0;
  calls.enable.length = 0;
  calls.revoke.length = 0;
  calls.view = null;
  stepUp.shown = 0;
});

describe('WhatsAppConnectionCard', () => {
  it('an unconfigured tenant sees — for every unknown field, never a zero', async () => {
    renderCard('owner');
    expect(await screen.findByText('לא מחובר')).toBeInTheDocument();
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says plainly that there is no automatic delivery, and that manual share is separate', async () => {
    renderCard('owner');
    expect(await screen.findByText(/אין כרגע מסירה אוטומטית ב-WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/שיתוף ידני הוא ערוץ נפרד/)).toBeInTheDocument();
  });

  it('states that inbound messages are not received at launch (#241)', async () => {
    calls.view = ACTIVE;
    renderCard('owner');
    expect(await screen.findByText(/הודעות נכנסות אינן נקלטות בהשקה/)).toBeInTheDocument();
  });

  it('shows provider, masked sender and status -- and no credential anywhere', async () => {
    calls.view = ACTIVE;
    renderCard('owner');
    expect(await screen.findByText('Twilio')).toBeInTheDocument();
    expect(screen.getByText('••••0001')).toBeInTheDocument();
    expect(screen.getByText('פעיל')).toBeInTheDocument();
    expect(screen.getByText('שמור בכספת, אינו ניתן לצפייה')).toBeInTheDocument();
    // Nothing resembling a raw sender or a secret reference is on the screen.
    expect(screen.queryByText(/whatsapp:\+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/972500000001/)).not.toBeInTheDocument();
  });

  it('a non-owner sees the state but is offered no connect, enable or revoke control', async () => {
    calls.view = ACTIVE;
    renderCard('office');
    expect(await screen.findByText('Twilio')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /חיבור מספר הארגון|החלפת חיבור/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /הפעלת הערוץ|השבתת הערוץ/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ביטול החיבור/ })).not.toBeInTheDocument();
  });

  it('refuses to disable without a reason, and never reaches the server', async () => {
    calls.view = ACTIVE;
    const user = userEvent.setup();
    renderCard('owner');
    await user.click(await screen.findByRole('button', { name: /השבתת הערוץ/ }));
    expect(await screen.findByText(/יש לנמק את הפעולה/)).toBeInTheDocument();
    expect(stepUp.shown).toBe(0);
    expect(calls.enable).toEqual([]);
  });

  it('disabling requires the step-up first, then sends the reason the audit will store', async () => {
    calls.view = ACTIVE;
    const user = userEvent.setup();
    renderCard('owner');
    await user.type(await screen.findByLabelText(/סיבת הפעולה/), 'הספק ביקש להפסיק');
    await user.click(screen.getByRole('button', { name: /השבתת הערוץ/ }));
    // Nothing has been sent yet: the identity has not been proven.
    expect(calls.enable).toEqual([]);
    expect(stepUp.shown).toBe(1);
    await user.click(screen.getByRole('button', { name: 'אישור זהות' }));
    await waitFor(() => expect(calls.enable).toEqual([{ enabled: false, reason: 'הספק ביקש להפסיק' }]));
  });

  it('revoking requires the step-up and a reason, and says the secret is deleted', async () => {
    calls.view = ACTIVE;
    const user = userEvent.setup();
    renderCard('owner');
    await user.type(await screen.findByLabelText(/סיבת הפעולה/), 'סיום התקשרות');
    await user.click(screen.getByRole('button', { name: /ביטול החיבור ומחיקת הסוד/ }));
    expect(calls.revoke).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'אישור זהות' }));
    await waitFor(() => expect(calls.revoke).toEqual([{ reason: 'סיום התקשרות' }]));
  });

  it('the connection wizard sends the credential once, behind a step-up, with a reason', async () => {
    const user = userEvent.setup();
    renderCard('owner');
    await user.click(await screen.findByRole('button', { name: /חיבור מספר הארגון/ }));
    fireEvent.change(screen.getByLabelText('מזהה החשבון אצל הספק'), { target: { value: 'ACtest' } });
    fireEvent.change(screen.getByLabelText('כתובת השולח בערוץ'), { target: { value: 'whatsapp:+972500000001' } });
    fireEvent.change(screen.getByLabelText('מספר לתצוגה'), { target: { value: '+972500000001' } });
    fireEvent.change(screen.getByLabelText('סוד הגישה של הארגון'), { target: { value: 'a-tenant-credential' } });
    fireEvent.change(screen.getByLabelText('מזהה תבנית הזמנה'), { target: { value: 'HXorder' } });
    fireEvent.change(screen.getByLabelText('מזהה תבנית תזכורת'), { target: { value: 'HXreminder' } });
    fireEvent.change(screen.getByLabelText(/סיבת החיבור/), { target: { value: 'חיבור ראשוני' } });
    await user.click(screen.getByRole('button', { name: 'שמירת החיבור' }));
    expect(calls.configure).toEqual([]);
    expect(stepUp.shown).toBe(1);
    await user.click(screen.getByRole('button', { name: 'אישור זהות' }));
    await waitFor(() => expect(calls.configure).toHaveLength(1));
    expect(calls.configure[0]).toMatchObject({
      provider: 'twilio',
      providerAccountId: 'ACtest',
      providerSenderId: 'whatsapp:+972500000001',
      credential: 'a-tenant-credential',
      reason: 'חיבור ראשוני',
    });
  });

  it('the credential field is a password input and is never persisted in the component text', () => {
    // A masked input is the minimum; the assertion that matters is that the component has no
    // reader for a stored credential at all -- there is nothing to render.
    expect(cardSource).toMatch(/id="whatsapp-credential"[\s\S]{0,200}type="password"/);
    expect(cardSource).not.toMatch(/token_secret_id/);
    expect(cardSource).not.toMatch(/decrypted/);
  });

  it('uses logical CSS properties only -- never left/right (RTL constitution)', () => {
    expect(cardSource).not.toMatch(/className="[^"]*\b(?:ml|mr|pl|pr|left|right)-[0-9]/);
    expect(cardSource).not.toMatch(/\btext-(?:left|right)\b/);
  });
});
