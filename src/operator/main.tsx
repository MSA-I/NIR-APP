import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import '../index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../auth/AuthContext';
import { ToastProvider } from '../components/ui';
import { initObservability } from '../lib/observability';
import { createAppQueryClient } from '../lib/query/client';
import OperatorRoutes from './OperatorRoutes';

// Same observability as the tenant entry — a crash in the operator console is still a crash.
initObservability();

// Deliberately NO service-worker registration here. src/main.tsx is the single registration
// site, and public/sw.js additionally refuses to answer /operator navigations from the tenant
// shell cache, so the console can never be served the customer application while offline.
// The operator console is online-only: it administers tenants, it does not receive goods in a
// basement with no reception.

// HashRouter, not BrowserRouter: this entry is one static file (operator.html) served at
// /operator. Path-based sub-routes (/operator/anything) would need server rewrites in every
// environment — vite dev, vite preview and Cloudflare Pages, whose _redirects catch-all
// belongs to the tenant SPA. Hash routes need none of that.
const queryClient = createAppQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthProvider>
          <ToastProvider>
            <OperatorRoutes />
          </ToastProvider>
        </AuthProvider>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
