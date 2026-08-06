# handoff 09 — notification preferences · search type gate · transitions & approval policy

**Produced by:** `agent-db` of wave 9 (PLAN-10) · **branch:** `wave9/five-domains` · **migrations:** `0068`–`0070`
**Consumers:** `agent-client` of this wave (`PushSettings.tsx`, `GlobalSearch.tsx`, `InvoiceDetail.tsx`,
`src/lib/notifications.ts`, `src/lib/query/keys.ts`) · any later wave that wants an approval policy consumer.
**Status:** every signature, error code and semantic below is FINAL for this wave. `0071`–`0072` stay
allocated and unused (OPEN-DECISIONS #103) — a migration number is not a quota.

**Scope ruling this contract obeys (PLAN-10 §1):** three tiers. Notification preferences and the
search type gate WORK end-to-end. The approval policy is schema + evaluator with **zero consumers**,
declared out loud. Workflow engines and report jobs are DEFERRED, with reasons, in #103.

---

## 1. `public.notification_preferences` (0068)

One row per `(org_id, user_id, event_code)`. **An absent row means today's behaviour, byte-for-byte**
— delivery proceeds. The default is opt-**in**; nothing in this wave changes what an existing
installation delivers until a user actively stores a preference.

| column | type | contract |
|---|---|---|
| `id` | uuid pk | surrogate identity, so `audit_row_change` has an `entity_id` to record |
| `org_id` | uuid NOT NULL → organizations | tenant |
| `user_id` | uuid NOT NULL → profiles, `on delete cascade` | the recipient; a preference dies with the profile |
| `event_code` | text NOT NULL | member of `private.notification_event_definitions` (below) |
| `push_enabled` | boolean NOT NULL default `true` | `false` suppresses **Web Push only** |
| `inapp_enabled` | boolean NOT NULL default `true` | `false` suppresses the in-app notification row |
| `created_at` / `updated_at` | timestamptz | `updated_at` maintained by the `set_updated_at()` trigger |

`unique (org_id, user_id, event_code)`.
**ACL — Shape-1**, exactly the `org_flag_configurations` contract: one permissive SELECT policy
(`org_id = auth_org() and user_id = auth.uid()`) and a matching `grant select to authenticated`.
**No browser INSERT/UPDATE/DELETE.** Writes go through the RPC only. `audit_row_change` is attached.
Scope registry: `org_global` / `enforced = false`.

### 1.1 The delivery law — read this before touching the client

**A preference FILTERS delivery. It never creates delivery, and it never widens the audience.**

* The audience is decided in **one authoritative place**: the `eligible` CTE of
  `public.enqueue_notification_delivery` (`0024:96-102`) — active profiles of the tenant whose role is
  `owner` or `office`. 0068 **narrows** that CTE with the preference; it does not touch the role list.
* **`push_enabled = false` removes Push and LEAVES the `notifications` row.** This is not a taste
  call: the unread-badge contract of OPEN-DECISIONS #39 is the bell count over `notifications`, so
  deleting the row to silence a phone would silently break the badge. Opting out of Push means "do
  not buzz my phone", never "hide this from the bell".
  *Mechanically:* the row is inserted with `push_sent_at = now()` — the Push leg is **settled** at
  insert time rather than left pending. `0024:11-15` already uses the column with exactly that
  meaning for pre-outbox rows. Without it, an opted-out row would sit in
  `notifications_push_pending_idx` forever and be re-offered on every retry. `push_attempts = 0`
  alongside a non-null `push_sent_at` is how "settled by preference" is told apart from "delivered".
* **`inapp_enabled = false` is the one that removes the `notifications` row** — and therefore also
  removes Push for that event, because Push rides on the notification row (the row *is* the durable
  outbox, `0024:1-9`). There is no state in which Push is delivered without a notification row.
* A preference row for a user who is **not** in the eligible audience changes nothing. It cannot add
  a recipient. (`ENTERPRISE-SECURITY-MODEL.md:246` by analogy: a configuration surface may tighten,
  never grant.)

Consequence for the client: after an opt-out of Push, the bell **still** increments. That is correct
and must not be "fixed" in the UI.

### 1.2 The event-code catalog — `private.notification_event_definitions`

Platform vocabulary, `private` schema, no `org_id`, therefore **no `scope_registry` row** (the
`0059:21-23` note: A1 scans public base tables only). Not readable by the browser directly; it
reaches the client only through `read_notification_preferences()`.

| `event_code` | what fires it | today's target |
|---|---|---|
| `price_increase` | the `supplier_products` price trigger (`0017:120`) → `send-push` | `/prices` |
| `duplicate_invoice` | the identifying-field triggers on invoices (`0017:213-219`) → `send-push` | `/invoices` |
| `payment_due` | the daily `pg_cron` due scan (`send-push`, `payment_due_scan`) | `/payment-requests` |

These three are the complete live set. `set_notification_preference` **rejects** any other code
(`notification_event_unknown`), so the reader below is complete by construction and the UI never has
to guess. A new event code is a new seed row in `0068`'s catalog, not a client change.

### 1.3 `set_notification_preference` — the write command

```sql
set_notification_preference(
  p_event_code    text,
  p_push_enabled  boolean,
  p_inapp_enabled boolean
) returns jsonb
```

* `SECURITY DEFINER`, `authenticated` only (`revoke all from public, anon`).
* **Self only.** The row is written for `auth.uid()` inside `auth_org()`. There is deliberately **no
  `p_user_id` parameter** — an owner adjusting somebody else's notifications is a different decision
  with a different audit story, and it is not in this wave.
* **Systemic reason.** There is no `p_reason` parameter. The command writes its own audit row
  (`action = 'notification_preference_set'`, `entity_type = 'notification_preferences'`) with a fixed
  systemic reason, in the same transaction, plus the generic `audit_row_change` row. Do not prompt
  the user for a reason.
* Upsert on `(org_id, user_id, event_code)`. Calling it twice with the same values is a normal
  successful write (the row's `updated_at` moves); it is not an error.

**Return payload**

```json
{ "preference_id": "uuid", "event_code": "payment_due",
  "push_enabled": false, "inapp_enabled": true, "created": true }
```

`created` is `true` when this call inserted the row, `false` when it updated an existing one.

**Errors** (all reach the user through `toHebrewError` — add mappings for the first three):

| code | SQLSTATE | when |
|---|---|---|
| `notification_preference_not_authorized` | `42501` | no `auth.uid()` or no `auth_org()` |
| `notification_preference_invalid` | `22023` | blank `p_event_code`, or either boolean is NULL |
| `notification_event_unknown` | `P0002` | `p_event_code` is not in the catalog (§1.2) |

### 1.4 `read_notification_preferences` — the read surface

```sql
read_notification_preferences() returns table (
  event_code    text,
  push_enabled  boolean,
  inapp_enabled boolean,
  configured    boolean
)
```

* `SECURITY DEFINER`, `stable`, `authenticated` only — definer for the same reason
  `resolve_feature_flags()` is (`0059:206`): the catalog lives in `private`. The body pins
  `user_id = auth.uid() and org_id = auth_org()`; it can return no one else's preferences.
* **Returns one row per catalogued event code**, always the full set, in `event_code` order. Where the
  user has no stored row, `push_enabled` and `inapp_enabled` come back `true` and
  `configured = false`.
* `configured` exists so the UI can say "default" versus "you chose this" without inferring it from
  the booleans. It is display information, never a permission.

**Client shape:** the matrix is `read_notification_preferences()` rows × two toggles. Hebrew labels
for the three codes are the client's (`src/lib/status.ts` neighbourhood); the server ships codes, not
copy. Toggle target ≥44px, `aria-checked`, tokens only — as usual.

### 1.5 The three mirrors of the audience line

The audience existed in three places and two of them were stale prose. All three are corrected in
this wave, in this order of authority:

1. **`supabase/migrations/0024:96-102`** — the `eligible` CTE. **Authoritative.** 0068 extends it with
   the preference filter and nothing else.
2. **`supabase/functions/send-push/index.ts:46`** (`ALERT_ROLES`) — a Deno-side copy of the role list.
   Corrected to say out loud that it is a mirror, that the database is the authority, and that
   preference filtering happens in the database and must **not** be re-implemented here.
3. **`supabase/functions/send-push/index.ts:398`** — the `payment_due_scan` org-discovery query. It
   uses `ALERT_ROLES` to find which organizations have any eligible recipient at all. Corrected to
   state that this is a **coarse org filter**, deliberately *not* preference-aware: an organization
   where everybody muted Push must still get its notification rows (the #39 badge), and the
   per-recipient decision belongs to the database.

**No new Edge Function and no fourth cron job.** `send-push`'s delivery cycle
(`claim_notification_event` → `enqueue_notification_delivery` → `record_notification_push_result`) is
unchanged.

---

## 2. `global_search` — the type gate moves to the server (0069)

**The problem being fixed:** `global_search` is granted to `authenticated` as a whole, and the only
thing stopping a `payer` or `supplier` from receiving supplier/product/payment hits was
`ALLOWED` in `src/components/GlobalSearch.tsx:28-34` — a client-side table. RLS decides which *rows*
exist; the route guards in `App.tsx` are stricter than RLS about which *screens* exist, so a hit
whose target the caller may not open should never have crossed the wire.

**What changed:** `global_search(q text, per_type int default 5)` is re-declared from its live
definition with a branch-selection predicate driven by `auth_role()`. Everything else is
byte-identical: `SECURITY INVOKER`, `limit 30`, the six branches, the `per_type` default, the `'#'`
prefix strip, the LIKE-wildcard neutralisation, the trigram indexes. **Replacing `pg_trgm` is
forbidden** in this wave — that needs measurement (wave 10).

**The server map** — identical to the client's `ALLOWED`, because both are derived from the same
`App.tsx` guards:

| role | reachable result types | derived from |
|---|---|---|
| `owner` | `supplier` `product` `invoice` `order` `payment` `credit` | all routes |
| `office` | `supplier` `product` `invoice` `order` `credit` | `/payments` is `['owner','accountant']` |
| `kitchen` | `supplier` `product` `invoice` `order` `credit` | same |
| `accountant` | `invoice` `payment` `credit` | `/suppliers` `/products` `/orders` are `STAFF` |
| `payer` | **none — zero rows of any type** | payer's only route is `/pay` |
| `supplier` | **none — zero rows of any type** | supplier has no search target |

A caller with no resolvable role gets zero rows (fail closed).

**Client consequences**

* `ALLOWED` **stops being a gate and becomes a display-order map.** Keep it — `GROUP_ORDER` and the
  group headings still need it — but its security role is gone. Say so in the comment; do not delete
  the constant and do not start trusting the server for ordering.
* `canGlobalSearch(role)` is unchanged and still correct: `payer`/`supplier` get no search box, and
  now the server would return nothing even if one appeared.
* **Zero UX change for anybody who can see everything.** An `owner` sees exactly what they saw.
* The browser scenario to add: a `payer` session calling the RPC directly receives an empty set.

---

## 3. `read_allowed_transitions` — one source of truth for status graphs (0070)

```sql
read_allowed_transitions(p_entity_type text, p_current_status text)
  returns table (next_status text)
```

* `SECURITY INVOKER`, `stable`, granted to `authenticated`. It returns **data**, never a decision:
  it reports which next statuses the live command would accept from `p_current_status`. It does
  **not** say whether *this caller* may perform them — role authorisation stays inside the commands,
  where it already is.
* The set is unordered by contract. Order it in the client with the existing vocabularies in
  `src/lib/status.ts`; do not depend on row order.
* A self-transition is never returned: every command treats "already in that status" as an
  idempotent success, not a transition.
* Unknown `p_entity_type` raises `allowed_transitions_entity_unknown` / `P0002`. An unrecognised or
  terminal `p_current_status` returns **zero rows** — a legitimate answer, not an error.

**`p_entity_type` vocabulary and the matrices** (each mirrors the live command exactly, and
`p9_five_domains.sql` proves it by probing the real command for every ordered pair):

| `p_entity_type` | live command | matrix |
|---|---|---|
| `invoice_review` | `set_invoice_review_status` (`0023:1926-1931`) | `received` → `in_review`, `investigation` · `in_review` → `pending_approval`, `approved`, `investigation` · `pending_approval` → `approved`, `investigation` · `approved` → `investigation` · `investigation` → `pending_approval` |
| `payment_request` | `transition_payment_request` (`0031:877-883`) | `draft` → `pending_approval`, `investigation`, `cancelled` · `pending_approval` → `approved`, `investigation`, `cancelled` · `suspected_duplicate` → `approved`, `investigation`, `cancelled` · `investigation` → `approved`, `cancelled` · `approved` → `sent_for_execution`, `cancelled` · `sent_for_execution` → `cancelled` · `executed`, `matched`, `cancelled` → none |
| `credit_request` | `transition_credit_request` (`0024:327-331`) | `open` → `requested`, `received` · `requested` → `received` · `received` → `offset` · `offset` → `closed` · `closed` → none |
| `purchase_order` | `transition_purchase_order_status` (`0041:75-81`) | `draft` → `ready`, `sent` · `ready` → `sent` · `sent` → `confirmed` · `confirmed`, `partial`, `received`, `cancelled` → none |

**Two honesty notes the client must carry:**

1. **`payment_request` → `approved` passes the matrix but can still fail** on the approval
   preconditions inside `transition_payment_request` (linked invoices must exist and be approved).
   The reader answers "the graph allows it", not "it will succeed". Keep showing the server error.
2. **Purchase-order cancellation is NOT in this matrix.** Cancellation is its own command,
   `cancel_purchase_order()`; the reader describes the transition command's graph only.

### 3.1 The one visible client change — OPEN-DECISIONS #105

`src/pages/InvoiceDetail.tsx:142-147` carries a **local copy** of the invoice matrix, and it has
drifted from the server. Replacing it with `read_allowed_transitions('invoice_review', status)`
produces exactly one behavioural difference:

> **`approved` → `investigation` becomes available in the UI.**

The server has allowed it since `0023` (the wildcard arm: any status other than `investigation` may
move *to* `investigation`) — and it is the right behaviour, because discovering a problem in an
already-approved invoice is precisely when an investigation is needed. The browser was simply
hiding a legal, reasoned, audited transition. This is the intended outcome, documented in #105, and
it is the only visible change. Anything else that appears or disappears is a bug — report it.

---

## 4. `evaluate_approval_policy` — schema + evaluator, ZERO consumers (0070)

**Do not wire this to anything.** Not from a screen, not from a command, not from a policy.

The reason is written into the migration header and repeated here: wiring an approval policy into
`transition_payment_request` or `set_invoice_review_status` would silently re-decide
**OPEN-DECISIONS #2 — who may approve money.** That is a business decision that has not been made,
and a wave that quietly makes it in code is exactly the failure mode this campaign keeps catching.
The precedent is wave 7 (interfaces + mocks, zero importers, declared in the file header).

**Shape** — the `flag_definitions` + `org_flag_configurations` split (`0059:24` / `0059:45`):

* `private.approval_policy_definitions` — platform vocabulary (`policy_key` pk, description,
  `baseline_required_approvals`, `baseline_step_up_required`). No `org_id`, no registry row.
* `public.approval_policy_configurations` — per-organization configuration, Shape-1
  (permissive SELECT for the tenant, `grant select to authenticated`, no browser DML),
  `audit_row_change`, registry `org_global` / `enforced = false`, `unique (org_id, policy_key)`.
  **No FK to the private definitions on purpose** (the `0059:66-68` reasoning): an orphan must
  surface as a preflight anomaly (`approval_policy_config_without_definition`), not as a broken
  cascade when a definition retires.
* One reasoned write command, mirroring `platform_set_org_flag` (#86: platform operator, not the
  owner, in this wave): `platform_set_approval_policy(p_org_id, p_policy_key, p_threshold_amount,
  p_required_approvals, p_step_up_required, p_reason) returns uuid`. Platform admin + mandatory
  reason + audit to the target org, in one transaction.

**The tighten-only law — OPEN-DECISIONS #104.** A configuration may only make a decision *stricter*
than the definition's baseline: `required_approvals >= baseline_required_approvals`, and
`step_up_required` may not turn a baseline step-up off. Enforced by the write command
(`approval_policy_not_tightening` / `22023`) and asserted structurally in `p9`. A policy that could
loosen a requirement would be a permission grant wearing a configuration costume — the same law that
gives feature flags their "off only" kill switch (`0059:29-32`).

**The evaluator**

```sql
evaluate_approval_policy(p_policy_key text, p_amount numeric) returns table (
  policy_key        text,
  configured        boolean,
  applies           boolean,
  threshold_amount  numeric,
  required_approvals integer,
  step_up_required  boolean
)
```

`SECURITY INVOKER`, `stable`, granted to `authenticated`. It reads **only** the public per-org
configuration table, under the caller's RLS — which is why it can be a clean invoker and stays
outside A5 entirely. `configured = false` (and `applies = false`) when the organization has no row
for that key. `applies` is `configured and active and (threshold is null or p_amount >= threshold)`.

It returns a **requirement**, never a verdict. There is no `allowed` column and there will not be
one: "may this person approve this" is #2, and #2 is open.

`p9_five_domains.sql` asserts structurally that **no financial command and no RLS
`USING`/`WITH CHECK` expression anywhere mentions `evaluate_approval_policy`**
(`ENTERPRISE-SECURITY-MODEL.md:246-251`). If a later wave wires it, that assertion fails first and
loudly — which is the point.

---

## 5. What did NOT change

* `notifications` row semantics, the unique `(user_id, dedupe_key)` key, the realtime publication,
  and the unread-badge contract of #39.
* The `send-push` delivery cycle and its three service-only RPCs; `notification_event_states` and its
  ACL (`0040`).
* `global_search`'s `limit 30`, `per_type` default, trigram indexes and `pg_trgm` version.
* `set_invoice_review_status`, `transition_payment_request`, `transition_credit_request`,
  `transition_purchase_order_status`, `cancel_purchase_order` — **not one byte**. The reader reads
  their matrices; it does not become them.
* `private.scope_definer_exemptions` — still 59 rows, zero additions. Every function added in this
  wave is either `SECURITY INVOKER` (outside A5) or a definer whose body names no enforced table.

## 6. Ordering for `agent-client`

The migrations (`0068`–`0070`) land before the client work is merged, but you do not have to wait to
write code: every signature above is final. `npm run build` is free for both agents; `supabase db
reset` and `npm run quality` are not yours this wave.

Files you own: `src/components/PushSettings.tsx` · `src/components/GlobalSearch.tsx` ·
`src/lib/push.ts` · `src/lib/notifications.ts` · `src/pages/InvoiceDetail.tsx` ·
`src/pages/dashboards/PayerDashboard.tsx` · `src/lib/query/keys.ts` ·
`scripts/check-browser-smoke.cjs` · new specs. `agent-db` touches no `src/**`.
