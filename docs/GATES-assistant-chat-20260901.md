# Gates — the assistant becomes a card, and five measured defects stop being measured

Execution branch: `claude/assistant-chat-redesign-bc661abd`, cut from `bc661abd`.
Kept out of `GATES.md` on purpose: that file is the currency-tolerances campaign's ledger and is
still the live record of it.

## Owner rulings, 01.09.2026

1. **A faithful copy of the 21st.dev `ai-chat` reference, dark card included.** Asked with the
   `CLAUDE.md` design ban on glassmorphism and heavy animation quoted back verbatim, and with the
   app's light palette named; the owner chose the faithful copy anyway. **This is a named
   exception, recorded here and in `DESIGN.md` — not a silent drift.** `DESIGN.md:700` bans a
   gradient on this surface in the same breath as an avatar and typing theatre; the gradient half
   of that line is what this ruling overrides, and nothing else in it moves.
2. **A floating card**, not the full-height docked column. Mobile stays full screen.
3. **Long answers collapse inside the bubble**, with a „הצג עוד" / „הצג פחות" control.
4. **All five audited defects are in scope**, including making a suggested question send on the
   first click.
5. **No emoji anywhere on the surface.** The reference's robot and waving-hand emoji do not travel.
6. **The glass is bought at 8%.** The card is 92% opaque with a 20px backdrop blur — the
   reference's own `bg-black/90`, kept at the opacity where the composited contrast still clears
   AA with room. This is the one `backdrop-filter` in the product and it is allowed by name.

## Evidence baseline — measured, not assumed

Live local app on `:5209`, demo owner, the assistant Edge intercepted with a fixed answer so the
measurement is of the interface and not of a model. Screenshots in `.tmp/audit/shots/`.

| id | defect | measurement before |
|---|---|---|
| B1 | the composer placeholder prints a raw translation key | `assistantDialog.exampleWhatNeedsAttention` rendered as visible text; wraps to two lines at 390px and collides with the send button |
| B2 | the thread never scrolls to the newest answer | `scrollTop=0`, `scrollHeight=2426`, `clientHeight=656` after three turns |
| B3 | one answer is taller than the whole thread viewport | `785px` of answer in a `656px` viewport, with no way to collapse it |
| B4 | the composer is `disabled` mid-run, so focus leaves the panel | `document.activeElement === BODY` 200ms after submit |
| B5 | a suggested question only fills the box | `askCount === 0` after one click on a suggestion |

## Gates

Run: `.tmp/audit/gates.mjs` against `:5209`, Edge, 01.09.2026. Shots in `.tmp/audit/gate-shots/`.

| gate | statement | measured result | status |
|---|---|---|---|
| G1 | the placeholder is the question, never the key | `placeholder = "מה דורש טיפול עכשיו?"`, no `assistantDialog.` prefix | **PASS** |
| G2 | after three questions the newest turn is inside the scrollport | newest turn ends at 442px in a 458px port (`scrollTop 846/1304`) | **PASS** |
| G3 | a long answer is clamped, expandable, and collapsible again | collapsed 260px → expanded 777px → back to 260px | **PASS** |
| G4 | focus stays inside the panel while a run is in flight | `activeElement` inside `#inplace-assistant-panel` = true | **PASS** |
| G5 | one click on a suggestion sends it | `askCount=1`, question sent = the suggestion's own text | **PASS** |
| G6 | a floating card on desktop, full screen on mobile | 384×640 inside 1440×900; 390×844 on a 390×844 viewport | **PASS** |
| G7 | no emoji on the surface | `Extended_Pictographic` scan of the four assistant files: zero | **PASS** |
| G8 | every colour arrives through a token | `check:tokens` green, alongside typography, i18n, plurals, orphan-keys, jsx-space, money, key-manifest | **PASS** |
| G9 | the repo's own gates stay green | `npm run build` green; `npm run verify` green except four timeouts | **PASS, with the note below** |
| G10 | text on the dark card meets AA | dim text `oklch(0.73 0.016 80)` on the **composited** card `rgb(31,44,50)` (paint at 92% alpha over the canvas) = **6.0:1** | **PASS** |

**G9's note, stated rather than hidden.** The full `verify` run reported four failures —
`p2Reliability.spec.ts`, `workbook.spec.ts` and two neighbours — all of them `Test timed out in
5000ms`, with an environment time of 1,033s for the run. Re-run on their own on the same tree they
pass (`2 files, 9 tests`). None of them import anything this branch touches. This is the CPU-load
flakiness already recorded for this machine, not a regression — but it is written here because a
green summary that quietly dropped four reds would be the exact failure this file exists to catch.

**What is NOT covered by a unit test, and why.** The clamp cannot be proven in jsdom: nothing is
laid out there, so `scrollHeight` and `clientHeight` are both zero and every answer "fits". G3 is
therefore a live-browser measurement and has no Vitest twin. B1 and B5 do have unit tests, added to
`assistantPanel.spec.tsx` in this branch.

`ABANDON:` lines belong here, with the reason, if a gate is dropped.
