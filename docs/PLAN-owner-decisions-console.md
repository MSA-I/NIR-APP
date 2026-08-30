# Owner decisions console — Depth Tree

## Contracts fixed before implementation

- Source of truth: `docs/OPEN-DECISIONS.md` and `docs/DEBT-REGISTER.md` at the worktree HEAD.
- Stable keys: `decision:<number>` and `debt:<section-number>`; the combined debt heading `§16 / §24` remains one catalog item with both source identifiers.
- Results: external `NIR-APP-DOCS/owner-decisions/current.json` plus `current.md`; canonical source documents are read-only to the console.
- History: an accepted historical decision can only create a reconsideration request; it cannot be overwritten.
- Staleness: each item carries a source hash and the catalog carries the source commit. A changed source blocks finalization for that item.
- Runtime: Node built-ins, loopback only, no Supabase, no secrets, no production deployment.
- UI: Hebrew RTL, primary plain-language layer, optional technical details, keyboard and 200% zoom support.

## Depth Tree

1. Local owner decisions console
   1.1 Source and content contracts
      - Parse all decision rows and debt headings/bodies.
      - Classify open, decided, implementation-gap and technical-debt states.
      - Generate plain-language copy, implications, recommendations and glossary explanations.
      - Prove exact coverage and stable hashes.
   1.2 Persistence and safety
      - Validate answer/reconsideration payloads.
      - Write JSON and Markdown atomically outside the repository.
      - Reject stale revisions, stale source hashes, remote hosts and path traversal.
      - Provide health, catalog, state, answer, reconsideration and finalize endpoints.
   1.3 User interface
      - Dashboard summary, category navigation, search and filters.
      - Decision cards with implications and explicit uncertainty/help options.
      - Historical reconsideration flow without overwrite.
      - Sticky save/finalize bar and visible autosave state.
   1.4 One-click Windows launch
      - Reuse an existing healthy server or start one instance.
      - Open the local page without exposing a network listener.
   1.5 Integration and proof
      - Node tests, repository check, browser flows and screenshot inspection.
      - Re-read requirements and scope diff; record final gate evidence.
