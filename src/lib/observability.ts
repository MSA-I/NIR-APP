import * as Sentry from '@sentry/react';

// Error reporting is opt-in per deployment: with no VITE_SENTRY_DSN the SDK is never initialised
// and the app behaves exactly as it did before, which keeps development and any self-hosted
// deployment free of an external dependency they did not ask for.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

export const observabilityEnabled = Boolean(dsn);

export function initObservability(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    // Set at build time by the deploy so a stack trace can be tied to the exact bundle.
    release: import.meta.env.VITE_RELEASE as string | undefined,
    environment: import.meta.env.MODE,
    // Errors only. This app carries suppliers' invoices and bank statements, so nothing that
    // records screens or request bodies is enabled: no performance traces, no session replay.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeBreadcrumb: (breadcrumb) => {
      // toHebrewError console.errors the raw server message, which can name a supplier or carry
      // an amount. Useful locally, not something to ship to a third party.
      if (breadcrumb.category === 'console') return null;
      return breadcrumb;
    },
  });
}

/** Reports a caught error. A no-op when reporting is disabled, so callers need no guard. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (!dsn) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
