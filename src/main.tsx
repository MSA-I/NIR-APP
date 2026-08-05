import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import App from './App';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui';
import { initObservability } from './lib/observability';
import { createAppQueryClient } from './lib/query/client';

// Before anything renders, so a crash during the first paint is still reported.
initObservability();

// Web Push delivery target only — public/sw.js does no offline caching (financial
// data must stay live). Registration failure is not an app failure: the UI works
// identically without it, so errors are swallowed on purpose.
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
        <div className="font-medium">גרסה חדשה מוכנה</div>
        <div className="mt-0.5 text-xs">שמור עבודה פתוחה ורענן בזמן שנוח לך.</div>
      </div>
      <button type="button" className="btn-secondary shrink-0" onClick={() => window.location.reload()}>רענון</button>
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
        <AuthProvider>
          <ToastProvider bottomNotice={<ServiceWorkerUpdateNotice />}>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
