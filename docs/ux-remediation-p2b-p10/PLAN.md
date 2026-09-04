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
| L3 | READY | L2B | Supplier resolution UI, read model and creation RPC |
| L4 | WAITING | L3 | Remove training controls and add document-level feedback |
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
