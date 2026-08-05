# handoff 08 — offline receiving, the sync queue and the barcode key

**Produced by:** the wave-8 agent (PLAN-09) · **branch:** `wave8/offline-barcode` · **migration:** `0067`
**Consumers:** the app-shell precache wave (#101) · any wave that adds a second queued action kind ·
any wave that touches `save_goods_receipt`, `Receiving.tsx` or the receipt idempotency key.
**Status:** the queue contract, the persisted-key rule and the five conflict codes below are FINAL
for this wave. `save_goods_receipt` was **not** modified and its signature did not change (#100).

---

## 1. The persisted-key rule — the one thing not to break

`Receiving.tsx:312` used to send `p_receipt_id: data?.draft?.id ?? newReceiptId`. That made the key
depend on whether a read had succeeded: the same physical receipt could reach the server under the
server draft's id on one attempt and under a fresh in-memory UUID on another, and the server would
have every right to record it twice.

**The rule now (ADR-0006:37-39):**

> The idempotency key is minted **once**, at draft creation, and **persisted** in
> `receipt_drafts.receiptId` before anything is sent. If a server draft was read successfully while
> online, **its id becomes the key**. If not, a device UUID does. From that moment the stored value
> is the key for the life of the receipt — every later visit, reload, retry and queue send uses it.

The single implementation is `ensureReceiptKey()` in `src/lib/offlineDb.ts`. It takes an optional
`store` seam so the rule is unit-tested (`offlineDb.spec.ts`), and the browser gate asserts the
persisted value equals the `p_receipt_id` that finally reaches the server.

`ReceiptKeyResolution.persisted` is `false` when the device refused the write (private-browsing
modes drop it). The screen then says so instead of promising a durable draft — do not silently
treat that as success.

**A local draft is deleted only when the receipt is closed** (an accepted `p_complete: true`). An
accepted intermediate save keeps the row and stamps `syncedAt`, precisely so the key survives; a
deleted row would make the next offline visit mint a second key for the same order.

## 2. The queue contract

`src/lib/offlineQueue.ts`. `createOfflineQueue(deps)` is the testable factory; `offlineQueue` is the
app's singleton. Storage is injected as `OfflineQueueStore` (`offlineDb.ts`).

**Entry shape** (`OfflineQueuedAction`): `kind: 'save_goods_receipt'` · `idempotencyKey` (the same
value as the draft's `receiptId`) · `orderId` + `orderLabel` (Hebrew, for per-action messages) ·
`payload` (the **exact** RPC argument object the online screen sends) · `observedAt` (device clock
when the person recorded the goods) · `attempts` · `state: 'pending' | 'failed' | 'conflict'` ·
`lastError` (Hebrew) · `lastErrorCode` (the server's code) · `lastAttemptAt` · `createdAt`.
The autoIncrement `id` **is** the queue order: insertion order is send order.

**Invariants a later wave must keep:**

1. **One entry per idempotency key.** Enqueueing the same receipt again replaces the existing
   entry's payload; two entries under one key would send the same receipt twice and invite the
   server's own idempotency comparison to reject the second as a conflict.
2. **Continue after failure** (the `runUploadBatch` rule, `uploadBatch.ts:40-56`): every action gets
   its turn in one sync pass; a failure records its own reason and the loop moves on.
3. **A Hebrew reason per action, never a collective one.** "הסנכרון נכשל" is forbidden by
   `OFFLINE-SYNC-DESIGN.md:90` and by the spec suite.
4. **`state: 'conflict'` is never re-sent.** It is a pending human decision, not a transport
   problem; a second sync leaves it alone until the conflict screen resolves it.
5. **An expired session sends nothing.** `hasUsableSession()` is checked before every send;
   failing it sets `sessionExpired` and keeps the draft. Stale credentials never carry a business
   write, and RLS is not weakened for the queue — it calls the same RPC with the user's JWT.
6. **Two counters, separate** (`pendingActions`, `pendingUploads`) and a **real**
   `lastSuccessfulSyncAt` or `null`, rendered as `—`.

**Triggers:** a manual `sync()` (what the design document mandates) **and** an `online` listener
installed by `start()`. The auto-resume is an **extension** beyond the document, following
`UploadCenter.tsx:218-230`; the manual button stays, because automatic resume must never be the
only way for someone to make progress.

**Adding a second action kind** means: a new `kind` literal, a `send` branch, and a decision about
what its conflict codes are. Do **not** widen the queue to anything on ADR-0006's forbidden list —
approving invoices, executing payments, changing supplier bank details. That boundary is the reason
the exception was granted at all.

## 3. The audited reason and the observed clock (#100)

`receiptAuditReason(base, observedAt, syncedAt)`:

- clocks equal → **the base string exactly** (`השלמת קבלת סחורה` / `שמירת ביניים של קבלת סחורה`);
- clocks differ → `<base> · נרשמה במכשיר HH:MM · סונכרנה HH:MM`, Asia/Jerusalem, 24h.

A direct online send is observed and synced in the same act, so its reason is the base string — and
that is also what the existing browser-gate assertions read (`check-browser-smoke.cjs:810,815`).
A conflict resolution appends ` · הכרעת קונפליקט: <explanation>` before the clock clause.

`goods_receipts.received_at` is still `now()` at send time (`0023:1645`) and **no column was
added**. The upgrade path, if reporting ever needs to query the observed time rather than read it,
is written out in OPEN-DECISIONS #100.

## 4. The five conflict codes

Detection is **re-read-and-compare** (`loadReceiptConflict`, `ReceiptConflictDialog.tsx`):
`purchase_order_items` has no timestamp column and no trigger (`0001:164-171,415`) and PLAN-09
forbids adding one. The comparison shows the state at read time; the server stays the only
authority, because every resolution goes back through `save_goods_receipt` under row locks.

| code | what it means here | what the screen offers |
|---|---|---|
| `receipt_qty_exceeds_order` | the likeliest by far — `'full'` must equal the remaining quantity **exactly** (`0023:1518`) and somebody received against this order while the device was offline | per-line human decision (device / server) + a **required** explanation → re-send |
| `receipt_draft_conflict` | another draft is open on the same order | keep local / discard local — no re-send |
| `receipt_already_completed` | the receipt is closed on the server with different content | keep local / discard local — never overwritten |
| `receipt_idempotency_conflict` | the key is known but its stored content differs | keep local / discard local |
| `purchase_order_not_receivable` | the order's status changed (e.g. cancelled) while offline | keep local / discard local |

`conflictPresentation(code)` is a pure exported function and the mapping is a tested claim.
**There is no automatic quantity merge and there must not be one** — a quantity is a claim about
goods that arrived. Resolutions that write nothing to the server say so explicitly, because no audit
row will exist for them. Every code offers a keep-local escape: losing what the device saw is never
the only way forward.

Hebrew mappings live in `src/lib/errors.ts`; `receipt_draft_conflict` and
`receipt_already_completed` were split apart there this wave because they ask different questions.

## 5. What the precache wave must add

1. **Install `workbox-*`** (still listed under planned additions in `THIRD_PARTY_NOTICES.md`) and
   move it into the verified table with a license read from `node_modules`.
2. **Rewrite `public/sw.js` without losing three things:** its verbatim header (quoted in five
   places, including ADR-0006 and this document), the push handlers (four gate scenarios), and the
   `controllerchange` contract in `src/main.tsx:19-28` that `pwaUpdate` asserts ("the open tab is
   not erased"). `injectManifest` rather than `generateSW`, for exactly that reason.
3. **Cache the app shell only.** `/rest/v1`, `/auth/v1` and `/functions/v1` responses must never
   enter any cache — that rule is older than this wave and survives it.
4. **Then, and only then, replace the tab-close step of the offline gate scenario with a real
   offline `page.reload()`** and delete the deferral note in `OFFLINE-SYNC-DESIGN.md` §9. Until that
   scenario passes, the honest statement stays: a reload while offline loses the shell.
5. **Do not touch the queue to do it.** The queue owes nothing to a service worker; if precaching
   requires changing `offlineQueue.ts`, something has gone wrong in the design.

## 6. Barcode (#102)

`0067_barcode_lookup_index.sql` adds **one** partial, **non-unique** index
`products (org_id, barcode) where barcode is not null`, plus a re-assert `DO` block that fails the
reset if the index is missing, unique, or reshaped. Uniqueness is refused on purpose: it would
forbid the very state `matchDeliveryLineProduct`'s ambiguity rule (`model.ts:358-363`) exists to
handle. The demo seed carries a deliberate pair sharing one barcode **on the same receivable order**
(`7290000000902` on orders #5 and #12), so the ambiguity path is provable end to end.

`matchScannedBarcode()` (`BarcodeScanner.tsx`) feeds the shared chain a synthetic barcode-only
delivery-note line, and reports `ambiguous` apart from `none` because they are different facts.
A scan **identifies a line and never sets a quantity.** The flag `receiving.barcode` is the boundary
and is fail-closed: off, unknown or still loading ⇒ the component renders `null` and the `@zxing`
chunk is never requested.
