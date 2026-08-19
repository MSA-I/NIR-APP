import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import PortalApp from './PortalApp';

// The supplier portal entry is deliberately minimal: no AuthProvider, no Supabase client, no
// router, no react-query and no service-worker registration. A supplier holds a bearer token
// for ONE order; loading any tenant surface here would widen exactly the boundary the token
// model narrows. public/sw.js additionally refuses to answer /portal navigations from the
// tenant shell cache, and vite.config.ts keeps portal.html out of the precache manifest.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PortalApp />
  </StrictMode>,
);
