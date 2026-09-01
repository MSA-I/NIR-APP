// reply-to.ts -- who a recipient reaches when they press Reply, decided in one place.
//
// TWO AUDIENCES, TWO ANSWERS, AND THEY MUST NOT BE SWAPPED.
//
//   * A product email (invitation, subscription activation, anything InPlace says on its own
//     behalf) is from InPlace, so Reply-To is InPlace support. That is a constant.
//
//   * A purchase order is from a TENANT to THEIR supplier. InPlace is the courier, not the
//     correspondent. Routing that reply to InPlace support would put a stranger's commercial
//     conversation -- prices, quantities, disputes -- into our inbox, and would leave the supplier
//     believing they had answered their customer when they had not. So the reply address is the
//     tenant's, and the From address (orders@) exists precisely so the two never share an
//     identity.
//
// WHERE THE TENANT ADDRESS COMES FROM, AND WHERE IT MAY NOT. It is read from the VERIFIED
// identity of the authenticated user who pressed send -- an owner or office member whose role the
// claiming RPC has already checked against the order's own organization. It is never read from
// the request body. A client-chosen Reply-To would let any tenant user aim a supplier's answer at
// an address they do not control, using our verified domain to make it look legitimate; that is
// a phishing primitive, not a preference.
//
// EVERY ADDRESS IS RE-VALIDATED HERE EVEN THOUGH AUTH ALREADY VALIDATED IT. This string is about
// to become a mail HEADER. A value carrying CR or LF splits that header and appends attacker
// chosen ones (Bcc:, Content-Type:) -- the classic header-injection hole. Validation at the point
// of use is what closes it, because it does not depend on every upstream writer having been
// careful.

/** InPlace's own human inbox. Product email replies land here and nowhere else. */
export const SUPPORT_REPLY_TO = 'support@inplace.digital';

/** Where the tenant reply address was found. Recorded so a missing one is visible, not silent. */
export type ReplyAddressSource = 'actor' | 'none';

export interface TenantReplyAddress {
  /** A header-safe address, or null when none could be resolved. */
  address: string | null;
  source: ReplyAddressSource;
}

/**
 * A plain local@domain and nothing else. Deliberately stricter than RFC 5322: this guards a header
 * we build ourselves, so it only has to accept the addresses real users actually have.
 */
const ADDRESS_SHAPE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Longer than any address a mail system will accept, and short enough to bound the regex. */
const ADDRESS_MAX = 254;

/**
 * CR and LF are the header-injection vector; the rest of C0 and DEL have no place in an address.
 *
 * Both classes here are built with `new RegExp` from a plain string instead of being written as
 * regex literals. That is not style. A literal needs backslash escapes, and a backslash that gets
 * halved somewhere between an author and this file turns `[<>,;"\\s]` into `[<>,;"\s]` -- a class
 * that quietly forbids the letter `s`, rejects `support@inplace.digital`, and lets a real
 * backslash through. That bug happened while this module was being written, and the tests caught
 * it; constructing from strings is how it stays caught.
 */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001F\\u007F]');

/** Whitespace, quoting, escaping, and the separators that would smuggle a second recipient. */
const FORBIDDEN_IN_ADDRESS = new RegExp('[<>,;"\\\\\\s]');

/**
 * Returns the address if it is safe to place in a Reply-To header, otherwise null.
 *
 * Rejects, in order: non-strings; any control character in the RAW value; an empty or overlong
 * address; whitespace, quoting, escaping and separator characters; and finally anything that is
 * not a plain local@domain.
 */
export function sanitizeReplyAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // BEFORE trim(), deliberately. trim() strips CR and LF, so trimming first would turn
  // "buyer@tenant.example\r" into a silent ACCEPT of an address that arrived carrying a line
  // break. A control character anywhere in the raw value is the injection signature; it is
  // refused, never cleaned up.
  if (CONTROL_CHARACTERS.test(value)) return null;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > ADDRESS_MAX) return null;
  if (FORBIDDEN_IN_ADDRESS.test(candidate)) return null;
  if (!ADDRESS_SHAPE.test(candidate)) return null;
  return candidate.toLowerCase();
}

/**
 * The tenant reply address for a supplier order.
 *
 * `actorEmail` is the email on the authenticated caller's verified identity, read server-side.
 * When it resolves to nothing usable the answer is `none`, and the caller must send the message
 * WITHOUT a Reply-To header rather than substituting InPlace support -- see the header comment.
 * An order that reaches a supplier is worth more than a reply path, so this never blocks a send;
 * `source` is what makes the degradation visible.
 */
export function resolveTenantReplyAddress(actorEmail: unknown): TenantReplyAddress {
  const address = sanitizeReplyAddress(actorEmail);
  return address === null ? { address: null, source: 'none' } : { address, source: 'actor' };
}

/**
 * Builds the `reply_to` field for a Resend request body, or undefined when there is none.
 * Returning undefined rather than null matters: `JSON.stringify` drops an undefined property, so
 * the provider receives no reply_to key at all instead of one holding null.
 */
export function replyToField(address: string | null): string | undefined {
  return address ?? undefined;
}
