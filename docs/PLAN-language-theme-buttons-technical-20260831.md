# Plan: language button · light/dark theme · monochrome logo · phone action-bar active state

_Round 5 — revised by Claude after Codex critique #5. **The loop hit its 5-round cap; this
revision has NOT been re-reviewed.** See "State of the review" at the end._

> Rounds 0–4 and all five critiques are in `PLAN-REVIEW-LOG.md`. English for this review; the
> Hebrew owner-facing version is `docs/PLAN-language-theme-buttons-20260831.md`.
> Product is Hebrew-first (`BASE_LOCALE = 'he'`), RTL.

## Owner rulings — 31.08.2026. Facts, not questions.

| # | Ruling |
|---|---|
| 1 | **Currency picker: request withdrawn** ("ראה הערה שלי כמבוטלת"). Decision **#305 stands**; `Dashboard.tsx:921-931` is correct. **Package D deleted** |
| 2 | **Dark mode: build in full.** New numbered decision superseding #79 + **ADR-0003** superseding ADR-0002 |
| 3 | **Placement: option א** — theme = visible round button beside the account disc; language = row in the account menu. Phone: both in the drawer |
| 4 | **Logo ink: onyx `#0A171D`** |
| 5 | **In dark mode the nav is LIGHTER than the page** |
| 6 | **`plan-card.css`: leave exactly as is** |
| 7 | **Ship the language button now**; record the 20-screen shortfall in `DEBT-REGISTER.md` |
| 8 | **Theme persists on device and in the account** |
| 9 | **The logo follows the GROUND it sits on, not the theme** |
| 10 | **The onyx role-queue card inverts too** — a LIGHT card on the dark page (intent over appearance) |

---

## `shell` is six jobs wearing one name

Rounds 2–5 got this progressively less wrong. Round 2: two tokens, no component change. Round 3:
three families. Round 4: a sixth job and two miscounts. **Round 5 re-cut the boundary** — `nav-*`
had been bundling two surfaces of OPPOSITE polarity in light mode (the desktop chrome is light, the
phone drawer is onyx), so no single `nav-ink` value could serve both. The drawer moves in with the
role-queue card as `inverse-surface-*`. Still six families; better boundary. All verified:

| Family | Job | Call sites (verified) | Dark behaviour |
|---|---|---|---|
| `--color-nav-*` (ground · ink · ink-soft · ink-dim · active · active-ink) | **the LIGHT chrome only** — desktop nav pill, brand pill, topbar, phone action bar | `Layout.tsx` desktop surfaces, `Fab.tsx` bar | **constant polarity** — always a light ground with dark ink. Ruling #5 makes it lighter than a DARK page; it never flips |
| `--color-inverse-surface-*` (ground + 4-rung ladder) | **every surface deliberately the INVERSE of the page**: the phone drawer **and** the role-queue card | `Layout.tsx` drawer (`surface === 'shell'`), `FeedbackButton.tsx:186-187` (`tone === 'shell'`), `Dashboard.tsx:255-279`; twin at `operator/Overview.tsx:98-120` | **inverts** (#5 + #10) — dark on a light page, light on a dark page. The twin does not; that console is pinned light |
| `--color-on-dark-*` | light ink on a dark ground: auth panels, aurora, **chart tooltip**, **table headers** | `Login.tsx` (7), `AcceptInvite`/`AcceptOperatorInvite` (2+2), `ForgotPassword`/`ResetPassword` (1+1), `charts.tsx:67`, **`index.css:711-712`** (`.table-head`), **`index.css:423,427,440,443` (`.aurora-pane` ground + its two washes)**, **`index.css:1302`** (the legal/document dark ground) | **stable** |
| `--color-scrim` | every dimming sheet | `Layout.tsx:1120`, `ui.tsx:1364` (modal backdrop), `operator/OperatorShell.tsx:212`, **`index.css:1239` (`.product-tour-shield`, `shell 76%`)** | **stable dark** |
| `--color-fixed-onyx` | **onyx as fill/ink on a LIGHT surface** — neither chrome nor a dark ground | **`index.css:495`** (`btn-rainbow` body fill), **`index.css:594`** (`.plan-badge-basic { @apply text-shell }` — onyx lettering on light silver metal) | **stable onyx** |
| pinned elevation | **all seven** `--shadow-*` bases | `index.css:207-234` | explicit base, no longer aliased |

Swap `shell`/`shell-ink` globally and: every auth screen turns dark-on-dark (`Login.tsx:128-129`
records a measured "shell-ink holds 4.83:1" that would become false), the scrim becomes a white wash
over the whole phone screen, the darkest chart colour becomes the lightest
(`index.css:123` — `--color-chart-4: var(--color-shell)`), every card shadow becomes a light glow,
and a premium plan badge's lettering turns pale on a pale gradient.

And the desktop nav does not use these tokens at all: `surface === 'pill'` (`Layout.tsx:616-619`) is
`bg-action` / `text-ink-soft` / `hover:bg-surface-hover`; the nav pill is `bg-surface/90` (`:936`),
the brand pill `bg-surface/85`, the bar `bg-topbar/75`. **Ruling #5 does not reach desktop for free.**

**Two miscounts corrected:**

- **All seven shadows derive from `--color-shell`**, not five: card, card-hover, dashboard, menu,
  fab, toast, dialog. `menu` and `fab` additionally mix `--color-action`. Every recipe is checked.
- **"62 call sites" was wrong, and so is any hand count.** My clean scan gives **82 class references
  plus 33 `var(--color-shell*)` uses**; Codex's scan gave 75 + 34. Two scans, two numbers — which is
  itself the argument. The mapping becomes a runnable manifest (`scripts/check-shell-families.mjs`)
  with a declared scope, and the guard runs it. **No number in this document is an oracle.**

**The sixth job is the one that would have cost an afternoon of confused debugging:** `btn-rainbow`
and `plan-badge-basic` use `shell` / `text-shell` as *fixed onyx on light metal*. Nothing about the
class names says so.

---

## The 34 stock-palette aliases, remapped by ROLE

```
--color-done-*  → emerald-50/100/200/700/800     --color-await-* → amber-*
--color-alert-* → rose-*      --color-info-* → sky-*      --color-idle-* → slate-*
--color-star / -hover → amber-400/300     --color-trend-up-fg / down-fg → rose-700 / emerald-700
```

Count confirmed exactly: 30 status tokens + 2 star + 2 trend. Two corrections to Round 3's framing:

- **"Every chip breaks" was too strong.** Some stay legible; the real failure is that a `-50` wash
  reads as a **bright patch inside a dark UI** — loud, not unreadable.
- **Remap by role, not by Tailwind number.** `fg` and `solid` currently both point at `-700` in
  several families. In dark they must **split**: a foreground can move to `-300`, but `solid` carries
  white text and cannot. Each of the six roles (`wash · line · soft · on-soft · fg · solid`) gets its
  own dark target and its own measurement.

This is the largest single piece of design work in package E, and the guard must accept an alias
(`var(--color-…)`) as a valid dark declaration.

---

## Package A — and the arithmetic that nearly killed it

Round 3 specified a new token by four constraints. Codex checked whether they are **satisfiable**,
which nobody had. Its figures, from the current values:

| Quantity | Relative luminance |
|---|---|
| composited bar (`topbar/75`) | ≈ 0.8613 |
| the camera puck (`--color-action`) | ≈ 0.0401 |
| onyx ink | ≈ 0.0077 |
| **viable fill window** | **≈ 0.2203 – 0.2538** |

A colour does exist — but the window is narrow, and **the foreground must be onyx, not
`action-on-soft`**, which reaches only ≈3.21–3.60:1 against that window and so fails the 4.5:1 text
rule. Round 3 would have specified an unusable foreground.

**Which onyx, precisely (Round 5).** Not a generic `nav-ink`: while the drawer was still inside the
`nav-*` family, `nav-ink` had to be paper for the drawer and onyx for this button at the same time —
impossible. After the re-cut, `nav-*` has **constant polarity** (always a light ground with dark
ink), so this button binds to the light chrome's own ink, with `--color-fixed-onyx` as its floor.
That is also what makes the same foreground valid in **both** themes instead of needing two values.

Two further corrections:

- **A precondition, checked first:** bar-to-puck contrast must be ≥ ~9:1 in the theme being solved.
  Below that **no colour satisfies all constraints**, and the answer is a shape carrier rather than a
  fill. Checked in *both* themes before any value is chosen.
- **One token cannot serve rest and pressed.** Round 3's "measurably different" had no threshold and
  the single token had no second rung. So: **two tokens** (`nav-current`, `nav-current-pressed`) or a
  fill plus a shape carrier, both states independently meeting constraints 1–3, with a declared
  minimum step between them.

**Package A cannot finish before E.** Its dark value, its foreground and its composited bar all come
into existence inside the palette work. It lands as light-theme WIP and is declared done inside E.

---

## Package C — the queue, and three edge cases

The coalescing model is confirmed correct: one write in flight, one stored latest intent,
intermediates dropped, last intent written when the in-flight write settles.

**My test oracle was too narrow.** "The second call always starts after the first settles" holds only
when the first write *succeeds*. Three cases, split:

1. **success-first** — `he → en → he`: the second write starts after the first settles; final DB
   value `he`; no stale toast.
2. **stale-failure** — a superseded write fails: **no toast** (it is no longer the user's intent).
3. **terminal-failure** — the *last* write fails: **toast fires, in the final language**
   (`translateIn(next, …)`, never the closed-over `t`).

And if the first write fails while the latest intent equals what is already stored, **no second write
is needed** — so the queue compares against the persisted value rather than firing blindly.

**The queue is keyed to `profile.id`**, and a profile change or sign-out **resets it and discards any
in-flight result** — otherwise a response for the previous account lands on the next one. The same
queue serves theme persistence (ruling #8), tested `light → dark → light`.

Unchanged from Round 3: a real visible `<select>` with text options and the current flag beside it as
`aria-hidden` (no JSX inside `<option>`, no transparent select behind a fake button); behavioural
contract from `LanguageSetting`, the one true precedent; `Flag.tsx` ported as-is; `DEBT-REGISTER.md`
entry for the 20 screens.

---

## Package E + B

**Gate 0** — the new numbered decision and ADR-0003 land before any palette code.

1. **Split the six families** (above), driven by the manifest script.
2. **Redefine the token guard:** one canonical dark selector; parity set derived **dynamically from
   `@theme`**; aliases accepted as declarations; missing / extra / duplicate declarations rejected.
   `check-design-tokens.ts:225` blanks one `@theme` region and flags every literal in the rest, so
   the dark block fails today — this is a deliberate redefinition, not a widening.
3. **Positive contract for the other two entries.** `operator.html` and `portal.html` ship
   `data-theme="light"` explicitly. Guard assertions: only `index.html` carries the pre-paint
   bootstrap; only `src/main.tsx` imports `AppearanceProvider`; only `appearance.ts` writes
   `data-theme` or reads the theme storage key; both other entries start at `light`; `index.css`
   contains no alternative dark mechanism (`.dark`, `prefers-color-scheme: dark`); a browser check
   opens operator and portal with **OS=dark and localStorage=dark** and proves they stay light; the
   same check proves the tenant resolves `dark` **before first render**.
4. **`src/lib/appearance.ts` + `AppearanceProvider`** — never over this repo's `src/lib/theme.ts`
   (`chartTheme()`). Theme-**keyed** chart cache plus a hook every chart consumer reads (recharts
   writes fill/stroke as SVG presentation attributes, which is why the cache exists); explicit
   remount for the login aurora, a separate consumer reading `chart-1..5` at mount; pre-paint
   `<head>` script; `data-theme-swap` two-frame transition kill (without it, old-theme text sits on
   the new ground for ~⅓ second — measured on the landing page).
5. **Persistence** via the same coalescing queue as C.
6. **The palette** — authored values, the 34-token role-based status remap, nav and inverse-card
   inverting, on-dark / scrim / fixed-onyx stable, all seven shadow bases explicit.
7. **Verification is a route matrix:** all 45 tenant routes × focus, hover, disabled, selected,
   modal, toast, charts, empty, error.
8. **Contrast in two places:** a *static* manifest guard in `verify`; the real computed-style
   measurement in `quality-gate.yml`'s browser job, both themes, with a positive control that must
   fail. A browser gate inside `verify` would silently change what `verify` means — it stands up no
   preview.

### Package B — the mark

| Path | Mechanism |
|---|---|
| Shell mark (desktop pill, phone drawer) | **inline SVG**, taking `currentColor` from the nav ink token |
| Auth panels | **static `<img>`, paper** — dark in both themes |
| PDF / exports (`pdf.ts:84`) | **static ink asset** — draws into a canvas, never sees CSS |
| **Operator console — `OperatorShell.tsx:159` AND `:226`** | **static `/brand/inplace-symbol.svg`** — see below |
| Tenant-uploaded logo | untouched |

**The bug Round 3 would have shipped — and Round 4 half-fixed.** Round 4 cited one call site; there
are **two**: `OperatorShell.tsx:159` (desktop pill) and **`:226` (mobile drawer)**. Replacing only the
first leaves the same failure on the phone. Both change, `layoutShellHeader.spec.tsx:220` (which
asserts the `src`) updates with them, and a guard forbids `/favicon.svg` in any `src/**/*.tsx` so a
future surface cannot reintroduce it. `OperatorShell.tsx:159` renders `<img src="/favicon.svg">`,
and Round 3 gave `favicon.svg` an internal `prefers-color-scheme: dark` swap. The operator console is
**permanently light** — so on a dark-OS machine its mark would have turned paper-white on a light
pill, for no reason any reader could trace. The adaptive favicon is for **browser chrome only** (tab,
bookmarks, installed-app surfaces); every in-page `<img>` uses a **non-adaptive** asset.

**The inline SVG must be decorative.** The desktop bar and the phone drawer coexist in one DOM, so
the shipped `title`/`desc` IDs would be **duplicated**. The inline copy carries
`aria-hidden="true" focusable="false"` and **no IDs**; the accessible name stays on the wrapping
`<Link>`, which already has one (`layoutTail.homeAria`).

**`<mask>` fills are not brand colour.** `inplace-lockup.svg`'s `<mask id="cutouts">` uses `#ffffff`
and `#000000` as alpha control to cut the letter counters. Only the **visible masked group's** fills
change to onyx. A rendered-output visual regression guards this — the failure is silent and
shape-level.

Remaining: `inplace-symbol.svg` and `favicon.svg` to single onyx; regenerate `favicon.ico`; `-paper`
unchanged; `<meta name="theme-color">` updated at runtime from the appearance resolver. Each ground
gets **one measured verdict** — "lighter than the page" is not automatically light enough for an onyx
mark.

### The port — SHAs pinned 31.08.2026

`LANDING-PAGE-NIR` `origin/main` = **`5ace2cc4afd4d2aebd2f3f9d20b6900d8c2396ae`**.

| Blob | Source path |
|---|---|
| `4cfe7ff9d153612596f9c33c2851db1613df6144` | `src/components/ThemeToggle.tsx` |
| `3acee9fcad24d625340f286912d1ef74a6f5b69d` | `src/lib/theme.ts` → **`src/lib/appearance.ts`** here |
| `e3fe41294e9f5afbc87182c64a2ec9e28faa18b6` | `src/components/LanguageSwitcher.tsx` |
| `fda628e1d61159778722b78948fa8afb5ebaa9e4` | `src/components/Flag.tsx` |

The toggle's CSS is not in those files: `src/styles.css` there carries `.theme-toggle*`
(`:2397-2470`), the `--knob` sign flip (`:2411-2412` — `:root { --knob: 1 }` /
`html[dir='rtl'] { --knob: -1 }`) and the `[data-theme-swap]` kill (`:330-332`). All of it crosses
into `src/index.css` under `check:tokens`. Port `ThemeToggle` with its three documented departures:
a real `<button>` (Enter/Space), the **logical** knob translation (physical `translate-x` is not
mirrored by `dir="rtl"` and the knob would leave the pill), and no `cn()`.

---

## Every claim of mine that a critique corrected

| I claimed | Actually | Round |
|---|---|---|
| Tailwind v4.1 | **4.3.3** | 1 |
| Colour lives in one file | Two — `plan-card.css` is exemption #296 | 1 |
| i18n complete | Machinery yes; coverage **24/44** | 1 |
| `loginAurora` shares `chartTheme()`'s ramp | Different tokens, two consumers | 1 |
| Portal/operator out of scope | All three entries import `index.css` | 1 |
| An array column + trigger suits declared currencies | Relationships are tables here | 1 |
| Two `<select>` precedents | **One** | 2 |
| Contrast gate belongs in `verify` | Static in `verify`, measured in CI | 2 |
| Ruling #5 needs no `Layout.tsx` change | `shell` is **six** jobs; desktop nav uses other tokens | 3–4 |
| `bg-action-soft` fixes package A | 1.5 L from its own bar; pressed state equalled rest | 3 |
| `<BrandMark>` can read `currentColor` | Not through `<img>` | 3 |
| "Single ink" = replace every `fill` | `<mask>` fills are alpha control | 3 |
| Serialized writes can complete out of order | Incoherent — coalescing queue | 3 |
| 94 + 7 is the parity oracle | Derive from `@theme` | 3 |
| Five shadows derive from `shell` | **All seven** | 4 |
| 62 shell call sites | 82 classes + 33 CSS uses (mine) vs 75 + 34 (Codex) — **use a manifest** | 4 |
| `action-on-soft` can be A's foreground | ≈3.2–3.6:1 — fails 4.5:1; must be onyx | 4 |
| One new token serves rest and pressed | Two tokens, or a shape carrier | 4 |
| An adaptive favicon is safe everywhere | It flips the mark inside the permanently-light operator console | 4 |
| "Every status chip breaks" in dark | Some stay legible; they read as bright patches | 4 |
| A before E+B is a valid finish order | A's value, foreground and bar are created inside E | 4 |
| `nav-*` can cover the drawer and the desktop chrome | **Opposite polarity in light mode** — the drawer is onyx, the chrome is light. Re-cut: drawer joins the role-queue card as `inverse-surface-*` | 5 |
| A's foreground is a generic `nav-ink` | Only coherent after the re-cut; it binds to the light chrome's ink with `fixed-onyx` as its floor | 5 |
| One `/favicon.svg` call site in the operator console | **Two** — `:159` and `:226` | 5 |
| The scrim manifest is complete | Missing `.product-tour-shield` (`index.css:1239`) — and my own re-scan then found four more unclassified CSS uses (`:423,427,440,443`, `:1302`) that **neither model had listed after five rounds** | 5 |

## Risks / open questions

1. The 34-token role-based remap is design judgement per family, each pair measured (4.5:1 / 3:1).
2. Reclassifying ~115 `shell*` references into six families is wide; a miss shows up as dark-on-dark
   text on a login screen. Driven by the manifest script, measured per family.
3. `bg-topbar/75` composites over whatever scrolls under it while its children read `text-ink*` —
   measured over both the canvas and scrolled content.
4. `EntityMonogram` recomputes contrast from `index.css` in its own spec
   (`entityMonogram.spec.tsx:15,40`).
5. Screenshot traps here: headless misses injected CSS; recharts is absent from the DOM until
   scrolled into view and needs `reducedMotion: 'reduce'`.
6. `index.css:1470` forces `.table-head .th { color: black !important }` for print — verify it still
   wins once that token moves to `on-dark`.

## Out of scope

- **The currency picker — withdrawn; #305 stands.**
- Locales beyond `he`/`en`; the operator console and public portal going dark (positively excluded);
  reversing exemption #296; app/maskable/PNG icons; the marketing site.

## Order

**`C` → `E+B` → `A`'s completion.**

Corrected from Round 3: A cannot be a finished package before E, because its value, its foreground
and its composited bar are all created inside the palette work. C is the only package with no
dependency on the palette. A's light-theme measurement can land early as WIP; it is **declared done
only inside the E wave**.

---

## State of the review — read this before approving

**Five rounds ran; the cap is five. Codex's final verdict was `REVISE`, not `APPROVED`.**

That verdict is accurate and I am not dressing it up. What it means concretely:

- **The four round-5 findings are real, I verified each one in the repo, and I accepted all four.**
  They are folded into the text above.
- **This revision has not been re-reviewed.** Everything above dated Round 5 — the family re-cut,
  Package A's foreground binding, both operator favicon call sites, the scrim additions — is
  unreviewed work.
- **No round produced a disagreement.** Across five rounds I overruled Codex exactly once (Round 1,
  rejecting its "union of observed and declared currencies" fix in favour of escalating the #305
  conflict to the owner), and it confirmed that call in Round 2. Everything else it found was right.
  So this is a **cap-out, not a deadlock**: there is no open dispute for the owner to break.
- **The trend is the argument for stopping here.** Rounds 1–4 found defects that would have produced
  wrong behaviour (a deleted package, an invisible button, an impossible mechanism, a shipped bug).
  Round 5's findings are of the same class but narrower, and its own summary says Package C is
  implementable exactly as written. The remaining risk is concentrated in one place, and it is
  structural rather than unknown:

> **My hand-enumeration of `shell` call sites has been wrong in every single round, and after five
> rounds and two independent models it was still incomplete** — I found four more CSS sites while
> verifying round 5. This is why `scripts/check-shell-families.mjs` is a deliverable and not a
> convenience: **it must fail on any unclassified `shell` reference**, so the classification is
> enforced by execution rather than by anyone's reading. That guard is the precondition for the
> palette work, not a follow-up to it.

**Recommendation:** implement `C` now — it is the one package with no palette dependency, Codex
confirmed it implementable, and its contract is fully specified. Begin `E+B` at Gate 0 (the decision
record and ADR-0003) followed immediately by the manifest guard, and treat the guard's first run as
the real inventory. `A` completes inside the E wave.
