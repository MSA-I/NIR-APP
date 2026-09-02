/**
 * Where a confirmed e-mail link goes next, decided by pure functions so the rule has a test.
 *
 * `/auth/confirm` is the single landing pad for every link Supabase Auth mails: sign-up
 * confirmation, invitation, magic link, recovery and an address change. The link carries a
 * `token_hash` and a `type`, `verifyOtp` turns them into a session, and then something has to
 * decide which screen the person actually wanted. That decision is here, away from the effect that
 * performs the network call, because it is the half with the security question in it.
 *
 * THE SECURITY QUESTION IS `next`. It arrives from the query string, which means it arrives from
 * whoever wrote the link — and a redirect target taken from a URL is the open-redirect that turns
 * "we mailed you a login link" into "we mailed you a link to somebody else's site, with a fresh
 * session already established". So `next` is resolved against this origin and refused unless it
 * lands back on it: `//evil.example`, `https://evil.example/x` and `javascript:` all resolve to a
 * different origin (or fail to parse) and all come back null.
 */
import type { EmailOtpType } from '@supabase/supabase-js';

/**
 * The five link types this route accepts. Anything else — a `type` we do not mail, or none at
 * all — is refused rather than passed to `verifyOtp`: the reader gets "this link is not one of
 * ours" instead of a provider error in English.
 */
const CONFIRM_TYPES = ['signup', 'invite', 'magiclink', 'recovery', 'email_change'] as const;

export type ConfirmType = (typeof CONFIRM_TYPES)[number];

export function confirmTypeOf(raw: string | null | undefined): ConfirmType | null {
  return CONFIRM_TYPES.find((type) => type === raw) ?? null;
}

/** `verifyOtp` types this as its own union; the two agree, and this states that in one place. */
export function otpTypeOf(type: ConfirmType): EmailOtpType {
  return type;
}

/**
 * `next` as a path on THIS origin, or null.
 *
 * A bare site root is treated as absent, and that is not a detail. GoTrue substitutes the project's
 * Site URL into `{{ .RedirectTo }}` whenever the caller passed no `redirect_to` — which is exactly
 * the sign-up confirmation, the one link that most needs to land on `/set-password`. Honouring `/`
 * as a destination would send a brand-new owner into the product holding a session and no
 * password, with nothing on screen saying so.
 */
export function sameOriginNext(next: string | null | undefined, origin: string): string | null {
  const candidate = (next ?? '').trim();
  if (!candidate) return null;
  let resolved: URL;
  try {
    resolved = new URL(candidate, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return path === '/' ? null : path;
}

export interface ConfirmDestinationInput {
  type: ConfirmType;
  next: string | null | undefined;
  origin: string;
  /** `user_metadata.password_pending` — a hint about which screen is owed, never an authorization. */
  passwordPending: boolean;
}

/**
 * Recovery ignores `next` on purpose. A recovery link exists to change a password, and
 * `/reset-password` is the only screen that does it; letting a query parameter send that session
 * anywhere else would make the most sensitive link the most steerable one.
 */
export function confirmDestination(input: ConfirmDestinationInput): string {
  if (input.type === 'recovery') return '/reset-password';
  return sameOriginNext(input.next, input.origin)
    ?? (input.passwordPending ? '/set-password' : '/');
}
