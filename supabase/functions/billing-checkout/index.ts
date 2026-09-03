// billing-checkout -- starting a payment, and managing one that already exists.
//
// This file is wiring and nothing else; ./core.ts holds the whole decision and is where every test
// points. The split is the billing-webhook precedent and it earns its keep the same way: the rules
// that matter here are orderings, and an ordering is only provable if it is not tangled with
// Deno.serve, a database client and a network.
//
// verify_jwt = TRUE, and the contrast with billing-webhook is the point. That function has no user
// and its credential IS the provider's signature. This one is invoked BY a signed-in owner, and
// every authorization decision it makes is made by the database while running as that person --
// `authorize_billing_checkout()` and `authorize_billing_management()` read auth_org() and take no
// organization argument, so the caller cannot aim either of them at another tenant.
//
// WHAT IT CANNOT DO, STRUCTURALLY. It holds a service-role client, so it is worth being explicit
// about what that client is used for: exactly two things, `service_link_billing_customer` and
// reading the caller's own email. It never writes a plan, a status, a period or an entitlement.
// Those follow a signed provider event through billing-webhook and nothing else (#217), and 0278's
// anchor fails the migration if either checkout function grows a plan write.
//
// AND IT REFUSES WHILE THE MERCHANT OF RECORD IS SHUT. Not as politeness -- as the guard that stops
// a customer paying for something the platform will not grant them. 0187 seeds every provider
// disabled and nothing can enable one at run time, so in production this function refuses every
// caller today, whatever secrets are set. Deploying it is not billing activation.
//
// Required environment (supabase secrets set ...):
//   BILLING_PROVIDER     -- which provider this deployment serves; 'paddle'
//   PADDLE_API_KEY       -- the SERVER-side Paddle key. Never prefixed VITE_, never in a bundle.
//   PADDLE_ENVIRONMENT   -- 'sandbox' or 'live'. Must be spelled; a typo refuses rather than guesses.
//   PADDLE_WEBHOOK_SECRET -- resolves the adapter; this function never verifies a signature.
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import { billingAdapterFor } from '../_shared/billing-adapter.ts';
import { withAllowedOrigin } from '../_shared/cors.ts';
import { CORS_HEADERS, type CheckoutAuthorization, type CheckoutPorts, handleCheckout } from './core.ts';

/**
 * Exported so the wiring above the handler -- the preflight, the environment refusal and the
 * unauthenticated refusal -- is provable without a listener. `assistant/index.ts` is the
 * precedent: the handler is a value, and `Deno.serve` runs only when this file is the program.
 */
export const handler = withAllowedOrigin((incoming: Request): Response | Promise<Response> => {
  // FIRST — before the environment read below and before the Authorization check under it.
  // A CORS preflight is an OPTIONS request that carries no Authorization header by definition,
  // so the `unauthenticated` refusal answered every preflight 401 with no CORS headers, and the
  // browser never sent the POST behind it. The order is the fix; same shape as
  // assistant/index.ts, which has always answered OPTIONS on its first line.
  if (incoming.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'refused' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // No Authorization header, no caller, no organization. There is no anonymous path into this
  // function: everything below authorizes as a person, and an absent person authorizes as nobody.
  const authorization = incoming.headers.get('Authorization');
  if (!authorization) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const provider = Deno.env.get('BILLING_PROVIDER') ?? 'paddle';
  const resolved = billingAdapterFor(provider, (name) => Deno.env.get(name));

  // AS THE CALLER. This client carries the user's own JWT, so auth_org() inside the authorization
  // functions is theirs and RLS applies to everything it touches. It is not a convenience -- it is
  // why a request body cannot choose a tenant.
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const authorizationOf = async (
    rpc: string,
    args: Record<string, unknown>,
  ): Promise<CheckoutAuthorization | null> => {
    const { data, error } = await caller.rpc(rpc, args);
    if (error) {
      console.error('billing-checkout authorization failed', rpc, error.code);
      return null;
    }
    return (data ?? null) as CheckoutAuthorization | null;
  };

  const ports: CheckoutPorts = {
    adapter: resolved.ok ? resolved.value : null,
    adapterRefusal: resolved.ok ? undefined : { code: resolved.code, detail: resolved.detail },

    authorizeCheckout: (planKey, interval) => authorizationOf('authorize_billing_checkout', {
      p_plan_key: planKey,
      p_billing_interval: interval,
    }),

    authorizeManagement: () => authorizationOf('authorize_billing_management', {}),

    // The signed-in person's own address, read from their own token rather than from the request.
    // A caller-supplied email would let somebody file another person's payments under an address
    // they control, and Paddle uniques customers on exactly that field.
    callerEmail: async () => {
      const identity = await caller.auth.getUser();
      if (identity.error || !identity.data.user?.email) {
        console.error('billing-checkout could not read the caller identity');
        return null;
      }
      return identity.data.user.email;
    },

    // The one privileged write this function makes: the address every later signed event is
    // attributed through (0157/0278). Not an entitlement.
    linkCustomer: async (orgId, providerName, customerId) => {
      const { error } = await admin.rpc('service_link_billing_customer', {
        p_org_id: orgId,
        p_provider: providerName,
        p_provider_customer_id: customerId,
      });
      if (error) {
        console.error('billing-checkout link failed', error.code);
        return { ok: false, detail: error.code ?? 'link_failed' };
      }
      return { ok: true };
    },
  };

  return handleCheckout(incoming, ports);
});

if (import.meta.main) {
  Deno.serve(handler);
}
