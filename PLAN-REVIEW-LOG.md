# Plan Review Log: קליטה נכנסת, חוזה עמודות הדוח, וחוליית החיוב

שלבים 0–1 (סריקה + חקירה) הושלמו — התוכנית נעולה מול משה, 31.08.2026. **MAX_ROUNDS=5.**

## שלב 0 — סריקה

- המפרט המקורי (982 שורות) אותר בעץ עבודה אחֵר, נקרא במלואו, ו**שמונה מטענותיו הכבדות נבדקו
  עצמאית** מול העץ ב-`417775b9`: base commit, ספירת מיגרציות (258/`0267`), סוויטה הבאה (`p94`),
  מספור החלטות (`#308` הגבוה, `#306` תפוס), אתרי כתיבה ל-`provider_customer_id` (אפס במוצר),
  גיוט שלושת ה-`core.test.ts` (אפס), `$functionJwt` (12 שמות, שניים חסרים), יבואני `ssrf.ts` (אפס).
  **כולן עמדו.**
- שערי מחקר: **web** (בחירת הבעלים). ארבע שאלות ט-1..ט-4 נחקרו מול התיעוד הרשמי;
  התוצאה ב-`docs/research/2026-08-31-inbound-intake-claudex-research.md`.
- סריקת מלאי סקילים: התאמות דומיין נמצאו בשני הצדדים; **הבעלים הכריע לא לטעון אף אחד.**
- Codex: `codex-cli 0.149.0`, מודל `gpt-5.6-sol` דרך ספק `headroom`, `model_reasoning_effort=xhigh`.

## שלב 1 — חקירה

לדג'ר בן 14 סעיפים הוצג ואושר **אחת-אחת** לבקשת הבעלים. שלוש הנחות בוטלו או תוקנו (הקרקע אינה
יציבה; דומיין המייל חי מאז 24.08; מפתח השיוך בוואטסאפ אינו „הפוך" אלא חסר). תשע הכרעות בעלים
(`#309`–`#317`) נסגרו, **שתיים מהן נגד המלצת Claude** (`#314` ויתור על תנאי `#259`; `#315` מסירה
כפולה) — שתיהן מתועדות ככאלה ב-`PLAN.md`. היקף החיוב נפתח ל„בונים עד הדלת, לא מדליקים".

`#309` הוכרעה **על בסיס מחקר שוק שהבעלים ביקש במפורש**: Xero/Hubdoc/Dext משתמשים בכתובת ייחודית
לחשבון; המודל של Ramp/Expensify (כתובת משותפת + שולח מאומת) נשלל מפני שהוא נשבר מבנית כשספק אחד
משרת דיירים רבים.

חמישה סיכונים חדשים (ס-1..ס-5) שהמפרט לא נשא נוספו ל-`PLAN.md`, **אחד מהם חוסם** (ס-3).

## Round 1 — Codex

מודל: `gpt-5.6-sol` (‏`headroom`, ‏xhigh) · thread `01a05741-0f24-7a10-8f47-0d658f29ea7e`

```
The plan is not safe to implement yet. Several defects can independently cause cross-tenant attribution, stalled document processing, or incorrect billing attribution.

1. **Migration allocation already conflicts.** `PLAN.md` reserves `0268`/`p94`, but a fresh branch scan found active claims on `0268`, `0269`, `0270`, `p94`, and `p95`.

   Fix: Rebase onto the integration SHA, scan every worktree/ref, and allocate migration/test numbers centrally immediately before implementation.

2. **Actorless documents cannot traverse the existing pipeline.** Relaxing `document_processing_jobs.requested_by` is insufficient: `document_scan_jobs.requested_by` remains `NOT NULL`, while the current interpretation claimer joins an active profile through `documents.uploaded_by` and requires `requested_by = uploaded_by`. Images cannot enter scanning; other documents stall after extraction. See [0136](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0136_document_scan_preprocessing.sql:95>) and [0246](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0246_plan_capability_ladder.sql:468>).

   Fix: Define a first-class machine actor/source contract across documents, scan jobs, processing jobs, claimers, recovery, reprocessing, quotas, and audit, then prove full PDF and image journeys without inventing a human actor.

3. **Inbound documents lose enterprise scope.** An unfiled document without an uploader has no scope source; leaving `unit_id=NULL` makes it organization-wide under the current model, exposing it across sibling branches/legal entities.

   Fix: Bind each inbound address/connection to an explicit intake scope or an owner-only quarantine scope, derive `unit_id` server-side, and test sibling-scope denial.

4. **`service_ingest_inbound_document` trusts the dangerous facts.** A `service_role` guard does not validate attribution: the proposed function accepts naked `org_id`, path, and MIME from a globally privileged caller, without an immutable routing claim or object version. See [the proposed boundary](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/docs/plans/2026-08-31-inbound-intake-and-billing.md:426>).

   Fix: Make the RPC consume a locked intake-event/attachment claim, derive `org_id` from the database routing record, and revalidate bucket, object ID, version/eTag, MIME, and `{org_id}/` path atomically.

5. **End-to-end idempotency is missing.** The unique provider event row is finalized after external download/upload, so concurrent retries can download twice, create multiple objects, or leave an orphan when the losing DB transaction hits the unique constraint; attachment identity and deterministic paths are unspecified.

   Fix: Claim before network I/O with lease/attempt states, use a unique provider-message-plus-attachment identity and deterministic `upsert:false` path, then atomically finalize or clean the orphan.

6. **Rate limiting occurs too late and bypasses subscription quotas.** The planned DB limiter runs when creating the document, after Resend/Twilio fetch and Storage bandwidth are already spent; it does not reuse `documents.monthly`, `ocr_pages.monthly`, or automatic-processing counters. One DB row per invalid signature also creates an unauthenticated write-amplification DoS.

   Fix: Add edge/WAF body and request limits, a shared provider token bucket, per-tenant reservation before media fetch, existing usage-counter enforcement, and aggregated or sampled invalid-signature metrics.

7. **The cited SSRF helper cannot download files.** `guardedFetch` deliberately discards response bodies, while validating a URL and then using ordinary `fetch` would lose DNS pinning. See [ssrf.ts](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/functions/webhook-verify/ssrf.ts:488>).

   Fix: Implement a bounded streaming `guardedDownload`, or reconstruct vendor URLs from signed AccountSid/MessageSid/MediaSid identifiers; require exact hosts, account/path agreement, manual redirects, timeouts, byte caps, and byte-level MIME detection.

8. **The global signature-order rule is wrong for Twilio.** Twilio HMAC requires parsed form parameters and a candidate tenant credential selected from untrusted `To`; current code necessarily parses and looks up before verification. “Raw bytes → verify → parse” cannot be implemented literally for this provider. See [whatsapp-webhook](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/functions/whatsapp-webhook/index.ts:52>).

   Fix: Specify provider-specific ordering: retain raw bytes, losslessly parse only the signed form/candidate key, perform a side-effect-free credential lookup, verify, then perform business parsing and writes; give the separate Resend endpoint its own inbound signing secret.

9. **Sensitive inbound-address controls are underspecified and contradictory.** Entropy and format appear only as comments, explicit RLS/direct-DML revocation is absent, and the spec both treats the address as a secret that must not enter logs and says to write the raw address into `audit_logs`.

   Fix: Generate the local part only in the server command, enforce format/length in SQL, use owner-only RLS with no direct DML, and audit only address ID/fingerprint plus masked value.

10. **The promised provenance UI has no readable data model.** `private.inbound_intake_events` lacks bounded sender/unknown-sender fields and is inaccessible to the browser, while `DocumentsInbox.tsx` reads `documents.*`; therefore “came by email/WhatsApp” and “unknown sender” cannot be rendered.

   Fix: Add an org-scoped, RLS-protected provenance projection containing channel, masked sender, known-sender verdict, and document ID, without exposing raw provider payloads.

11. **Twilio readiness and deletion durability are missing.** Canonical decision #239 still says account and credentials are unproven, yet the plan treats WhatsApp as nearly ready; `status='active'`, provider account agreement, and durable deletion retry are not required. A failed post-ingest DELETE leaves media at Twilio indefinitely.

   Fix: Block activation on a real Twilio sandbox/account proof, require active connection plus matching AccountSid/sender, and put provider deletion into an idempotent retry/dead-letter outbox with alerts.

12. **Waiving #259 does not specify scheduled export.** The plan remains “locked” while still leaving Edge-versus-VPS undecided and omits report key, cadence, timezone, legal-entity scope, recipient authority, entitlement recheck, artifact retention, retry identity, and email-attachment contract. #259 concerned slow-report jobs, not scheduled financial delivery.

   Fix: Create a separate explicit scheduled-delivery decision and complete schema, authorization, infrastructure, currency, retention, and DoD contracts—or defer PR-13 and keep manual export.

13. **The report-contract migration conflicts with immutable existing versions.** Existing report contracts are schema v1 without columns and are created per tenant by `owner/office`; approved versions are immutable. Requiring columns can break later approval/update, while comparing only against `EXPORT_DEFINITIONS` does not prove that the actual server report producer emits matching types, nullability, or per-currency rows. See [0126](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0126_propose_export_report_template.sql:20>).

   Fix: Introduce a versioned global column contract keyed by `export_key`, separate from immutable tenant template versions, and gate it against the actual server row generators including currency semantics.

14. **Manual billing-customer linking is a tenant-attribution hole.** A Platform Admin typo can bind a real Paddle customer to the wrong organization; all correctly signed future events then mutate that tenant. An event arriving before the manual link becomes permanently unattributable because replay returns the existing dead letter without resolving again.

   Fix: Create a single-use checkout intent bound to `org_id`, link the provider customer from a verified provider response before webhooks can race, and permit manual linking only as independently verified break-glass recovery with controlled dead-letter re-attribution.

15. **Checkout without an account is unverifiable dead code.** The plan adds a payment page despite lacking Paddle account, KYC, payout, sandbox, real price IDs, API version, redirect contract, or live reconciliation; it also lacks a gate proving checkout currency comes from verified billing country rather than display locale.

   Fix: Defer checkout and `0273` until sandbox readiness and real identifiers exist, then require live checkout/webhook/replay/refund/reconciliation tests and a structural display-currency-versus-billing-currency guard.

16. **The advertised kill switches do not kill ingestion.** Both flags are UI-only; an owner can still call the address/connection RPC directly, and the public webhook continues processing.

   Fix: Add a platform-controlled server boundary checked before credential lookup or media fetch, with no tenant writer, while keeping RLS authorization independent of feature flags.

17. **Rollback is incomplete.** `cron.unschedule` does not cancel running exports, outbox deliveries, emails, or artifacts; clearing `provider_customer_id` destroys financial attribution history; revoking the ingest RPC leaves uploaded orphans and partially processed claims.

   Fix: Define compensating rollback states that stop new claims, drain/cancel in-flight work, preserve billing links append-only, inventory artifacts/deliveries, and delete only proven unregistered storage orphans.

18. **Operational visibility is not implementable from the proposed schema.** Platform dead letters are said to be readable but no safe RPC/UI exists, and there are no alerts for queue age, shared 429s, size/type rejection, stalled actorless jobs, orphan cleanup, or Twilio deletion lag.

   Fix: Add bounded Platform Admin projections, correlation IDs, SLOs, dashboards, and alerts before activation, with masked identifiers and no raw payloads.

Assessment of the five named risks: S-1, S-2, S-3, and S-4 are real, but only S-3 is treated as a hard gate; all four remain unresolved design work. S-5 is merely an inventory of Twilio fields, not a risk analysis—PII bounds, attacker control, forwarding semantics, and storage rules are absent. The plan additionally missed the actorless pipeline, scope leakage, quota bypass, pre-fetch DoS, storage TOCTOU, manual billing misattribution, provider-deletion retry, and nonfunctional provenance UI.

The older memory note was used only to locate decision history; provider and implementation status were refreshed against the current worktree.

VERDICT: REVISE
```

### Claude's response — round 1

**‏17 מתוך 18 התקבלו במלואם; אחד (#15) התקבל בשינוי. אף ממצא לא נדחה.**
ארבעה נבדקו ידנית לפני קבלה, וכולם אושרו:

| # | טענת Codex | המדידה שלי | מסקנה |
|---|---|---|---|
| 1 | `0268`–`0270`, `p94`, `p95` תפוסים | `git ls-tree` על כל ה-refs מחזיר `0268_countdown_and_expectations_flags`, `0269_launch_offer_intents`, `0270_launch_window_extension`, `p94_launch_window_extension`, `p95_launch_offer_intent` | **אושר.** התוכנית הקצתה בדיוק את המספרים התפוסים |
| 2 | הצינור חסום גם אחרי שחרור `document_processing_jobs.requested_by` | `0136:100` — `document_scan_jobs.requested_by uuid not null` + FK; `0246:480` — `and j.requested_by = d.uploaded_by` | **אושר.** תמונה אינה נכנסת לסריקה; מסמך אחר נתקע אחרי החילוץ |
| 7 | `guardedFetch` אינו יכול להוריד קובץ | `ssrf.ts:490-491` — „The body is intentionally absent"; `return new Response(null, …)` | **אושר.** המיטיגציה המרכזית של המפרט אינה ישימה למקרה שלה |
| 8 | סדר raw→verify→parse אינו ישים ב-Twilio | `whatsapp-webhook/index.ts:52-72` מפרסר ומחפש credential לפני האימות, עם נימוק כתוב | **אושר.** הכלל נכון ל-Resend/Paddle, לא ל-Twilio |

**‏#15 (checkout) — התקבל בשינוי, לא כפי שנוסח.** Codex דרש דחייה מלאה. הטענה נכונה — checkout בלי
מזהי מחיר, גרסת API וחוזה redirect אינו ניתן לאימות — אבל **המסקנה אינה יחידה.** ‏sandbox של Paddle
אינו דורש KYC ונותן את שלושתם, ולכן הוא משמר את הכרעת הבעלים („בונים עד הדלת") **וגם** עונה על
ההתנגדות. נרשם כתלות חדשה בבעלים, לא כדחייה.

**מה ש-Codex גילה ואני החמצתי, ומשנה את צורת התוכנית:** ת-2 (חוזה שחקן-מכונה במקום שחרור שתי
נעילות) הוא השינוי הגדול. ת-3 מבטל מיטיגציה שהמפרט הציג כמוכנה. ת-4 מבטל כלל שניסחתי כאוניברסלי.
ת-5 ו-ת-6 מחליפים „לסמוך על הארגומנט" ב„לגזור מהמסד".

**‏#12 — Codex הגיע לאותה סתירה שמצאתי עצמאית לפני שהביקורת חזרה** (ייצוא מתוזמן בהיקף מול
`report_jobs` מחוץ להיקף), והוסיף את מה שלא ראיתי: ‏`#259` עסק בתור לדוחות איטיים, לא במסירת נתונים
כספיים לתיבת דואר. **נפתחה `#318` לבעלים** במקום להכריע בשקט.

**שינויים ב-`PLAN.md`:** הקצאת מספרים הפכה מערך לכלל · נוסף סעיף „תיקוני סבב 1" עם ת-1..ת-6 ·
גל 0 נכתב מחדש כחוזה שחקן-מכונה · נוספו שלושה תנאי-קדם חוסמים · גל 3 מפריד חוזה גלובלי מגרסאות
תבנית בלתי-ניתנות-לשינוי · גל 4 עבר מקישור ידני ל„כוונת checkout" · נוסף סעיף „פתוח לבעלים"
(`#318` + sandbox) · **תוקנה סתירת `report_jobs`** · סעיף הסיכונים הורחב.

## Round 2 — Codex

```
Revision is materially stronger, but not yet internally consistent or implementation-ready.

Prior finding status:

- Fully addressed: #1, #3, #4, #5, #12, #13, #14.
- Substantially addressed but still incomplete: #2, #7, #8, #15.
- Accepted in prose but not converted into normative requirements: #6, #9, #10, #11, #16, #17, #18.

Remaining findings:

1. **Seven accepted fixes exist only in one summary paragraph.** [PLAN.md:177](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:177>) acknowledges rate/WAF controls, address RLS, provenance, Twilio readiness/deletion, server kill switch, rollback, and observability, but does not add their schemas, dependencies, or acceptance gates. The 982-line specification still contains the unsafe originals.

   Fix: Promote each accepted correction into normative Approach/DoD requirements or revise the full specification; the review log must not be the only executable contract.

2. **Current PLAN contains direct contradictions.**

   - Allocation is “logical names only,” but waves still use occupied `0269` and `0270` at [lines 196–200](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:196>).
   - #313 still says extend per-tenant `0126`, while Approach uses a separate global contract at [line 201](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:201>).
   - #316 still mandates `platform_link_billing_customer`, while Approach replaces it with checkout intent at [line 205](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:205>).
   - Provider-specific signature ordering at lines 161–164 is contradicted by universal `raw → verify → parse` at [line 290](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:290>).
   - Separate Resend endpoint/secret at lines 134–135 conflicts with measuring/reusing `RESEND_WEBHOOK_SECRET` at line 200.
   - “Sandbox blocks checkout” conflicts with line 253 saying checkout can be written but not verified.

   Fix: Rewrite stale decision rows, Approach references, Risks, and final invariants so each surface has one authoritative contract.

3. **Machine-actor contract remains a direction, not a design.** It correctly names affected surfaces, but does not define source enums, nullable-shape constraints, scan-job actor semantics, claimant predicates, recovery behavior, or exact quota/audit transitions. Implementer must still invent the highest-risk schema.

   Fix: Add an `M-INGEST` sub-spec with exact columns, constraints, state transitions, RPC signatures, downstream function replacements, and negative mutation tests before coding.

4. **S-1, S-2, S-4, and S-5 remain unresolved.** Shared Resend backpressure has no chosen design; 16MB-versus-10MB handling has no decision; canonical `whatsapp:` storage form is unspecified; S-5 says it became an analysis but provides no PII bounds or forwarding rules. None is listed alongside #318/sandbox as a hard dependency.

   Fix: Close these with explicit behavior and acceptance gates; at minimum S-1 blocks multi-tenant email activation and S-2/S-4/S-5 block WhatsApp implementation.

5. **Paddle sandbox resolves testability only partially.** Plan lacks sandbox/live environment fencing, separate secrets/client tokens/price namespaces, protection against sandbox IDs entering Production, full webhook/replay/refund/reconciliation gates, and the #295 proof that verified billing country—not interface locale—selects checkout currency.

   Fix: Define a server-enforced Paddle mode contract and sandbox E2E matrix; `M-ENABLE` must not be authored from sandbox IDs and must wait for separately proven live identifiers.

6. **Owner decisions are not canonical yet.** Fresh inspection shows `OPEN-DECISIONS.md` still ends at #308; #309–#318 exist only in PLAN. Several reverse canonical #241/#259, so “write them during implementation” allows code to begin while the canonical registry still says “no.”

   Fix: Add a prerequisite documentation checkpoint recording #309–#317 and opening #318 before any product-code PR.

7. **`received_for` sequencing is circular and over-blocks Wave 0.** Live verification requires MX, Resend inbound endpoint, and its secret, but operational setup remains later in PR-10; meanwhile line 189 blocks unrelated universal `M-INGEST` work on that email-only proof.

   Fix: Move a privacy-safe Resend diagnostic setup/probe before `M-MAIL`, make S-3 block only email attribution, and keep `M-INGEST` dependent only on its actual shared prerequisites.

8. **Fresh drift already invalidated another snapshot.** PLAN reports 18 worktrees; current measurement is 22. Logical allocation rule correctly fixes the dangerous part, but static concurrency counts should not be treated as current state.

   Fix: Remove the count or label it strictly time-specific and require a fresh worktree/ref/WIP scan in implementation preflight.

#318 and Paddle sandbox may remain external blockers without preventing approval of unrelated waves, provided dependent work stays hard-blocked. Current blockers are internal contradictions and accepted controls that still lack normative contracts.

VERDICT: REVISE
```

### Claude's response — round 2

**‏8/8 התקבלו. אף ממצא לא נדחה.** הביקורת המרכזית צדקה במלואה: סבב 1 קיבל שבעה ממצאים
**בפרוזה** ולא הפך אותם לדרישות, והמפרט בן 982 השורות המשיך לשאת את הגרסאות הלא-בטוחות.

שלוש טענות נבדקו ידנית לפני קבלה:

| טענה | המדידה | מסקנה |
|---|---|---|
| גלים עדיין משתמשים ב-`0269`/`0270` התפוסים | `PLAN.md:196,199` — נכון, נשארו מהגרסה הקודמת | **אושר.** תיקנתי לשמות לוגיים |
| ‏22 עצי עבודה, לא 18 | `git worktree list \| wc -l` = **22** | **אושר.** הספירה דריפטה **בתוך הסשן הזה**. הוחלפה בחותם זמן + דרישת סריקה טרייה |
| ‏`OPEN-DECISIONS.md` עדיין נגמר ב-`#308` | נכון; `#309`+ קיימות רק ב-`PLAN.md` | **אושר.** הפך לתנאי-קדם חוסם |

**מה שנוסף — סעיף „חוזים מחייבים" (ח-1..ח-10):** ‏`M-INGEST` עם enum מקור, CHECK דו-כיווני על
השחקן בשתי טבלאות העבודה, החלפת predicate התובע, ‏`intake_unit_id not null`, טבלת תביעות עם
unique משולש ו-lease, **חתימת RPC שמקבלת רק `claim_id`/`object_id`/`object_version`** וגוזרת את
השאר מהמסד, וחמישה מבחני שלילה חובה · ח-2 קצב ומכסות לפני ההורדה · ח-3 הכתובת · ח-4 הטלה
ב-`public` ל-UI · ח-5 מחיקה ב-outbox · ח-6 גבול פלטפורמה · ח-7 rollback שמנקז · ח-8 נראוּת ·
ח-9 גידור Paddle · **ח-10 סוגר את ס-1..ס-5 בהכרעות מחייבות.**

**סתירות שתוקנו:** ‏`0269`/`0270` → שמות לוגיים · שורת `#313` → חוזה גלובלי מגורסה · שורת `#316`
→ „כוונת checkout" · **סעיף 3 של המפרט (raw→verify→parse) הוחלף בטבלת סדר פר-ספק** עם אינווריאנט
אמיתי („אף תופעת לוואי לפני אימות") · הופרדו שני סודות Resend · הוסרה סתירת sandbox/checkout.

**‏ס-3 שוחרר מחסימת גל 0** — הוא ספציפי לשיוך מייל וחוסם את `M-MAIL` בלבד. שרשור עבודה
אוניברסלית להוכחה שהיא ספציפית למייל היה מלאכותי, וסבב 2 צדק שזה over-blocking.

## Round 3 — Codex

```
All eight round-2 findings are addressed in intent. `ח-1..ח-10` now provide binding overrides, contradictions are fixed, and blocked work is classified honestly. Six new implementation-level gaps remain.

1. **`source NOT NULL` breaks existing browser and derived-document writers.** `ח-1` requires no default, but current live constructors omit `source`, including [0131](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0131_idempotent_document_upload_registration.sql:139>), [0140](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0140_mixed_document_packets.sql:495>), and [0169](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0169_customer_operations_post_merge_hardening.sql:234>). This conflicts with “browser route unchanged.”

   Fix: Require historical backfill, enumerate and replace every live document/job constructor, preserve browser API via a documented server-derived `browser` value if desired, and make `source` immutable.

2. **Job source can drift from document source.** `documents`, processing jobs, and scan jobs each carry independent `source`, but no composite FK or trigger forces equality; a job can therefore claim `email` semantics for a browser document and bypass actor requirements.

   Fix: Add structural equality—prefer composite FKs from `(org_id, document_id, source)` to documents—and mutation tests proving mismatched source cannot be stored.

3. **Claim is not structurally bound to attribution.** [ח-1](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:291>) specifies provider/message/attachment identity and states, but not the immutable routing FK that binds claim to address/connection, `org_id`, `intake_unit_id`, and source. RPC cannot safely “derive from routing” without that relationship.

   Fix: Define claim columns and composite FKs explicitly, retain revoked routing rows for historical resolution, and forbid changing route/org/unit/source after claim creation.

4. **Lease has no fencing authority.** Claim has `lease_until` and `attempt`, but no owner/token, and RPC accepts only claim ID plus object identity. A worker from expired attempt 1 can finalize after attempt 2 reclaimed the claim.

   Fix: Add opaque lease/fencing token or expected attempt to claim and RPC, lock the claim, and require matching live lease/state before every upload-finalization transition.

5. **Quota reservation lifecycle is undefined.** Pre-fetch reservation is correct, but plan does not define idempotency key, reserved page quantity, conversion into final usage, release after fetch/type/size failure, or retry behavior. Unknown page count makes `ocr_pages.monthly` especially ambiguous.

   Fix: Add a claim-keyed reservation ledger with reserve/commit/release states, one-page provisional reservation plus exact extraction reconciliation, and tests for failure, replay, expiry, and concurrent claims.

6. **Oversize rejection still cannot reach tenant.** S-2 requires a readable tenant message, but `ח-4` exposes only provenance tied to an existing `document_id`; an oversized file creates no document. `ח-8` covers Platform Admin visibility, not tenant notification. Forwarding flags from S-5 are also absent from the stated projection.

   Fix: Add an org-scoped RLS rejection projection or notification path for terminal intake failures, and include bounded `forwarded`/`frequently_forwarded` provenance fields.

7. **S-3 operational sequencing remains incomplete.** [Approach](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:207>) requires a live `received_for` payload before `M-MAIL`, but MX/endpoint setup remains afterward in PR-10. No temporary diagnostic endpoint or Resend-managed receiving-domain probe is specified.

   Fix: Add a privacy-safe pre-`M-MAIL` probe using the final endpoint contract or a documented temporary Resend receiving domain, then reserve final MX activation for rollout.

`#318` and Paddle sandbox are now correctly hard-blocked and do not prevent unrelated waves from proceeding. Remaining defects concern schema compatibility, tenant-attribution structure, and concurrency fencing; they must be resolved before `M-INGEST`.

VERDICT: REVISE
```

### Claude's response — round 3

**‏6/6 התקבלו; אחד (#1) התקבל עם תיקון שונה מהמוצע.** הביקורת ירדה לרמת סכימה, וזה בדיוק מה
שסבב 2 ביקש.

**#1 — הממצא נכון, `ח-1` שלי היה שגוי, אבל התיקון שונה.** אומת: ‏`0131:139` ו-`0140:495` מכניסים
ל-`documents`, ו-`0169:234` ל-`document_processing_jobs`, **כולם בלי `source`.**
‏`not null` בלי default היה מפיל את שלושתם — כלומר **מפר את כלל הברזל „מסלול הדפדפן אינו משתנה
בשום תו".** ‏Codex הציע להחליף כל בנאי חי; **בחרתי `not null default 'browser'` + immutable +
backfill** מפני שהוא משיג את אותה מטרה **בלי לגעת באף בנאי קיים**. ‏„ברירת מחדל שקטה" אינה מסוכנת
כאן, כי ה-CHECK הדו-כיווני דוחה שורת מכונה חסרת-שחקן שקיבלה `'browser'` — כלומר הדפוס אינו יכול
להסוות מקור.

**#2–#5 התקבלו כלשונם** ונכתבו ל-`ח-1`: ‏FK מורכב `(org_id, document_id, source)` שאוכף שוויוניות
מקור בין עבודה למסמך · ‏FK בלתי-משתנה מהתביעה לרשומת הניתוב עם הקפאת `org/unit/source` ושמירת
שורות ניתוב מבוטלות · **`lease_token` אטום בחתימת ה-RPC** תחת נעילת שורה (בלעדיו עובד מניסיון שפג
מסיים אחרי שניסיון חדש תפס) · **פנקס הזמנות מפתוח-תביעה** עם reserve/commit/release, הזמנת עמוד
אחד זמנית והתאמה לספירה האמיתית בדפוס `0169:231`.

**#6 — התקבל, וזו הייתה נקודה עיוורת אמיתית.** קובץ שנדחה על גודל **אינו יוצר מסמך**, ולכן הטלה
שמפתחה `document_id` לא יכולה להציג אותו — הבטחת ס-2 („הודעה קריאה ללקוח") נשברה בשקט. נוספה
**הטלת דחיות נפרדת שמפתחה התביעה**, ‏+ דגלי `forwarded`/`frequently_forwarded` להטלה.

**#7 — התקבל.** הסדר של ס-3 היה מעגלי: אימות חי דרש MX/endpoint/סוד שכולם ישבו **אחרי** השלב
שהם חוסמים. נוסף **גשוש מקדים** על תת-דומיין מנוהל של Resend, ששומר נוכחות/היעדר וספירה בלבד —
אפס תוכן — וללא נגיעה ב-DNS של `inplace.digital`.

**‏`#318` הוכרעה על ידי הבעלים** באותו סבב: בעלים+רו״ח לכתובת מאומתת בלבד · **צרופה** (נגד
ההמלצה) · עצירה מיידית עם התראה. **נרשמה התוצאה שנובעת מהצירוף:** עצירה חוסמת עתיד בלבד, וקובץ
שכבר יצא אינו ניתן לשליפה — ולכן המסך חייב לומר זאת בזמן ההפעלה.

## Round 4 — Codex

```
Round-3 corrections are mostly sound:

- Defaulted immutable `source` preserves existing browser constructors.
- Composite source FK closes job/document drift.
- Lease token closes stale-worker finalization.
- Reservation lifecycle is now explicit.
- Tenant rejection projection and forwarding provenance are present.
- Pre-`M-MAIL` Resend probe removes sequencing cycle.

Five material issues remain.

1. **#318 is simultaneously decided and open.** Header says open, Approach and Risks say PR-13 is blocked, section heading says “open,” background says it still awaits an answer, and Out of Scope says it is not built. These conflict with [the decided section](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:415>).

   Fix: Update header, prerequisites, Approach, Risks, section headings, and scope consistently; either #318 unblocks a fully specified PR-13 or PR-13 remains blocked for named unresolved decisions.

2. **#318 still leaves required scheduling decisions unanswered.** Decision specifies eligible roles, attachment delivery, and stopping behavior, but not report key, legal-entity scope, selected recipients versus all eligible users, configuration authority/step-up, cadence, or timezone—the same questions still listed as open at lines 437–439.

   Fix: Add a binding scheduled-export contract covering creator authorization, report/scope, recipient profile IDs, cadence/timezone, delivery idempotency, attachment cap, retry/bounce behavior, and artifact lifecycle.

3. **Accountant authorization checks role but not financial scope.** An accountant may access only one legal entity. Rechecking merely `role='accountant'` could email entity A’s books to an accountant scoped only to entity B.

   Fix: At every send, require active profile, eligible role, current `auth_scopes()` access to exact report/legal entity, current entitlement, and verified Auth email; scope failure must stop delivery and alert owner.

4. **The stated email source does not exist.** [PLAN.md:428](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:428>) says read address from profile, but `public.profiles` has no email column—see [0001_init.sql:31](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0001_init.sql:31>). Email lives in Supabase Auth.

   Fix: Store only recipient `profile_id`; resolve `auth.users.email` and confirmation state server-side at send time, never through browser or cached schedule data.

5. **Routing FK remains structurally undefined.** A PostgreSQL FK cannot reference “either an inbound-address row or a WhatsApp-connection row.” Freezing `org_id`, unit, and source beside a route ID also does not prove they match that route.

   Fix: Introduce one canonical `private.inbound_routes` parent with composite identity `(route_id, org_id, intake_unit_id, source)`, or define two exclusive channel-specific FKs plus CHECKs and composite consistency enforcement.

6. **Historical backfill assumes every existing document has an actor.** `documents.uploaded_by` has always been nullable. Backfilling every row to `source='browser'` and then enforcing `browser ⇒ uploaded_by IS NOT NULL` fails if Production contains even one legacy null-uploader document.

   Fix: Add a mandatory preflight count; if nonzero, stop for an explicit legacy-source/data-resolution contract—never fabricate an owner actor.

7. **Page quota is reconciled after OCR cost is spent.** Reserving one page and expanding only after extraction allows a large PDF to consume OCR while the tenant lacks remaining page capacity.

   Fix: After bounded download, determine page count before OCR, reserve the remaining pages atomically, and reject/hold before extraction when capacity is insufficient.

VERDICT: REVISE
```

### Claude's response — round 4

**‏7/7 התקבלו.** שתי טענות סכימה נבדקו ידנית, **ושתיהן היו כשלי ייצור בהמתנה:**

| טענה | המדידה | מסקנה |
|---|---|---|
| `profiles` נטולת עמודת email | `0001:31-38` — `id`/`org_id`/`full_name`/`role`/`phone`/`active`/`created_at` בלבד | **אושר.** „לקרוא כתובת מהפרופיל" היה בלתי-אפשרי. הוחלף ב-`profile_id` + פתירת `auth.users` בשרת בזמן השליחה, **ובמפורש לא `profiles.backup_email` (`0255`)** שהיא כתובת שחזור ולא כתובת התחברות |
| `documents.uploaded_by` תמיד היה nullable | `0001:368` — `uploaded_by uuid references profiles(id)`, בלי `not null` | **אושר, וזה החמור מהשניים.** ‏backfill גורף ל-`'browser'` + אכיפת `browser ⇒ actor not null` **היה מפיל את המיגרציה בייצור** על כל מסמך היסטורי חסר-מעלה. נוסף **preflight ספירה חוסם**, ואיסור מפורש להמציא שחקן |

**#5 — נכון מבנית ואין עליו ויכוח.** ‏FK ב-PostgreSQL אינו יכול להצביע „או לכתובת או לחיבור",
והקפאת `org/unit/source` **ליד** מזהה ניתוב אינה מוכיחה התאמה. נוסף **הורה קנוני
`private.inbound_routes`** עם זהות מורכבת `(route_id, org_id, intake_unit_id, source)`, ו-FK מורכב
מהתביעה אל ארבעתם — כך שההתאמה מבנית ולא הבטחה.

**#7 — נקודה עיוורת אמיתית.** הזמנת עמוד אחד והתאמה **אחרי** החילוץ מאפשרת ל-PDF גדול לצרוך OCR
שכבר שולם עליו בזמן שאין לדייר קיבולת. הסדר תוקן לשלושה שלבים: הזמנה זמנית → **קביעת מספר עמודים
והזמנת היתרה אחרי ההורדה ולפני ה-OCR** → דחייה/השהיה לפני החילוץ אם אין קיבולת → `commit`.

**#3 — התקבל.** תפקיד אינו היקף: רואה-חשבון המורשה לישות ב׳ היה מקבל את ספרי ישות א׳. כל שליחה
בודקת חמישה יחד, כולל **`auth_scopes()` לישות המשפטית של אותו דוח**.

**#1 ו-#2 — התקבלו, וזו הייתה רשלנות שלי.** ‏`#318` הופיעה בו-זמנית כ„פתוחה" בכותרת/סיכונים/היקף
וכ„הוכרעה" בגוף, מפני שעדכנתי סעיף אחד ולא את שאר המסמך. תוקן בכל שישה המקומות. ‏+ נכתב **חוזה
תזמון מלא** (מי מגדיר, דוח, היקף, נמענים מפורשים, תדירות, אזור זמן, אידמפוטנטיות, תקרת צרופה,
‏bounce, שמירה) כברירות מחדל מוצהרות בדפוס `OPEN-DECISIONS`, במקום להשאיר חצי הכרעה.

## Round 5 — Codex (final, MAX_ROUNDS)

```
All seven round-4 intake findings are addressed. `M-INGEST`, routing, backfill gate, lease fencing, quota timing, rejection visibility, and Resend probe are now sound plan contracts.

Three scheduler defects remain.

1. **Scheduled worker cannot use `auth_scopes()` for recipient authorization.** `auth_scopes()` is zero-argument and keys exclusively on `auth.uid()`/`auth_org()`—see [0054](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/supabase/migrations/0054_org_scope_foundations.sql:321>). A cron/service-role worker has no recipient JWT, so it returns an empty array; repository comments already document this exact limitation for trusted-server jobs.

   Fix: Add a server-only `private.scopes_for_user(profile_id, org_id)` over `user_scope_closure`, combined with active-profile/role checks, and prove denial across sibling legal entities without impersonating a JWT.

2. **Delivery idempotency omits recipient.** One schedule may contain multiple explicit `profile_id`s, but `(schedule_id, period)` permits only one delivery identity. A partial failure cannot safely retry one recipient without duplicating successful recipients or suppressing the failed one.

   Fix: Use `(schedule_id, period)` for artifact generation and `(schedule_id, period, recipient_profile_id)` for delivery; record, retry, bounce, suspend, and reconcile each recipient independently.

3. **Bounce policy is incomplete.** “After a consecutive threshold” does not define threshold value, what resets it, or whether suspension is per recipient or whole schedule.

   Fix: Specify numeric threshold, delivered-event reset semantics, per-recipient suspension, owner alert deduplication, and explicit manual resume behavior.

4. **Two stale status headings remain.** [PLAN.md:431](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/inbound-intake-billing-a0d0c4/PLAN.md:431>) still says “open and unresolved,” and line 467 says “what remains open,” although #318 is decided.

   Fix: Rename both sections so no reader can classify PR-13 as decision-blocked.

VERDICT: REVISE
```

### Claude's response — round 5

**‏4/4 התקבלו ויושמו.** ‏Codex הצהיר במפורש ש**כל משטח הקליטה — החלק המסוכן — תקין**:
‏„`M-INGEST`, routing, backfill gate, lease fencing, quota timing, rejection visibility, and
Resend probe are now sound plan contracts." שלושת הממצאים שנותרו נוגעים **לתזמן בלבד**, ואחד קוסמטי.

**#1 — אומת, והוא חמור ממה ש-Codex ניסח.** ‏`auth_scopes()` היא חסרת-ארגומנטים ונשענת על
`auth.uid()`/`auth_org()` (`0054:321-328`), ולכן בעבודת cron היא מחזירה `'{}'`. **אבל הגרוע יותר
הוא ש-`assert_unit_in_scope` מקדימה יציאה ומתייחסת ל„נושא JWT חסר" כאל עבודת שירות מהימנה**
(`0054:334-336`) — כלומר בדיקת ההיקף שכתבתי בסבב 4 **הייתה עוברת בזכות היותה עבודת שרת**, ולא
מגינה כלל. הוחלפה ב-`private.scopes_for_user(profile_id, org_id)` מעל `user_scope_closure`
(`0054:224`) עם ארגומנט מפורש, ובתנאי קבלה של הוכחת סירוב בין ישויות אחיות.

**#2 — התקבל.** מפתח אחד לא יכול לשרת כמה נמענים: הופרד ל-`(schedule_id, period)` ליצירת הארטיפקט
ו-`(schedule_id, period, recipient_profile_id)` למסירה.

**#3 — התקבל.** ‏„סף עוקב" ללא מספר אינו מדיניות. נקבע: **שלושה** כשלים רצופים לנמען · מסירה
מוצלחת מאפסת · **השהיה פר-נמען ולא לכל התזמון** · התראה מנוכת-כפילויות · חזרה ידנית בלבד.

**#4 — התקבל.** שתי כותרות מיושנות שונו.

---

## Resolution — MAX_ROUNDS reached

**‏5 סבבים, 43 ממצאים, 43 התקבלו** (שניים בתיקון שונה מהמוצע, אף אחד לא נדחה).
מגמת ההתכנסות: **18 → 8 → 6 → 7 → 4**, והיקף הממצאים הצטמצם מ„פגמים חוצי-ארכיטקטורה" ל„חוזה
התזמן" ולשתי כותרות.

**הפסק הפורמלי האחרון הוא `REVISE`, ואינו APPROVED.** ארבעת הממצאים של סבב 5 יושמו **אך לא
נסקרו מחדש**, מפני שהתקרה נקבעה מראש ל-5. **אין כאן מחלוקת פתוחה בין Claude ל-Codex** — אין ולו
ממצא אחד שנדחה או שנוי במחלוקת; יש עבודה שיושמה אחרי הסקירה האחרונה.

**מה שהלולאה שינתה בפועל, ולא היה נתפס בלעדיה:**
1. **הקצאת מספרי מיגרציה מתנגשת** — `0268`–`0270`/`p94`/`p95` תפוסים כולם.
2. **הצינור חוסם מסמך נטול-אדם בשתי שכבות נוספות** (`0136:100`, `0246:480`) — תמונה לא הייתה
   נכנסת לסריקה.
3. **`ssrf.ts` אינו יכול להוריד קובץ** (`ssrf.ts:490`) — המיטיגציה המרכזית לא הייתה קיימת.
4. **כלל סדר-החתימה שכתבתי אינו ישים ב-Twilio** — הכלל היה הופך לשקר בעץ.
5. **`profiles` נטולת עמודת email** (`0001:31-38`) — קוד שלא היה עובד.
6. **`documents.uploaded_by` nullable מאז `0001:368`** — המיגרציה **הייתה נופלת בייצור**.
7. **`auth_scopes()` עוברת בעבודת שרת** (`0054:334`) — בדיקת הרשאה שהייתה מדומה.

**חסמים שנשארו, וכולם בידי הבעלים או תפעוליים:** ‏Paddle sandbox · רישום `#309`–`#318`
ב-`OPEN-DECISIONS.md` · ‏`guardedDownload` · גשוש `received_for` · ‏preflight טרי של מספרים
וספירת מסמכים חסרי-מעלה.
