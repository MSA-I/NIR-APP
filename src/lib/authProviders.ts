import { supabase } from './supabase';

/**
 * The federated sign-up surface, in one place because it now has two screens.
 *
 * `Signup.tsx` owned all of this while Google was the only provider and the signup screen was the
 * only entrance. Both stopped being true: Apple joined (owner decision 25.08.2026), and the login
 * screen offers the same door to a business owner who arrived there by habit. Two copies of "which
 * providers exist, are they configured, and where does the browser come back to" is how the two
 * screens would drift until one of them sent the person somewhere the other did not expect.
 *
 * What is NOT here, deliberately: any notion of who may use these. "Owner only" is a server fact —
 * `0205` makes `accept_invitation` refuse a federated caller by name, and `public-signup`'s
 * federated branch only ever creates the owner of a NEW organization and refuses a caller that
 * already has a profile. A flag in the browser bundle decides what is drawn, never what is allowed.
 */
export type FederatedProvider = 'google' | 'apple';

export const FEDERATED_PROVIDERS: readonly FederatedProvider[] = ['google', 'apple'];

export const FEDERATED_PROVIDER_LABEL: Record<FederatedProvider, string> = {
  google: 'Google',
  apple: 'Apple',
};

/**
 * A provider is drawn only when it is configured. A door that leads to "provider is not enabled"
 * is worse than no door — which is exactly what the login screen's placeholder button was until
 * this change.
 *
 * Read at module scope because Vite substitutes `import.meta.env` at build time; these are not
 * runtime switches, and flipping one means a rebuild.
 */
const FEDERATED_SIGNUP_ENABLED: Record<FederatedProvider, boolean> = {
  google: import.meta.env.VITE_GOOGLE_SIGNUP_ENABLED === 'true',
  apple: import.meta.env.VITE_APPLE_SIGNUP_ENABLED === 'true',
};

export function enabledFederatedProviders(): FederatedProvider[] {
  return FEDERATED_PROVIDERS.filter((provider) => FEDERATED_SIGNUP_ENABLED[provider]);
}

/**
 * Whether the backup-address requirement (owner decision #270) is switched on.
 *
 * It lives HERE, beside `VITE_APPLE_SIGNUP_ENABLED`, because the owner tied the two together:
 * "build it now, enforce it only when Apple is switched on". A person can only end up holding a
 * Private Relay address by signing in with Apple, so a requirement that were on while Apple is off
 * would apply to nobody — and one that stayed off after Apple was turned on would let the first
 * Apple owner in through the door the decision exists to close. Keeping both switches in one file
 * is what makes "flip them together" a thing a reader can see rather than remember.
 *
 * Read at module scope for the same reason the provider switches are: Vite substitutes
 * `import.meta.env` at build time, so this is not a runtime switch and flipping it means a
 * rebuild. `public-signup` reads its own copy from `REQUIRE_BACKUP_EMAIL` and reaches the same
 * answer through the same pure function; neither side may refuse on an unset switch.
 */
const BACKUP_EMAIL_REQUIREMENT_ENFORCED =
  import.meta.env.VITE_REQUIRE_BACKUP_EMAIL === 'true';

export function backupEmailRequirementEnforced(): boolean {
  return BACKUP_EMAIL_REQUIREMENT_ENFORCED;
}

/**
 * Start the provider hand-off, always returning the browser to `/signup`.
 *
 * The destination is the same from either screen and that is the point: the provider proves an
 * address, it does not create a tenant. Whoever comes back still has to name a business, and
 * `public-signup` still has to agree — so a person who was invited to an existing organization
 * lands on the signup screen holding a session that grants nothing, rather than half-way into a
 * flow the server will refuse.
 */
export async function startFederatedSignup(
  provider: FederatedProvider,
): Promise<{ error: unknown }> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/signup` },
  });
  return { error };
}
