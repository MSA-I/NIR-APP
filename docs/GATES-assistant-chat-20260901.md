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

## Round two — the assistant's own answers (owner report, same day)

The first round fixed the panel. The owner then said the bugs he meant were inside the assistant:
a strange answer when it does not know, and the wrong language in both directions. **He was right,
and the interface was not where any of it lived.** Five live runs against production, one owner
test account, three question/interface combinations — `.tmp/audit/language-probe.json`:

| id | interface | asked in | answered in | shape |
|---|---|---|---|---|
| A | he | English | **Hebrew** | 1 sentence + 4 claim blocks |
| B | en | English | **Hebrew** | 1 sentence + 4 claim blocks |
| C | en | Hebrew | Hebrew | 1 sentence + 4 claim blocks |
| D | he | Hebrew | Hebrew | named refusal |
| E | en | English | **Hebrew** | named refusal |

| id | defect | measurement |
|---|---|---|
| B6 | the answer is always Hebrew, whatever the interface asks for | 5/5 Hebrew; runs B and E asked for English explicitly and were ignored |
| B7 | claim blocks arrive as bare numerals | one answer's four claim texts were `"3"`, `"500"`, `"390"`, `"246.6"` — the panel draws four cards each carrying a number and no sentence |
| B8 | the same question is classified differently between runs | A returned `no_answer_reason: null`, B returned `not_measured`, for the same question |
| B9 | the evidence stays Hebrew for an English reader | 8 Hebrew fact labels and 4 Hebrew source labels inside run B |

**Owner rulings on round two.** The answer speaks **the language of the question**, not of the
interface. Every reader-visible tool string moves to the dictionaries — all of them, now.

**The causal claim, stated as a hypothesis and then measured.** B9 is the likeliest cause of B6:
the instruction said "Answer in English" while every label, failure and warning the model read was
Hebrew, and an instruction that contradicts its own context is a wish. Both were fixed together, so
the live re-probe (G16) is what decides whether that reading was right.

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

## Round-two gates

| gate | statement | measured result | status |
|---|---|---|---|
| G11 | the run's language comes from the question, and the interface is only the fallback | `answer-locale.test.ts`, 3 cases: a Hebrew question under `en`, an English question under `he`, and a Hebrew question carrying Latin supplier names and `ILS` | **PASS** |
| G12 | a claim whose text is a bare numeral is refused | `validate.test.ts` rejects `"12"`, `"246.6"`, `"12%"`, `"₪12"`, `" 12 "` with `claim_text_is_not_a_sentence`, and accepts a sentence in either language | **PASS** |
| G13 | no reader-visible Hebrew literal is left in any tool | `.tmp/audit/label-census.mjs`: **0** label lines, down from 100. 178 keys moved into both dictionaries, at parity | **PASS** |
| G14 | the guards see an Edge call site as a call site | `check:orphan-keys` and `check:key-manifest` extended to scan `supabase/functions`; both pass **with their pins unmoved** (129 / 130) | **PASS** |
| G15 | the Edge function's own suite stays green | `deno test` over `supabase/functions/assistant/**`: **72 passed, 0 failed** | **PASS** |
| G16 | the live assistant answers an English question in English, in sentences | **NOT RUN — needs a production deploy of the `assistant` function** | `PENDING` |

**G16 is the one that matters and it is not green yet.** Everything above is measured on this
tree; the defects were measured in production. The fix is in an Edge function, and an Edge
function does not deploy with a merge — `CLAUDE.md`'s rollout matrix says so, and `DEBT §OCR`
records what silent version skew costs. Until `assistant` is redeployed and the five-case probe
re-run, the claim "the language bug is fixed" rests on a hypothesis, not on a measurement.

`ABANDON:` lines belong here, with the reason, if a gate is dropped.
