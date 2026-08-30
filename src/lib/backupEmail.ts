/**
 * The second address an owner can be reached at, and the one rule that decides who is asked for it.
 *
 * Owner decision #270 (`require-backup-email`): a verified alternate address, so that the owner's
 * mail channel does not disappear with the address they signed up with. It is a prerequisite for
 * turning Sign in with Apple on, and the two rulings the owner attached to it are what this module
 * exists to hold:
 *
 *   1. THE REQUIREMENT IS ABOUT THE ADDRESS, NEVER ABOUT THE PROVIDER. Only a Private Relay
 *      forwarding address is asked for a second one. It is the only address in the product that a
 *      third party can switch off — the person turns off forwarding in their Apple ID settings, or
 *      deletes the app-specific relay, and every mail we send after that is accepted and discarded.
 *      A password signup, and a Google signup that handed over a real mailbox, are asked for
 *      nothing: there is nothing there that can vanish while the account still works.
 *   2. BUILT NOW, ENFORCED WHEN APPLE IS SWITCHED ON. `enforced` is injected rather than read here,
 *      and it is `false` on both sides today. See `backupEmailRequired` for why that direction is
 *      not merely cautious but the only safe one while `DEBT §25` stands.
 *
 * READ BY TWO RUNTIMES. Vite for the browser and Deno for `public-signup`, through the same
 * shared-contract door `src/lib/assistant/contracts.ts` already uses. So: no `import.meta.env`, no
 * DOM, no imports at all. The enforcement switch is read by each runtime from its own environment
 * and passed in — a module that reached for `import.meta.env` here would compile in the bundle and
 * be `undefined` in the Edge function, which is the quietest possible way to enforce a rule on one
 * side of a request and not the other.
 */

/**
 * Apple's forwarding domain, and the entire detection surface.
 *
 * There is exactly one entry and that is a fact about Apple, not an oversight. `Hide My Email`
 * (iCloud+) mints `@icloud.com` addresses that are indistinguishable from an ordinary iCloud
 * mailbox, so they cannot be detected and are deliberately not guessed at: treating every
 * `@icloud.com` as disposable would ask millions of people with a real iCloud account to nominate
 * a backup they do not need. Sign in with Apple's relay is the case that IS detectable, and it is
 * the case owner decision #270 was written about.
 */
export const APPLE_PRIVATE_RELAY_DOMAIN = 'privaterelay.appleid.com';

/** Kept as a list so a second provider's relay can join without a second detection function. */
export const PRIVATE_RELAY_DOMAINS: readonly string[] = [APPLE_PRIVATE_RELAY_DOMAIN];

/** The same shape check the signup screen and `validateProvisionInput` already apply. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321's ceiling, and the length `validateProvisionInput` already bounds the primary by. */
export const MAX_EMAIL_LENGTH = 320;

export function normaliseEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Whether this address is a relay that a third party can switch off.
 *
 * Compares the domain EXACTLY. `evil-privaterelay.appleid.com` and
 * `privaterelay.appleid.com.attacker.test` are not Apple's relay, and a `endsWith` check would
 * call both of them one — which in the direction that matters here would ask a stranger for a
 * second address and, worse, teach the reader that suffix matching is how domains are compared.
 */
export function isPrivateRelayAddress(value: string | null | undefined): boolean {
  const email = normaliseEmail(value);
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return PRIVATE_RELAY_DOMAINS.includes(email.slice(at + 1));
}

export type BackupEmailProblem =
  | 'missing'
  | 'malformed'
  | 'too_long'
  | 'same_as_primary'
  | 'still_a_relay';

/**
 * What is wrong with a nominated backup address, or `null` when it is usable.
 *
 * `same_as_primary` and `still_a_relay` are the two answers that look like a valid address and
 * are not a backup at all: the first is the address we are trying to survive the loss of, the
 * second is another one with the same failure mode. Both are refused here rather than in the
 * screen alone, because `public-signup` is reachable without the screen.
 */
export function backupEmailProblem(
  candidate: string | null | undefined,
  primaryEmail: string | null | undefined,
): BackupEmailProblem | null {
  const backup = normaliseEmail(candidate);
  if (!backup) return 'missing';
  if (!EMAIL_SHAPE.test(backup)) return 'malformed';
  if (backup.length > MAX_EMAIL_LENGTH) return 'too_long';
  if (backup === normaliseEmail(primaryEmail)) return 'same_as_primary';
  if (isPrivateRelayAddress(backup)) return 'still_a_relay';
  return null;
}

/**
 * Whether this signup must nominate a backup address before it may proceed.
 *
 * `enforced` comes first and short-circuits, and that ordering is the whole safety property.
 * Enforcement is OFF today because `inplace.digital` is not DNS-verified and Resend is in sandbox:
 * a verification mail to a customer's own mailbox is accepted by the API and never delivered
 * (`DEBT §25`; the code already measures it as `deliveryLimited`). A requirement shipped ON would
 * therefore make signup unreachable for every real customer, with no way for them to tell that
 * from the product being broken.
 *
 * So an unmeasured, unset or missing switch reads as "not switched on yet" and NEVER as a refusal
 * — the same rule `private.auth_org_allows` and `src/lib/entitlements.ts` state on the two sides
 * of the entitlement question (`DEBT §79`). It is switched on in the same change that switches
 * Apple on, and not before.
 */
export function backupEmailRequired(
  primaryEmail: string | null | undefined,
  options: { enforced: boolean },
): boolean {
  if (!options.enforced) return false;
  return isPrivateRelayAddress(primaryEmail);
}
