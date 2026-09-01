/**
 * The addresses a customer can actually reach a human at, in one place.
 *
 * WHY THIS FILE EXISTS. The product tells a user to contact support in nineteen different error
 * messages ("יש לפנות לתמיכה") and, until this file, never once said how. An instruction with no
 * address is not a support channel; it is an apology. These constants are what turn those
 * sentences into something a person can act on.
 *
 * THESE ARE NOT THE SAME AS THE SENDING IDENTITIES. `no-reply@` and `orders@` are Resend senders
 * and are deliberately absent here — nobody reads them, and offering one to a customer would be
 * worse than offering nothing. The mirror of this file on the server is
 * `supabase/functions/_shared/reply-to.ts`, which decides what an automated email's Reply-To is;
 * the two agree that a product email's reply lands on support, and that a supplier order's never
 * does.
 *
 * INTERNAL FEEDBACK IS A DIFFERENT CHANNEL AND STAYS SEPARATE. `send-feedback` posts to the team's
 * own Discord: it is how the people building InPlace hear what is awkward. Support is how a
 * customer gets a problem solved. Collapsing them would send customer problems somewhere with no
 * reply path and bury product feedback in a queue meant for incidents.
 */

/** Customer support. The default destination for anyone who needs a human. */
export const SUPPORT_EMAIL = 'support@inplace.digital';

/** Subscription, invoice and payment questions that need a person rather than the provider. */
export const BILLING_EMAIL = 'billing@inplace.digital';

/** Vulnerability reports. Separate because a security report must not queue behind billing. */
export const SECURITY_EMAIL = 'security@inplace.digital';

/**
 * A `mailto:` href with an optional pre-filled subject.
 *
 * The subject is encoded rather than interpolated. A subject built from product text can contain
 * a newline, and a newline in a mailto URL is how extra headers (`&bcc=`) get appended — the same
 * injection class the server-side Reply-To guard exists for, in the one place the browser can
 * reach it.
 */
export function supportMailto(address: string, subject?: string): string {
  const base = `mailto:${address}`;
  if (!subject) return base;
  return `${base}?subject=${encodeURIComponent(subject)}`;
}
