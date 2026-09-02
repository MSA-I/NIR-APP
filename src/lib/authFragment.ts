/**
 * What an auth redirect leaves in the address bar, and whether it must be scrubbed.
 *
 * GoTrue's implicit redirect — Google sign-in, an invitation, a recovery link — lands as
 * `#access_token=…&refresh_token=…` (or `#error_code=…` for a dead link). auth-js reads that
 * fragment synchronously while the client is created and clears it with `location.hash = ''` only
 * AFTER its network round-trip succeeds: a failed exchange leaves the tokens in the address bar,
 * and a hash assignment is a navigation, so even the happy path leaves the token-bearing URL one
 * Back-press away in history. `src/lib/supabase.ts` scrubs it with replaceState the moment the
 * client exists and keeps the parsed fragment for the pages that need it (ResetPassword reads
 * error_code and access_token). Pure functions here so the rule has a test.
 *
 * Not PKCE, deliberately: a PKCE code verifier lives in the browser that started the flow, so a
 * recovery mail opened on a phone would fail to exchange, and ResetPassword's link states are built
 * on the fragment. Moving to PKCE needs the token-hash e-mail templates first (security plan, step 7).
 */
const AUTH_CALLBACK_KEYS = ['access_token', 'refresh_token', 'error', 'error_code', 'error_description'];

/** The fragment as GoTrue wrote it, without the leading `#`. Never throws. */
export function readAuthFragment(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ''));
}

/** True when the fragment is an auth callback — tokens or an auth error — and must not stay in the URL. */
export function carriesAuthCallback(fragment: URLSearchParams): boolean {
  return AUTH_CALLBACK_KEYS.some((key) => fragment.has(key));
}
