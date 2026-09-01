/**
 * The initials disc, in one place.
 *
 * Two copies existed and neither was wrong on its own: `Layout.tsx` took the first letter of up to
 * two words of the member's name, `OperatorShell.tsx` took the first two characters of an email.
 * Both painted an oceanic disc, both marked the glyphs `aria-hidden` and let the name beside them
 * be the accessible source. What neither could do is what a supplier list needs — a mark that
 * DIFFERS between rows, so the eye can find a row without reading it.
 *
 * TWO TONES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 *
 * `action` is the account disc: there is exactly one signed-in person on the screen, so the disc
 * identifies a ROLE, not a member, and T7.3 fixed it in the brand's oceanic ("the blue leads").
 * Seeding it per user would have made a decided colour accidental.
 *
 * `series` is the entity disc: it identifies WHICH supplier, so it has to vary, and it varies
 * inside the palette that exists for identity. `series-1..5` are the steps `DESIGN.md:424-428`
 * measured at ≥15 ΔE in full vision and ≥8 under simulated colour-vision deficiency — the only
 * colours in the system whose separation has actually been measured. Four of the five are usable
 * here; see below.
 *
 * THE INK IS MEASURED, AND THE MEASUREMENT COST A STEP. The five do not share a lightness, so no
 * single foreground clears WCAG AA on all of them. Recomputed from `index.css`:
 *
 *     series-1  white 4.15  ink 4.39     <- FAILS BOTH
 *     series-2  white 2.35  ink 7.74
 *     series-3  white 7.50  ink 2.43
 *     series-4  white 2.27  ink 8.03
 *     series-5  white 7.38  ink 2.47
 *
 * `series-1` sits at 58% lightness — the middle, where it is too dark for dark ink and too light
 * for light ink — and at the monogram's type size neither AA-large exemption applies. So the
 * monogram uses FOUR of the five steps, and says so rather than shipping one disc at 4.15:1.
 * `series-1` is untouched everywhere it is a fill rather than a text background, which is every
 * other place it is used.
 *
 * `entityMonogram.spec.tsx` recomputes every pairing from the tokens and fails below 4.5:1, so a
 * retheme that moves a step breaks a test rather than a contrast ratio.
 *
 * NOTHING IS FETCHED. No site-icon lookup, no logo scraper, no third-party mark service: an
 * outbound request per supplier is an SSRF and privacy surface, and `DEBT §5` says we have no
 * proof of an external target. A monogram needs no registry, and that is the point of it —
 * `P3.1` in the plan says so in as many words.
 */

/**
 * The five identity steps, each with the foreground its lightness actually allows.
 *
 * WRITTEN OUT IN FULL ON PURPOSE. Tailwind scans source text for class names, so a composed
 * a composed background class produces no CSS at all and the disc renders transparent — a failure that looks
 * like a styling opinion rather than a missing rule. The pair is also what the spec reads: it
 * parses these literals and recomputes both contrast ratios from `index.css`.
 *
 * WHY `fixed-onyx` AND NOT `ink` ON STEPS 2 AND 4. Those two discs are LIGHT in both themes
 * (73% → 80% and 73% → 78%), so the letter on them has to be dark in both themes — and `ink` is
 * not: it flips to near-white when `data-theme="dark"`, which put light letters on a light disc
 * at 1.64:1 and 1.70:1. `fixed-onyx` is the token that deliberately does not follow the palette,
 * so it reads at 7.77:1 / 9.90:1 and 8.04:1 / 9.55:1. Steps 3 and 5 keep `on-solid`: they are the
 * two discs whose own lightness flips WITH the theme (46% → 70%, 46% → 66%), so an ink that flips
 * with it is exactly right there. The spec now recomputes all four pairs in BOTH blocks — it
 * previously read only `@theme`, which is how a dark-theme regression passed a green test.
 */
const MONOGRAM_PAINT = [
  'bg-series-2 text-fixed-onyx',
  'bg-series-3 text-on-solid',
  'bg-series-4 text-fixed-onyx',
  'bg-series-5 text-on-solid',
] as const;

const SIZES = {
  sm: 'size-7 text-[0.625rem]',
  md: 'size-9 text-xs',
  lg: 'size-10 text-sm',
} as const;

/**
 * A stable index from a stable seed.
 *
 * FNV-1a over the seed's code units. Deterministic across reloads, machines and sessions, which is
 * the whole property that makes the mark useful: a supplier that changes colour between visits is
 * noise, not identity. Not a security hash and not used as one.
 */
export function monogramIndex(seed: string, buckets = MONOGRAM_PAINT.length): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/**
 * Up to two initials, from a name or an address.
 *
 * A name gives one letter per word; an address has no words, so it gives its first two characters
 * — which is exactly what the operator console did by hand. An empty name gives a neutral dot
 * rather than an empty disc, because a disc with nothing in it reads as a failed image.
 */
export function monogramInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '·';
  if (!/\s/.test(trimmed) && trimmed.includes('@')) return trimmed.slice(0, 2).toUpperCase();
  const letters = trimmed.split(/\s+/).slice(0, 2).map((word) => [...word][0]).join('');
  return letters || '·';
}

export function EntityMonogram({ name, seed, size = 'md', tone = 'series', className = '' }: {
  name: string;
  /** What the colour is derived from — an id, never the name, so a rename keeps the mark. */
  seed?: string;
  size?: keyof typeof SIZES;
  tone?: 'series' | 'action';
  className?: string;
}) {
  const index = tone === 'series' ? monogramIndex(seed ?? name) : null;
  const paint = index == null ? 'bg-action text-on-solid' : MONOGRAM_PAINT[index];
  return (
    <span aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-medium ${SIZES[size]} ${paint} ${className}`}>
      {monogramInitials(name)}
    </span>
  );
}
