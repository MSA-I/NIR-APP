/**
 * The contrast contract, as data, read by BOTH gates.
 *
 * Two scripts consume this file and neither owns it:
 *   · `check-contrast-manifest.mjs` (`npm run check:contrast`, inside `verify`) proves the list is
 *     complete and names only tokens `@theme` actually defines. It does NOT compute a ratio —
 *     nothing in `verify` stands up a browser, and a gate that pretends otherwise is a gate that
 *     silently changes what `verify` means.
 *   · `check-contrast-rendered.cjs` (the CI browser job) measures every pair from COMPUTED STYLES
 *     in a real browser, in both themes.
 *
 * WHY A BROWSER IS NOT OPTIONAL FOR THE MEASUREMENT. The palette is `oklch`, several tokens are
 * `color-mix(…)` over other tokens, two scrims carry alpha inside the token, and the bar composites
 * at `/75` over whatever is behind it. Computing a ratio from two literals in Node would answer a
 * question nobody asked; only the browser knows what these resolve to.
 *
 * WHY BOTH THEMES. A pair that passes on warm paper can fail on a teal-black ground and the reverse.
 * Every row below is measured twice.
 *
 * `where` is not decoration: it is what a reader needs in order to judge a failure without opening
 * the stylesheet, and it is the first thing to update when a pair moves.
 */

/** Text: WCAG 2.1 AA, 4.5:1. */
export const TEXT_PAIRS = [
  { fg: 'ink', bg: 'canvas', where: 'page titles on the page ground' },
  { fg: 'ink', bg: 'surface', where: 'strongest text on a card' },
  { fg: 'ink-body', bg: 'canvas', where: 'body copy on the page ground' },
  { fg: 'ink-body', bg: 'surface', where: 'body copy on a card' },
  { fg: 'ink-mid', bg: 'surface', where: 'secondary figures on a card' },
  { fg: 'ink-soft', bg: 'surface', where: 'quiet labels on a card' },
  { fg: 'ink-muted', bg: 'surface', where: '12px card labels — the smallest real text in the product' },
  { fg: 'ink-muted', bg: 'canvas', where: '12px labels on the page ground' },
  { fg: 'ink-soft', bg: 'surface-hover', where: 'a row label under the pointer' },
  { fg: 'ink', bg: 'surface-selected', where: 'the chosen option in a list' },

  { fg: 'on-solid', bg: 'action', where: 'every primary button in the product' },
  { fg: 'on-solid', bg: 'action-solid', where: 'a filled brand mark' },
  { fg: 'action-on-soft', bg: 'action-soft', where: 'the secondary button and the filter chip' },

  { fg: 'done-fg', bg: 'surface', where: 'paid / complete, as text on a card' },
  { fg: 'await-fg', bg: 'surface', where: 'awaiting us, as text on a card' },
  { fg: 'alert-fg', bg: 'surface', where: 'overdue / possible loss, as text on a card' },
  { fg: 'info-fg', bg: 'surface', where: 'ball with an outside party, as text on a card' },
  { fg: 'idle-fg', bg: 'surface', where: 'inactive, as text on a card' },
  { fg: 'alert-fg', bg: 'canvas', where: 'the loudest status, read straight off the page ground' },

  { fg: 'done-on-soft', bg: 'done-soft', where: 'the done badge' },
  { fg: 'await-on-soft', bg: 'await-soft', where: 'the awaiting badge' },
  { fg: 'alert-on-soft', bg: 'alert-soft', where: 'the alert badge' },
  { fg: 'info-on-soft', bg: 'info-soft', where: 'the info badge' },
  { fg: 'idle-on-soft', bg: 'idle-soft', where: 'the idle badge' },

  { fg: 'on-solid', bg: 'done-solid', where: 'a filled done chip' },
  { fg: 'on-solid', bg: 'await-solid', where: 'a filled awaiting chip' },
  { fg: 'on-solid', bg: 'alert-solid', where: 'the unread-alert count and the toast' },
  { fg: 'on-solid', bg: 'info-solid', where: 'a filled info chip' },
  { fg: 'on-solid', bg: 'idle-solid', where: 'a filled idle chip' },

  { fg: 'inverse-ink', bg: 'inverse', where: 'the phone drawer and the role-queue card' },
  { fg: 'inverse-ink-soft', bg: 'inverse', where: 'quiet rows in the drawer / queue card' },
  { fg: 'shell-ink', bg: 'shell', where: 'the auth panels — dark in BOTH themes' },
  { fg: 'shell-ink-soft', bg: 'shell', where: 'quiet copy on the auth panels, and the series name in a chart tooltip' },

  { fg: 'inverse-ink-dim', bg: 'inverse', where: 'the org name under the brand mark in the phone drawer' },
  { fg: 'inverse', bg: 'inverse-ink', where: 'the drawer’s ACTIVE row — a light pill on the dark panel, so the family runs both ways' },
  { fg: 'shell-ink-dim', bg: 'shell', where: 'the axis label at the top of a chart tooltip' },

  { fg: 'nav-current-ink', bg: 'nav-current', where: 'the current page in the phone action bar' },
  { fg: 'fab-puck-ink', bg: 'fab-puck', where: 'the camera glyph on the raised puck' },
  { fg: 'toggle-knob-ink', bg: 'toggle-knob', where: 'the sun/moon on the appearance switch' },

  /* THE MONOGRAM DISCS, split by which way their own lightness moves between themes. Steps 2 and 4
     stay light in both (73% → 80%, 73% → 78%) so they take the ink that does NOT follow the
     palette; steps 3 and 5 flip with it (46% → 70%, 46% → 66%) so they take the ink that does.
     Pairing all four with `ink` measured 1.64:1 and 1.70:1 in the dark theme until 31.08.2026. */
  { fg: 'fixed-onyx', bg: 'series-2', where: 'the initials on identity step 2' },
  { fg: 'on-solid', bg: 'series-3', where: 'the initials on identity step 3' },
  { fg: 'fixed-onyx', bg: 'series-4', where: 'the initials on identity step 4' },
  { fg: 'on-solid', bg: 'series-5', where: 'the initials on identity step 5' },

  { fg: 'chart-tick', bg: 'surface', where: 'axis ticks' },
  { fg: 'chart-label', bg: 'surface', where: 'on-chart labels' },
  { fg: 'trend-up-fg', bg: 'surface', where: 'a rising cost — bad news in this product' },
  { fg: 'trend-down-fg', bg: 'surface', where: 'a falling cost' },

  // The generated documents — PDFs, the order image, the workbook, the supplier portal's
  // rendering of them. The family arrived with the document design system and the contrast
  // gate arrived with the dark theme; nothing had connected the two, so five inks named like
  // lettering sat in no pair at all and `check:contrast` refused the manifest as incomplete.
  //
  // There are TWO grounds here, not one, and the stylesheet says which is which: `doc-plate`
  // is the DARK outbound plate (it aliases `shell`), `doc-paper` is the sheet. An ink is
  // measured against the ground its own comment names.
  { fg: 'doc-ink', bg: 'doc-plate', where: 'lettering on the dark outbound plate' },
  { fg: 'doc-ink-soft', bg: 'doc-plate', where: 'secondary lettering on the dark plate' },
  { fg: 'doc-ink-dim', bg: 'doc-plate', where: 'the faintest lettering on the dark plate' },
  { fg: 'doc-ink-body', bg: 'doc-paper', where: 'body copy on the document sheet' },
  { fg: 'doc-ink-muted', bg: 'doc-paper', where: 'labels and folios on the document sheet' },
];

/**
 * Non-text: WCAG 2.1 AA 1.4.11, 3:1. Boundaries and marks, not lettering.
 *
 * THE FOCUS RING IS NOT ONE PAIR, and that is the finding of 31.08.2026. `--color-focus` is
 * authored for paper. Measured across every ground that actually hosts an inset ring, the luminance
 * bands it would have to avoid run CONTIGUOUSLY from the page surfaces through `inverse` — in
 * EITHER theme — so no single ring colour can serve both a paper ground and a solid or inverted
 * one. It is arithmetic, not taste. A ring on a solid ground therefore takes that ground's own ink,
 * and each of those three pairs is already listed in `TEXT_PAIRS` at 4.5:1, which is stricter than
 * the 3:1 a ring needs: `on-solid` on `action` (the active nav pill), `inverse-ink` on `inverse`
 * (everything inside the phone drawer) and `nav-current-ink` on `nav-current` (the current item in
 * the phone action bar). They are NOT repeated here — the manifest fails on a duplicated pair, and
 * a pair measured at the stricter threshold is measured.
 */
export const NON_TEXT_PAIRS = [
  { fg: 'line-strong', bg: 'surface', where: 'an input border on a card' },
  { fg: 'line-strong', bg: 'canvas', where: 'an input border on the page ground' },
  { fg: 'line-strong', bg: 'surface-sunken', where: 'an input border on a quiet strip' },
  { fg: 'action-line', bg: 'surface', where: 'the secondary button border' },
  { fg: 'focus', bg: 'surface', where: 'the focus ring on a card' },
  { fg: 'focus', bg: 'canvas', where: 'the focus ring on the page ground' },
  { fg: 'nav-current-edge', bg: 'nav-current', where: 'the ring that separates the current pill from the puck' },
];

/**
 * Non-text pairs that are DELIBERATELY below 3:1, each with the reason 1.4.11 does not reach them.
 *
 * THIS LIST IS A CORRECTION, NOT A CONCESSION, and the distinction matters because relaxing a gate
 * to make it green is the cardinal sin. The first version of this manifest asserted 3:1 on all of
 * these and the browser measured them at 1.12-1.32 — **including in the LIGHT theme, which has
 * shipped for weeks**. That was the tell: a brand-new gate failing long-shipped colours is usually
 * the gate being wrong about the requirement, not the palette.
 *
 * Checked against `DESIGN.md`'s own contrast ledger, which predates this work: it lists exactly four
 * non-text components at 3:1 — `line-strong`, `action-line`, `focus` and the empty star — and it
 * ALREADY exempts `chart-grid` at 1.32 with a written reason. The badge borders appear nowhere in
 * it, so the project never claimed they met 3:1. The measurement here returned 1.32 for `chart-grid`
 * — the ledger's number to two decimals — which is an independent check that the measurement itself
 * is right.
 */
export const NON_TEXT_EXEMPT = [
  { fg: 'chart-grid', bg: 'surface', reason: 'gridlines are not an information object; DESIGN.md exempts this pair by name at 1.32' },

  /* THE QUIET DIVIDERS. `line` and `line-soft` separate rows and sections; they are not the boundary
     of any control, and DESIGN.md's non-text ledger names exactly four components at 3:1 —
     `line-strong`, `action-line`, `focus` and the empty star — none of which is either of these.
     They measure 1.04-1.50 in BOTH themes, which is the tell that they were never claimed: a rung
     that has shipped for months at 1.19 on paper was authored as trim, not as an affordance. The
     control boundary is `line-strong`, and it is measured against all three grounds above. */
  { fg: 'line', bg: 'surface', reason: 'a row divider inside a card, not the boundary of a control; the control boundary is line-strong, which is measured' },
  { fg: 'line', bg: 'surface-sunken', reason: 'a row divider on a quiet strip, not the boundary of a control; the control boundary is line-strong, which is measured' },
  { fg: 'line', bg: 'surface-hover', reason: 'a row divider under the pointer, not the boundary of a control; the control boundary is line-strong, which is measured' },
  { fg: 'line-soft', bg: 'surface', reason: 'the quietest section rule on a card; it carries no state and identifies no control, so 1.4.11 does not reach it' },
  { fg: 'line-soft', bg: 'surface-sunken', reason: 'the quietest section rule on a quiet strip; it carries no state and identifies no control, so 1.4.11 does not reach it' },
  { fg: 'line-soft', bg: 'topbar', reason: 'the hairline under the top bar and above the phone action bar; a seam between two surfaces, not a control' },

  /* The same badge hairline on the `wash` rung rather than `soft`. Found by the rendered sweep, not
     by reading the list: the status callouts on a card use the wash, and only the `soft` pairs had
     been named. Identical reasoning, and it is written out rather than inferred because an exemption
     nobody stated is an exemption nobody agreed to. */
  { fg: 'alert-line', bg: 'alert-wash', reason: 'the border of an alert callout, the palest rung of the family; the fill and its own text identify it and both are measured, so 1.4.11 does not reach the hairline' },
  { fg: 'done-line', bg: 'done-wash', reason: 'the border of a done callout, the palest rung of the family; the fill and its own text identify it and both are measured, so 1.4.11 does not reach the hairline' },
  { fg: 'done-line', bg: 'done-soft', reason: 'a badge is not an interactive component — what identifies it is the fill plus its own text, and the hairline is decoration. 1.4.11 covers controls and states, not a border drawn inside a label' },
  { fg: 'await-line', bg: 'await-soft', reason: 'a badge is not an interactive component, so 1.4.11 does not reach it: what identifies it is the fill plus its own text, both of which ARE measured above, and the hairline is trim. the non-text ledger in DESIGN.md lists four components at 3:1 and this is not one of them' },
  { fg: 'alert-line', bg: 'alert-soft', reason: 'a badge is not an interactive component, so 1.4.11 does not reach it: what identifies it is the fill plus its own text, both of which ARE measured above, and the hairline is trim. the non-text ledger in DESIGN.md lists four components at 3:1 and this is not one of them' },
  { fg: 'info-line', bg: 'info-soft', reason: 'a badge is not an interactive component, so 1.4.11 does not reach it: what identifies it is the fill plus its own text, both of which ARE measured above, and the hairline is trim. the non-text ledger in DESIGN.md lists four components at 3:1 and this is not one of them' },
  { fg: 'idle-line', bg: 'idle-soft', reason: 'a badge is not an interactive component, so 1.4.11 does not reach it: what identifies it is the fill plus its own text, both of which ARE measured above, and the hairline is trim. the non-text ledger in DESIGN.md lists four components at 3:1 and this is not one of them' },
];

/**
 * Pairs where the contract is a DIRECTION, not a ratio.
 *
 * The appearance switch's knob has to be LIGHTER than its own pill so it reads as a disc raised
 * above it. That is the whole invariant, and it is not a contrast threshold: the control's outer
 * boundary against the page is `--color-line`, its state is carried by the knob's POSITION, and a
 * 3:1 step between two adjacent greys inside one small control would make it shout.
 *
 * It is here because the relationship INVERTED once. The knob borrowed `surface` and the track
 * `surface-selected`, and the light palette has `surface` above `selected` while the dark palette
 * has it below — so the raised disc became a hole punched into the pill the moment the dark theme
 * existed. A ratio would not have caught that; a direction does.
 */
export const DIRECTION_PAIRS = [
  {
    lighter: 'toggle-knob',
    darker: 'toggle-track',
    where: 'the appearance switch: the knob is a disc RAISED above its pill, in both themes',
  },
];

/**
 * Tokens that carry text and are DELIBERATELY below 4.5:1, each with the reason.
 *
 * Declared rather than omitted: a missing row and an intentional exclusion look identical in a list,
 * and `check-contrast-manifest.mjs` fails on an ink token that appears in neither.
 */
export const TEXT_EXEMPT = new Map([
  ['ink-faint', 'placeholder text and empty-state hints — legible-but-recessive is the job; WCAG exempts placeholder-style text and the field it sits in carries a label of its own'],
  ['ink-ghost', 'disabled lettering. 1.4.3 exempts inactive controls, and raising it would make disabled look available'],
]);

/** Every `--color-*` name that behaves as lettering, used for the completeness check. */
export const INK_TOKENS = [
  'ink', 'ink-body', 'ink-mid', 'ink-soft', 'ink-muted', 'ink-faint', 'ink-ghost',
];

/** Families whose six rungs must each appear somewhere above. */
export const STATUS_FAMILIES = ['done', 'await', 'alert', 'info', 'idle'];
