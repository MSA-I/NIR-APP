import Entrance from './Entrance';

/**
 * `/signup` — the same card as `/login`, opened on the "name a business" side.
 *
 * This is still the address every provider returns to (`lib/authProviders.ts`), because it is
 * still the only place that turns a proven address into an organization. It is no longer a
 * separate screen from the sign-in one: see `Entrance`.
 */
export default function Signup() {
  return <Entrance initialMode="createBusiness" />;
}
