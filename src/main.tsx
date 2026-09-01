import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthContext';
import { LocaleProvider, useT } from './lib/i18n/LocaleProvider';
import { ProfilePreferencesSync } from './lib/profilePreferences';
import { ToastProvider } from './components/ui';
import { initObservability } from './lib/observability';
import { createAppQueryClient } from './lib/query/client';

// Before anything renders, so a crash during the first paint is still reported.
initObservability();

// Web Push delivery + app-shell cache (#101, closed 09.08.2026) — public/sw.js precaches
// the static shell so an offline reload still brings the app up, and NEVER caches API
// responses (financial data stays live). Registration failure is not an app failure: the
// UI works identically without it, so errors are swallowed on purpose.
if ('serviceWorker' in navigator) {
  let controlled = !!navigator.serviceWorker.controller;
  let updateAnnounced = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first controller on a fresh install is not an update. Every later takeover is
    // announced once; the user chooses when to refresh, so an unsaved form is never erased.
    if (!controlled) { controlled = true; return; }
    if (updateAnnounced) return;
    updateAnnounced = true;
    window.dispatchEvent(new Event('supplyflow:service-worker-updated'));
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* push simply unavailable */ });
  });
}

function ServiceWorkerUpdateNotice() {
  // Safe: this element is handed to `ToastProvider`, which sits INSIDE `LocaleProvider`, so the
  // hook runs where a language exists. The element is only CREATED at module scope.
  const { t } = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const show = () => setReady(true);
    window.addEventListener('supplyflow:service-worker-updated', show);
    return () => window.removeEventListener('supplyflow:service-worker-updated', show);
  }, []);
  if (!ready) return null;
  return (
    <div role="status" className="phone-update-notice note-info pointer-events-auto">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t('appUpdate.title')}</div>
        <div className="mt-0.5 text-xs">{t('appUpdate.body')}</div>
      </div>
      <button type="button" className="btn-secondary shrink-0" onClick={() => window.location.reload()}>{t('appUpdate.refresh')}</button>
    </div>
  );
}

// One client for the process. Outside AuthProvider on purpose: the provider must already exist
// when AuthProvider mounts, and the client itself holds no tenant state — the tenant lives in
// every key's first segment, so a user switch is one subtree invalidation, not a new client.
const queryClient = createAppQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Outside AuthProvider on purpose: /login renders before there is a profile to ask, so
            the language and the direction have to be settled before auth resolves. A signed-in
            person's saved choice arrives afterwards through ProfileLocaleSync. */}
        <LocaleProvider>
          <AuthProvider>
            {/* INSIDE ToastProvider, not beside it (31.08.2026). This component owns both halves of
                BOTH preference bridges — language and appearance: adopting what the account holds,
                and binding the write queues the controls share. The second half reports a failed save, so it
                needs `useToast` — and a toast provider it is not a descendant of cannot be asked.
                Nothing was lost by moving it: it renders null, and effects run child-first either
                way. */}
            <ToastProvider bottomNotice={<ServiceWorkerUpdateNotice />}>
              <ProfilePreferencesSync />
              <App />
            </ToastProvider>
          </AuthProvider>
        </LocaleProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
