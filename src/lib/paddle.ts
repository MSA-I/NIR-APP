/**
 * Paddle.js, loaded once, on purpose, and only where it has been configured.
 *
 * WHAT THE BROWSER IS ALLOWED TO HOLD. Exactly one credential: the CLIENT-side token, which Paddle
 * publishes for this use and which can open a checkout for a transaction the SERVER already
 * created. It cannot read a customer, list a subscription, change a price or refund anything. The
 * server key (`pdl_sdbx_apikey_…` / `pdl_apikey_…`) never appears in this file, this bundle or any
 * variable this build can reach — `billing-checkout` holds it as an Edge Function secret and a
 * guard script fails the build if a Paddle API key shape ever reaches `src/`.
 *
 * THE ENVIRONMENT IS BUILD-TIME AND MUST BE SPELLED. `VITE_PADDLE_ENVIRONMENT` is substituted into
 * the bundle by Vite, exactly like `VITE_GOOGLE_SIGNUP_ENABLED`, and it has the same consequence:
 * a deploy that omits it ships a product with no purchase path at all rather than one that guesses.
 * Unset reads as "not switched on", never as a refusal and never as a default of either
 * environment — a typo silently choosing `live` would put real cards through a build nobody
 * intended to sell from, and silently choosing `sandbox` would take real customers' money nowhere.
 *
 * AND IT IS NOT THE PERMISSION. Being configured here only means the browser CAN draw a button.
 * Whether a purchase may happen is decided server-side by `authorize_billing_checkout()` against
 * the merchant-of-record boundary, which is shut in production today. This module never asks
 * whether billing is available; the panel reads that from `my_subscription()`.
 */

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/** The narrow slice of Paddle.js this product uses. Anything wider would invite a wider use. */
interface PaddleGlobal {
  Environment: { set(environment: string): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: {
    open(options: { transactionId: string; settings?: Record<string, unknown> }): void;
    close?(): void;
  };
}

export interface PaddleEvent {
  name: string;
  data?: unknown;
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

export type PaddleEnvironment = 'sandbox' | 'live';

export interface PaddleConfig {
  token: string;
  environment: PaddleEnvironment;
}

/**
 * The configuration, or null. Null is the honest and common answer: it is what every build without
 * the two variables produces, and what production produces today.
 */
export function paddleConfig(): PaddleConfig | null {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN;
  const environment = import.meta.env.VITE_PADDLE_ENVIRONMENT;
  if (typeof token !== 'string' || token.trim().length === 0) return null;
  if (environment !== 'sandbox' && environment !== 'live') return null;
  // A client token is `test_…` in sandbox and `live_…` in live. Refusing a mismatched pair here
  // turns a misconfigured deploy into no button, rather than into a checkout that opens against
  // the wrong account and fails in front of a customer with their card details on screen.
  const expectedPrefix = environment === 'sandbox' ? 'test_' : 'live_';
  if (!token.startsWith(expectedPrefix)) return null;
  return { token: token.trim(), environment };
}

let loading: Promise<PaddleGlobal | null> | null = null;

/**
 * Loads and initializes Paddle.js once per document. Repeated calls share the one promise, because
 * initializing twice re-registers the event callback and a checkout would then be reported twice.
 */
export function loadPaddle(
  onEvent?: (event: PaddleEvent) => void,
): Promise<PaddleGlobal | null> {
  if (loading) return loading;

  const config = paddleConfig();
  if (config === null) return Promise.resolve(null);

  loading = new Promise<PaddleGlobal | null>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PADDLE_JS}"]`);
    const script = existing ?? document.createElement('script');

    const start = () => {
      const paddle = window.Paddle;
      if (!paddle) {
        resolve(null);
        return;
      }
      try {
        // Order matters to Paddle.js: the environment is chosen before Initialize reads the token.
        paddle.Environment.set(config.environment);
        paddle.Initialize({ token: config.token, eventCallback: onEvent });
        resolve(paddle);
      } catch {
        // A failure here means no purchase path, which the panel renders as such. It must never
        // mean a half-initialized Paddle that opens a checkout against the wrong account.
        resolve(null);
      }
    };

    if (existing && window.Paddle) {
      start();
      return;
    }
    script.addEventListener('load', start, { once: true });
    script.addEventListener('error', () => resolve(null), { once: true });
    if (!existing) {
      script.src = PADDLE_JS;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return loading;
}

/**
 * Opens the overlay for a transaction the SERVER created.
 *
 * `transactionId` is the only thing passed, and that is the whole security property: the price,
 * the amount, the customer and the tenant were all decided by `billing-checkout` before this id
 * existed. Paddle.js is never handed a price id or an amount, so there is nothing here for a
 * tampered client to change into a different purchase.
 */
export async function openPaddleCheckout(
  transactionId: string,
  onEvent?: (event: PaddleEvent) => void,
): Promise<boolean> {
  const paddle = await loadPaddle(onEvent);
  if (!paddle) return false;
  paddle.Checkout.open({ transactionId });
  return true;
}

/** Test seam: forget the cached load so a suite can exercise the first-load path more than once. */
export function resetPaddleForTests(): void {
  loading = null;
}
