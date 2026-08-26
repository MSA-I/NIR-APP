# Gates: eight owner UI reports — the palette stops speaking two languages

Branch: `claude/ui-colors-updates-7198bd`, based on `claude/ui-components-cleanup-d8b29b` (owner
direction 26.08.2026: main moved and that branch is the look this work builds on) merged with
`main`.

OWNS: src/index.css, src/components/charts.tsx, src/components/assistant/AssistantDialog.tsx,
src/components/OrgSubscriptionPanel.tsx, src/components/Layout.tsx, src/components/MenuToggleIcon.tsx,
src/pages/Dashboard.tsx, brand/assets/inplace-symbol.svg, public/brand/inplace-symbol.svg,
brand/assets/inplace-lockup.svg, public/brand/inplace-lockup.svg, brand/assets/inplace-app-icon.svg,
public/brand/inplace-app-icon.svg, public/favicon.svg, DESIGN.md, GATES.md, and the spec files that
pin the above.

## What the owner reported (8 items, verbatim intent)

1. The assistant carries colours from the old palette, has bugs, and offers too few example questions.
2. The subscription UI should look like the reference image (plan cards in a row, not stacked rows).
3. The purchase-spend trend chart should wear the colours of the month's purchase-mix donut.
4. "רכש מול תשלומים": a small dot at the end of each line, and the series names level with their dot.
5. The logo: one part dark, the lower part in the app's blue.
6. The three lines that open the drawer get an animation (the reference component in `Untitled.txt`).
7. The custom cursor on the marketing site should track the pointer more precisely, and be darker.
8. The pale-cyan hover tint is off-palette — replace it with a grey/neutral one.

---

## Acceptance gates

| # | Gate | CHECK / evidence | State |
|---|---|---|---|
| G1 | Hover and selected surfaces carry no cyan tint | read live from the running app: `--color-surface-hover` = `oklch(95.6% 0.004 80)`, selected `oklch(91.5% 0.006 80)` — chroma 0.018→0.004 and 0.028→0.006, hue 200/202→80, **lightness untouched** so §accessibility's measured rows still hold. Screenshot `after/dashboard-full.png`: the hovered "חשבוניות הממתינות לאישור" row is a neutral grey step | **PASS** |
| G2 | The assistant's marks and chips stop mixing a cool wash into a warm panel | `grep -c bg-action-wash AssistantDialog.tsx` = 0. Screenshot `after/assistant.png` vs `before/assistant.png` | **PASS** |
| G3 | The assistant offers more openings per role | `ROLE_EXAMPLES` = **6 per role** (was 2). Every entry checked against its tool's `requiredRoles`; the accountant's "כמה כסף ממתין לזיכוי?" was a suggestion the server refuses (`get_open_credits` is owner+office) and is gone | **PASS** |
| G4 | The assistant's stated bugs are fixed | (a) measured in the live DOM — field 12→427 with a 16px radius, disc left edge 22 ⇒ **4.8px inside** the curve; before: radius 24, disc at 20, **2.4px outside**. (b) "בדיקות קודמות" now renders in the loading state too, so the two skeleton bars are captioned instead of anonymous | **PASS** |
| G5 | The monthly purchase-spend bars are drawn from the donut's categorical palette | `SpendBarChart` reads `chartTheme().categorical` per bucket; screenshot `after/monthly.png` (was three lightness steps of one hue) | **PASS** |
| G6 | Each comparison line ends in a dot, and its name sits at the dot's height | dot and label are one node reading one `y`; `chartEndLabels.spec.ts` (4 tests) pins exact placement, upward-only stacking and the null series. Screenshot `after/weekly.png` — the date tick "19/07" is clear, which it was not before | **PASS** |
| G7 | The symbol is two-tone: upper part dark, lower part the app's brand colour | 5 SVGs rewritten by anchored replacement (1 fill changed, 1 dark fill left in each). Rendered at 200px: `after/logo.png` | **PASS** |
| G8 | The drawer trigger animates its three lines into an X | measured in the live DOM with the drawer open: the three paths read `rotate=315deg / 45deg / 135deg`, `translate=0`. `after/menu-midflight.png` catches the fold at 220ms with the drawer still travelling | **PASS** |
| G9 | `npm run build` green | build + typecheck clean | **PASS** |
| G10 | `npm run verify` green | Knip, `check:money`, `check:tokens` (382 files), `check:typography` (383), `check:exemptions`, `check:supplier-columns`, `check:assistant-no-send`, `check:assistant-tool-schemas`, `check:anchored-replacements`, **1,657 tests / 158 files** | **PASS** |
| G11 | Visual evidence exists for every visual claim | headed runs at 1440×1000 and 390×844, before and after, in the session scratchpad | **PASS** |
| G12 | The subscription ladder is a grid on the wide viewport and one rung per line on the phone, on `/settings/subscription` only | `PLAN_GRID` = 1 / 2 / **5** tracks at base / `md` / `xl`; measured in the live app — 358px single track at 390px wide. `/pricing` still renders `PLAN_LIST`. Screenshots `after/subscription.png` and `after/subscription-mobile.png` | **PASS** |
| G13 | The dashboard's background orb tracks the pointer closely and sits a little deeper | transition `0.45s` → **`0.12s`** (read live off `<html>`); orb alpha `15%` → **`17%`**, which is the measured AA ceiling — swept in the running app, `ink-muted` on canvas: 15% → 4.73, 17% → 4.60, 18% → **4.47 fails**, 20% → **4.32 fails** | **PASS** |

## G12 — the ruling it reverses, and what the owner kept from it

`PlanCard.tsx` carried a ruling from earlier the same day rejecting a grid: five rungs in three
columns wrap 3 + 2 and leave a hole; five columns crush every card to ~217px; a grid reads as a
shelf of equals. Rather than override it silently, it was put back to the owner, who answered on
26.08.2026: **«רשת באתר המותאם · שורה במובייל · רק מה שבאפליקציה בהגדרות»**.

That answer keeps the arithmetic and drops the aesthetic objection. So the grid is bounded exactly
where the old ruling had a point: it starts at `xl`, not `lg` (five tracks need 80rem, and the page
container was widened to match), the phone keeps one rung per line, and `/pricing` — a comparison
rather than a place you act, and the surface with no price to build a card around — stays a list.
The reversal is written into `PLAN_GRID`, `PlanCardLayout` and DESIGN.md beside the plan-badge
section, so the next reader meets the decision and not the contradiction.

## Out of this ledger, and why

- Item 7 was read as the marketing site's custom cursor and was about to be sent to the landing-page
  repository. The owner corrected it: **it is in this app** — "לא בדיוק סמן אלא יותר שיידר כזה
  שנמצא ברקע של הדאשבורד", i.e. `.app-glow`. Done here, as G13. Nothing is owed to the other repo.
- The public `/pricing` page is NOT re-laid out, by the owner's own scoping ("רק מה שבאפליקציה
  בהגדרות"). It also could not carry the reference's card anyway: #206/25.08 forbids a price on a
  public surface, and the reference's card is built around one.
- **`--color-ink-muted` was not deepened.** It is what caps G13's orb at 17%, and moving it
  repaints secondary text on every screen — a decision of its own, not a side effect of an
  atmosphere tweak. Flagged to the owner as the available next step.
