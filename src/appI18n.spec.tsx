import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from './components/ui';
import { LocaleProvider } from './lib/i18n/LocaleProvider';

const authState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('./auth/AuthContext', () => ({
  useAuth: () => authState.current,
  homeFor: () => '/dashboard',
}));
vi.mock('./lib/observability', () => ({ reportError: vi.fn() }));

import App from './App';

function baseAuth() {
  return {
    session: { user: { id: 'user-1' } },
    profile: null,
    loading: false,
    bootstrapError: null,
    offlineBootstrap: false,
    isPlatformAdmin: false,
    signOut: vi.fn(async () => ({ error: null, pushWarning: null })),
    retryBootstrap: vi.fn(),
  };
}

function renderEnglish(path = '/private') {
  render(
    <LocaleProvider initialLocale="en">
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('App root-state language', () => {
  beforeEach(() => {
    authState.current = baseAuth();
  });

  it('renders an unavailable account in English', () => {
    renderEnglish();

    expect(screen.getByRole('heading', { name: 'The account is unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/account details could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps a raw bootstrap failure and renders its recovery action in English', () => {
    authState.current = { ...baseAuth(), bootstrapError: 'Temporary service error' };
    renderEnglish();

    expect(screen.getByRole('heading', { name: 'The account could not be loaded' })).toBeInTheDocument();
    expect(screen.getByText(/Temporary service error The connection remains active/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders the offline receiving boundary in English', () => {
    authState.current = { ...baseAuth(), offlineBootstrap: true };
    renderEnglish();

    expect(screen.getByRole('heading', { name: 'Offline work is limited to receiving goods' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to receiving' })).toHaveAttribute('href', '/receiving');
  });
});
