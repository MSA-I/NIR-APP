# Gates: Apple joins the federated door, and the login screen stops lying

Branch: `feat/oauth-google-apple` (cut from `origin/main` @ 562e515)

OWNS: src/lib/authProviders.ts, src/pages/Login.tsx, src/pages/Login.spec.tsx, src/pages/Signup.tsx,
src/pages/signup.spec.tsx, supabase/config.toml, supabase/functions/public-signup/index.ts,
supabase/functions/_shared/provision.test.ts, .github/workflows/quality-gate.yml,
docs/INTEGRATIONS-SETUP.md, GATES.md

DOES NOT OWN — another agent is editing these live (assistant activation, #266): docs/PROGRESS.md,
docs/OPEN-DECISIONS.md, docs/DEBT-REGISTER.md, docs/ASSISTANT.md,
docs/ASSISTANT-ACTIVATION-EVIDENCE.md

## What the task turned out to be

The plan assumed Google sign-up did not exist. That was true of the stale branch it was written
from and false of `main`: `#265` decided it on 24.08.2026 and it is fully implemented
(`0205`, `public-signup`'s federated branch, `adoptExistingUserAsOwner`, `Signup.tsx`), waiting only
on credentials. The real work was therefore smaller and different — Apple, and a dead button.

---

## Acceptance gates

| # | Gate | Evidence | State |
|---|---|---|---|
| G1 | The login screen no longer shows a button that does nothing | `Login.spec.tsx` — unconfigured provider draws no button and no orphan "או" divider | **PASS** |
| G2 | A configured provider on the login screen hands off, and never signs anyone in with a password | `Login.spec.tsx` — `startFederatedSignup('google')` called, `signIn` not called | **PASS** |
| G3 | Both screens agree on which providers exist and where the browser returns | one module, `src/lib/authProviders.ts`; both screens import it | **PASS** |
| G4 | The federated Edge branch accepts Apple, and the token decides the provider — not the request body | `identity_provider_mismatch` refusal when `app_metadata.provider` differs from `identity` | **PASS** (typecheck; no unit test — see gap) |
| G5 | Adding Apple needed no migration | `0205`'s guard is `<> 'email'`, not `= 'google'`; `service_identity_has_profile` is provider-blind | **PASS** (read) |
| G6 | Adoption rollback never deletes the pre-existing auth account | new Deno test: org/categories/subscription deleted, `deleteUser` never called | **PASS** |
| G7 | Adoption keys the owner profile by the handed id, role `owner`, no caller-selected status/plan/VAT | new Deno test | **PASS** |
| G8 | The signup screen sends the provider the token declares | `signup.spec.tsx` — `identity=apple` for an Apple session | **PASS** |
| G9 | An Apple Private Relay address is shown as-is, not rewritten | `signup.spec.tsx` | **PASS** |
| G10 | `npm run build` green | build + typecheck, 12.09s | **PASS** |
| G11 | `npm run verify` green | Knip, 6 guards, **1525 tests / 151 files** | **PASS** |
| G12 | Deno `_shared/provision.test.ts` green | **9 passed / 0 failed** | **PASS** |
| G13 | `public-signup/index.ts` typechecks after the edit | `deno check` clean, run with a scratchpad config so the frozen `deno.lock` was not touched | **PASS** |
| G14 | The new Deno tests actually run in CI | added `provision.test.ts` to `quality-gate.yml`'s edge job — it was **not** in the list before | **PASS** |
| G15 | Setup and operational facts documented | `docs/INTEGRATIONS-SETUP.md §7` | **PASS** |

---

## Not claimable, and why

- `ABANDON: live-google-verification` — no `client_id`/`secret`. Nothing in this branch has spoken
  to Google. `#265`'s own status line already said `PROVIDER_NOT_CONFIGURED`; that has not changed.
- `ABANDON: live-apple-verification` — no Apple Developer Program membership, therefore no Service
  ID and no `.p8` signing key. The Apple path has **never been exercised end to end**, and its
  status is `NEVER_EXERCISED`, which is weaker than Google's.
- `BLOCKED: open-decision-267` — Apple needs its own owner decision entry, mirroring `#265`, plus
  a ruling on Private Relay. `docs/OPEN-DECISIONS.md` is being edited by another agent right now,
  so writing into it would collide. Held deliberately.
- No headed screenshots. With both providers disabled the buttons do not render, so there is
  nothing new to photograph. Screenshots belong to the run that has credentials.

## Known coverage gap, pre-existing and now depended on

`supabase/functions/public-signup/index.ts` has **no unit test and no CI typecheck** — it is not
referenced by any workflow or by `check-quality-gates.ps1`. The new provider-match guard therefore
rests on a local `deno check` and on reading. Closing it means extracting the handler from
`Deno.serve`, which is a larger change than this one.
