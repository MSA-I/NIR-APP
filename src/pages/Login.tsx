import Entrance from './Entrance';

/**
 * `/login` — the same card as `/signup`, opened on the sign-in side.
 *
 * The two routes survive as routes because half the product points at them: the marketing site's
 * two calls to action, every `Navigate to="/login"` guard, and the `redirectTo` a provider returns
 * to. What no longer survives is the NAVIGATION between them — owner report 31.08.2026, "two
 * buttons that lead to two separate windows". Opening a business from here expands a section; it
 * does not replace the page, and it does not lose what was already typed.
 */
export default function Login() {
  return <Entrance initialMode="signIn" />;
}
