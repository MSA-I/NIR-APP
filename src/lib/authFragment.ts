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
 * STILL HERE UNDER PKCE, AND THAT IS THE POINT. `supabase.ts` now creates the client with
 * `flowType: 'pkce'` and every e-mail link goes through `/auth/confirm?token_hash=…`, so nothing
 * we send produces a token fragment any more. What we do not control is what is already in a
 * mailbox: a link minted before the templates changed still lands implicit, and so does an OAuth
 * provider configured to answer that way. This is the fallback for those, not the main road.
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
