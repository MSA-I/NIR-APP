import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import PurgeCandidates from './PurgeCandidates';
import type { PlatformCapability, PurgeBatch, PurgeCandidate } from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchPurgeCandidates = vi.fn<() => Promise<PurgeCandidate[]>>();
const fetchPurgeBatches = vi.fn<() => Promise<PurgeBatch[]>>();

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchPurgeCandidates: () => fetchPurgeCandidates(),
  fetchPurgeBatches: () => fetchPurgeBatches(),
}));

const row = (over: Partial<PurgeCandidate> = {}): PurgeCandidate => ({
  org_id: '75000000-0000-4000-8000-000000000031',
  organization_name: 'ארגון שסיים שירות',
  offboarding_request_id: '77000000-0000-4000-8000-000000000031',
  requested_at: '2018-06-01T08:00:00.000Z',
  retention_eligible: true,
  legal_hold_clear: true,
  export_ready: true,
  backup_present: true,
  eligible: true,
  ...over,
});

// PageHeader reads the location to resolve its route description, so the screen needs a router.
const renderScreen = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter initialEntries={['/admin/purge']}>
      <ToastProvider><PurgeCandidates /></ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  fetchMyCapabilities.mockResolvedValue(['offboarding.handle']);
  fetchPurgeCandidates.mockResolvedValue([row()]);
  fetchPurgeBatches.mockResolvedValue([]);
});

describe('מסך המחיקה הסופית', () => {
  it('מבדילה בין «אין הרשאה» ל«אין מועמדים»', async () => {
    fetchMyCapabilities.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/הרשאת טיפול בסיום שירות/)).toBeInTheDocument();
  });

  it('מציגה את ארבעת השערים בנפרד, לא סימן «כשיר» אחד', async () => {
    // #261 E1. An operator approving an irreversible deletion has to see WHICH gate is open.
    // Collapsing four independent gates into one tick is how a dropped gate becomes invisible.
    renderScreen();
    await screen.findByText('ארגון שסיים שירות');
    for (const label of ['תקופת שמירה', 'ללא עיכוב משפטי', 'ייצוא מוכן', 'גיבוי ושחזור']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('אינה מאפשרת לצרף לאצווה ארגון שנכשל בשער כלשהו', async () => {
    fetchPurgeCandidates.mockResolvedValue([
      row({
        org_id: '75000000-0000-4000-8000-000000000034',
        organization_name: 'ארגון עם עיכוב משפטי',
        legal_hold_clear: false,
        eligible: false,
      }),
    ]);
    renderScreen();

    const box = await screen.findByRole('checkbox', { name: /ארגון עם עיכוב משפטי/ });
    expect(box).toBeDisabled();
  });

  it('אומרת במפורש שהאישור אינו מוחק, ואינה מציעה כפתור ביצוע', async () => {
    // The executor is a separate command reachable only by a platform admin with a fresh
    // password. A "run now" button here would be the whole point of #261 undone.
    renderScreen();
    await screen.findByText('ארגון שסיים שירות');
    expect(screen.getByText(/אישור אצווה אינו מוחק דבר/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ביצוע המחיקה/ })).not.toBeInTheDocument();
  });
});
