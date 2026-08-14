---
target: SupplyFlow mobile shell
total_score: 30
p0_count: 0
p1_count: 2
timestamp: 2026-08-14T11-02-49Z
slug: src-components-layout-tsx
---
Method: dual-agent (A: /root/mobile_critique_a · B: /root/mobile_critique_b)

# Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Skeletons are semantic and settle, but the Dashboard skeleton teaches a different mobile order from the final screen. |
| 2 | Match System / Real World | 4 | Hebrew procurement language, money, dates, and statuses match the work. |
| 3 | User Control and Freedom | 3 | Drawer, search, filter clearing, cancel, and row menus are available. |
| 4 | Consistency and Standards | 3 | The design system is cohesive; mobile header utilities use mixed boxed and ghost affordances. |
| 5 | Error Prevention | 3 | Required choices, disabled capture states, and destructive confirmations prevent common errors. |
| 6 | Recognition Rather Than Recall | 3 | Labels are visible, but the current page title collapses at 320px. |
| 7 | Flexibility and Efficiency | 3 | Role-aware quick actions and search accelerate repeat work. |
| 8 | Aesthetic and Minimalist Design | 3 | Calm overall; invoice filters put six stage choices before the first record. |
| 9 | Error Recovery | 3 | Errors preserve data and expose retry paths. |
| 10 | Help and Documentation | 2 | Local instructions are good, but contextual help is sparse across daily surfaces. |
| **Total** | | **30/40** | **Good** |

# Anti-Patterns Verdict

This does not look AI-generated. The petrol-and-paper shell, semantic operational color, real ledger data, restrained motion, and Hebrew RTL details are intentional. The deterministic Impeccable scan returned zero findings in `src`. No reliable user-visible detector overlay was available; evidence came from isolated Playwright screenshots and computed geometry. The only generic visual tendency is the long sequence of rounded white cards in loading states.

# Overall Impression

SupplyFlow is already a credible mobile operations product. The biggest opportunity is to make the shell truly adaptive at the narrowest and shortest phone geometries, while preserving the direct role-aware actions that define the workflow.

# What's Working

- RTL and responsive containment are strong: no horizontal overflow at 320, 390, 430, 768, or 844px.
- Every visible interactive target measured at least 44x44px. The 1x1 skip link and hidden file inputs are intentional false positives with visible controls.
- The bottom command bar is role-aware, labeled, thumb-friendly, and the capture action remains the physical center.
- Invoice cards retain supplier, number, dates, amounts, balance, review status, payment status, and row actions without horizontal scrolling.

# Priority Issues

## [P1] Short landscape viewports lose a third of the task area

**Why it matters:** At 844x390, the 69px header and 65px command bar consume 34.4% of the viewport; the raised capture puck leaves only 237px of unobstructed task area. Dense receiving and finance work becomes a narrow scrolling slit.

**Fix:** Add a short-height landscape shell variant that keeps 44px targets but reduces header padding, action-bar height, label leading, and capture-puck size.

**Suggested command:** `/impeccable adapt`

## [P1] The current-location title collapses at 320px

**Why it matters:** The usable header width is fully consumed by a 44px menu, 140px utilities, and a 104px identity region. Logo, padding, and gap leave only 36px for a 77px title, rendering `מר...` and weakening orientation between similar operational routes.

**Fix:** Below 360px, prioritize the page title: suppress the redundant home mark visually, tighten inline shell spacing, and turn the three utilities into one coherent control cluster while retaining accessible names and the home link in the drawer.

**Suggested commands:** `/impeccable distill`, `/impeccable adapt`

## [P2] Invoice stage filters delay the first business record

**Why it matters:** Six stage chips, search, the filter-sheet trigger, and upload action compete above the list. The first invoice begins around the middle of a 390px screen.

**Fix:** Keep four high-frequency workflow stages visible on phones; retain every stage in the existing filter sheet and surface any currently active hidden stage.

**Suggested command:** `/impeccable distill`

## [P2] Dashboard loading order conflicts with the settled mobile hierarchy

**Why it matters:** The settled Dashboard deliberately puts money first, then attention, then deliveries. Its skeleton currently suggests deliveries, attention, then money, causing a focus shift when data arrives.

**Fix:** Apply the same responsive order contract to skeleton regions as to settled regions.

**Suggested command:** `/impeccable adapt`

## [P3] Main clearance misses the raised capture envelope by 4-6px

**Why it matters:** No action is blocked, but a final border or content strip can sit beneath the capture puck at maximum scroll.

**Fix:** Calculate main bottom clearance from the full puck envelope, not only the bar height.

**Suggested command:** `/impeccable adapt`

# Persona Red Flags

## Casey — distracted mobile user

The bottom actions work well one-handed, but in landscape the chrome leaves too little task context. At 320px the truncated sticky title removes location after scrolling, and the invoice screen asks Casey to scan too many filters before the first record.

## Alex — power user

Search, direct role actions, active route states, and row menus are efficient. The invoice quick-filter set is not prioritized by operational frequency, so repeated exception scanning starts with unnecessary visual parsing.

## Sam — accessibility-dependent user

Landmarks, semantic busy status, visible focus, labels, and 44px targets are strong. Do not solve the narrow header with smaller targets or unlabeled icons. Any visual hiding must leave accessible names and a discoverable equivalent route.

# Minor Observations

- The fixed bottom bar appearing mid-document in full-page screenshots is a stitching artifact, not a positioning defect.
- Dashboard loading resolved in the fresh local probe and produced no page exception; do not redesign it as a stuck state without production timing evidence.
- Local Supabase Realtime returned WebSocket 503 noise while data still settled; this is not established as a UI defect.
- The shell title and body H1 repeat text, but the H1 preserves document structure and the shell preserves sticky orientation.

# Questions to Consider

- Which shell utilities genuinely deserve permanent space at 320px, and which identity cue can safely become contextual?
- Can the phone invoice list lead with exception work while keeping every audit status one tap away?
- What is the smallest landscape chrome that still feels like SupplyFlow and preserves 44px targets?
