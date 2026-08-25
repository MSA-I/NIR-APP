# Gates: Apple joins the federated door, and the login screen stops lying

Branch: `feat/oauth-google-apple` · PR [#119](https://github.com/MSA-I/NIR-APP/pull/119)

OWNS: src/lib/authProviders.ts, src/pages/Login.tsx, src/pages/Login.spec.tsx, src/pages/Signup.tsx,
src/pages/signup.spec.tsx, supabase/config.toml, supabase/functions/public-signup/index.ts,
supabase/functions/_shared/provision.test.ts, .github/workflows/quality-gate.yml,
docs/INTEGRATIONS-SETUP.md §7, docs/OPEN-DECISIONS.md #268–#270, docs/PROGRESS.md, GATES.md

## What the task turned out to be

The plan assumed Google sign-up did not exist. That was true of the stale branch it was written
from and false of `main`: `#265` decided it on 24.08.2026 and it was already implemented. The real
work was smaller and different — Apple, a dead button, and a bug only a live sign-in could find.

---

## Acceptance gates

| # | Gate | Evidence | State |
|---|---|---|---|
| G1 | The login screen no longer shows a button that does nothing | `Login.spec.tsx` — an unconfigured provider draws no button and no orphan "או" divider | **PASS** |
| G2 | A configured provider hands off, and never signs anyone in with a password | `Login.spec.tsx` — `startFederatedSignup('google')` called, `signIn` not called | **PASS** |
| G3 | Both screens agree on which providers exist and where the browser returns | one module, `src/lib/authProviders.ts`, imported by both | **PASS** |
| G4 | The Edge branch accepts Apple, and the token decides the provider — not the body | `identity_provider_mismatch` when `app_metadata.provider` differs from `identity` | **PASS** (typecheck + read; no unit test — see gap) |
| G5 | Adding Apple needed no migration | `0205`'s guard is `<> 'email'`; `service_identity_has_profile` is provider-blind | **PASS** |
| G6 | Adoption rollback never deletes the pre-existing auth account | Deno test: org/categories/subscription deleted, `deleteUser` never called | **PASS** |
| G7 | Adoption keys the owner profile by the handed id, role `owner`, no caller-selected status/plan/VAT | Deno test | **PASS** |
| G8 | The signup screen sends the provider the token declares | `signup.spec.tsx` — `identity=apple` for an Apple session | **PASS** |
| G9 | An Apple Private Relay address is shown as-is, not rewritten | `signup.spec.tsx` | **PASS** |
| G10 | Google sign-in works end to end against the local stack | real Google account: one org, one `owner` profile, `plan_key=free` (#165), category `כללי`, `product_events` `signup.completed {"identity":"google"}` | **PASS** |
| G11 | A returning identity lands in the product, not on a form asking for a second business | headed run: signed-in demo owner visits `/signup` → `/dashboard`, no business-name field. Two unit tests pin both directions | **PASS** (bug found here, then fixed) |
| G12 | `npm run build` green | build + typecheck | **PASS** |
| G13 | `npm run verify` green | Knip, 6 guards, **1,527 tests / 151 files** | **PASS** |
| G14 | Deno `_shared/provision.test.ts` green | **9 passed / 0 failed** | **PASS** |
| G15 | `public-signup/index.ts` typechecks after the edit | `deno check` clean, scratchpad config so the frozen `deno.lock` was untouched | **PASS** |
| G16 | The new Deno tests actually run in CI | added `provision.test.ts` to the quality gate's edge job — it was **not** in the list before | **PASS** |
| G17 | Production Supabase serves the Google provider | `external_google_enabled=true`, `/signup` in `uri_allow_list` for both hosts, `/auth/v1/authorize` → Google's sign-in page, not `invalid_client` | **PASS** |
| G18 | `0205`'s guards are live in production **before** the provider was enabled | `accept_invitation` contains `invite_requires_password_identity`; both functions exist | **PASS** |
| G19 | Decisions and setup written down | `#268` login hand-off · `#269` Apple · `#270` Private Relay (open) · `PROGRESS.md` · `INTEGRATIONS-SETUP.md §7` | **PASS** |

---

## Not claimable, and why

- `ABANDON: live-apple-verification` — no Apple Developer Program membership, therefore no Service
  ID and no signing key. The Apple path has **never** been exercised. Status `NEVER_EXERCISED`,
  which is weaker than Google's former `PROVIDER_NOT_CONFIGURED`.
- `BLOCKED: production-frontend` — the live site shows no button, because its build carries no
  `VITE_GOOGLE_SIGNUP_ENABLED`. Owner asked for PR + green CI only; no merge, no build, no deploy.
- `OPEN: #270` — what to do with an Apple Private Relay address. The implemented default accepts it
  as-is; a relay address dies when the person revokes access, leaving an organization with no owner
  email channel. Recorded as open rather than settled quietly in code.

## Known coverage gap, pre-existing and now depended on

`supabase/functions/public-signup/index.ts` has **no unit test and no CI typecheck** — no workflow
and no gate script references it. The new provider-match guard rests on a local `deno check` and on
reading. Closing it means extracting the handler from `Deno.serve`, which is a larger change.
