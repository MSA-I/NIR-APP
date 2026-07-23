import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider bottomNotice={<ServiceWorkerUpdateNotice />}>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
