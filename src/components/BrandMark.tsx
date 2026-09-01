/**
 * OUR mark, drawn INLINE so it can take the colour of the surface it sits on.
 *
 * WHY NOT `<img src="/favicon.svg">`, which is what this used to be: an external SVG loaded through
 * `<img>` is a separate document. It cannot see this page's custom properties and it cannot inherit
 * `currentColor` — so the "one mark, two inks, follows its ground" rule the owner asked for on
 * 31.08.2026 is simply unreachable that way. Every alternative was worse: two files and a
 * theme-reading component (a second source of truth for one shape), or a CSS `mask` (an extra
 * network request and a shape you cannot see in the markup).
 *
 * The paths are `public/brand/inplace-symbol.svg`'s, in one ink since the same ruling withdrew the
 * two-tone mark. They are duplicated here rather than imported because Vite would inline the file
 * as a URL, which puts us straight back to the separate-document problem.
 *
 * THE GROUND DECIDES, NOT THE THEME (owner: "כן, לפי הרקע"). Taken literally, "light mark on dark
 * mode, dark mark on light mode" breaks TODAY, before dark mode exists: the phone drawer is onyx in
 * the LIGHT theme, so a dark mark there is invisible. And after decision #331(א) the drawer inverts,
 * so a theme-keyed rule would be wrong in the other direction. `currentColor` sidesteps the whole
 * question: the mark is whatever colour the text beside it is, on every surface, in both themes,
 * with no component knowing which theme is active.
 *
 * DECORATIVE, and that is load-bearing rather than pedantic. The desktop bar and the phone drawer
 * are BOTH mounted in one document, so a `<title id="title">` inside this SVG — which the source
 * file has, correctly, for a standalone asset — would appear twice in the accessibility tree with a
 * duplicate id. The accessible name lives on the wrapping `<Link>`, which already carries
 * `layoutTail.homeAria`; this is the picture inside that link and nothing more.
 */
export function BrandMark({ px, className }: { px: number; className?: string }) {
  return (
    <svg
      viewBox="1659.8087799072266 677.8427764892579 156.29247436523437 156.29247436523437"
      width={px}
      height={px}
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M 1669.44 755.823 L 1710.28 755.879 C 1708.61 767.232 1707.38 778.645 1706.59 790.092 L 1736.02 790.07 C 1736.92 781.041 1737.62 771.993 1738.13 762.934 L 1760.32 763.051 C 1759.51 774.972 1758.47 786.875 1757.2 798.755 L 1754.87 825.177 L 1663.53 825.087 L 1669.44 755.823 z" />
      <path d="M 1720.4 686.812 L 1812.38 686.801 C 1811.2 709.917 1808.06 732.974 1806.67 756.062 L 1771.75 756.048 C 1770.71 756.05 1767.89 756.114 1767.79 755.436 C 1766.97 749.628 1769.92 723.931 1770.27 718.871 L 1740.77 718.879 C 1739.68 728.796 1739.03 738.754 1737.95 748.673 C 1729.48 748.622 1723.1 748.384 1714.61 749.043 C 1716.84 728.328 1718.77 707.582 1720.4 686.812 z" />
    </svg>
  );
}
