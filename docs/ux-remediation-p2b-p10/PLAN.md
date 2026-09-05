# Execution tree: UX remediation P2b-P10

Authorized by the owner on 05.09.2026. Runs serially in the current worktree; no subagents and no overlapping writers.

## Shared contract

- Owner decisions in `docs/UX-REMEDIATION-DECISIONS-20260904.md` override every older plan sentence.
- P7 and P4b are cancelled and must receive no implementation.
- Hebrew and English dictionaries move together. Supplier names, OCR/source text, stored values and parser vocabulary are never translated.
- Every mutation RPC is tenant-scoped, role-gated, idempotent and writes an audit reason. Read models write nothing.
- P6 precedes P8. P10 runs last.
- A code contradiction updates the main plan in the same commit as its implementation.
- Visual work needs desktop and mobile runtime screenshots. Package claims need runtime evidence, not typecheck alone.
- P2.9 is intentionally verified in L9B because it changes the product-help evidence timestamp, not the document screen.

## Depth Tree

| Leaf | State | Needs | Deliverable |
|---|---|---|---|
| L2B | VERIFIED | — | P2b replacements and density proof |
| L3 | VERIFIED | L2B | Supplier resolution UI, read model and creation RPC |
| L4 | READY | L3 | Remove training controls and add document-level feedback |
| L5 | WAITING | L4 | Status/recovery vocabulary and expanded progress states |
| L6 | WAITING | L5 | Mobile-first document review order and density |
| L8 | WAITING | L6 | Failure-specific scan recovery and soft supersede |
| L9A | WAITING | L8 | Assistant recovery and 10-minute auto-restore boundary |
| L9B | WAITING | L9A | Product help, entry-by-entry roles, Edge contract and live proof |
| L9C | WAITING | L9B | Feedback note persistence and reread |
| L9D | WAITING | L9C | Remove glass/light bodies, retain floating panel, no AI disclosure |
| L10 | WAITING | L9D | Final bilingual copy pass and orphan-key closure |
| N1 | OPEN | L2B-L10 | Full integration, visual, CI and rollout proof |

## Status log

- 05.09.2026: owner authorized P2b-P10; plan reconciled; L2B promoted to READY.
- 05.09.2026: L2B verified. Focused Vitest 93/93, dictionary guards and build passed; browser measured folder controls 24->23 desktop and 21->20 mobile, review panels 10->9 and text blocks 35->34. L3 promoted to READY.
- 05.09.2026: L3 verified. Focused Vitest 109/109, p109 passed five DB cases before and after a clean 0001-0316 reset, three demo roles signed in after restore, and desktop/mobile browser proved selection, confirmed creation, order warnings, approval payload and one batched folder read. L4 promoted to READY.
- 05.09.2026: integration note — `check:migration-numbers` remains open because 0315 is reserved in live branch `worktree-agent-a37194cd6c1d29194`; 0316 came from a fresh `next-number` run and must not be renumbered onto that WIP.
