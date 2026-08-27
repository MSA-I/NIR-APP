# Gates: InPlace owner decisions console

OWNS: tools/owner-decisions/**, scripts/owner-decisions-server.mjs, START-OWNER-DECISIONS.cmd, package.json, PLAN.md

Scope: local-only RTL decision console with complete source coverage, safe autosave, historical reconsideration, stale-source protection and visual proof

- [x] G1: catalog covers every current decision and debt without invented identifiers
  CHECK: npm.cmd run test:owner-decisions
  EXPECT: owner-decisions tests passed
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=ℹ duration_ms 471.0786 | owner-decisions tests passed

- [x] G2: generated catalog has plain-language copy, consequences and glossary coverage for every item
  CHECK: node tools/owner-decisions/tests/verify-catalog.mjs
  EXPECT: owner-decisions catalog verified
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=owner-decisions catalog verified

- [x] G3: local server autosaves atomically, restores state, rejects stale or invalid writes and remains loopback-only
  CHECK: node tools/owner-decisions/tests/verify-server.mjs
  EXPECT: owner-decisions server verified
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=owner-decisions server verified

- [x] G4: repository build and static verification remain green
  CHECK: npm.cmd run check
  EXPECT: built in
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=vitest.config.ts    knip.json  Remove redundant entry pattern | .css                knip.json  Compiled extension excluded by project (imports not followed)

- [x] G5: browser flow passes at mobile, desktop and 200 percent zoom with screenshots
  CHECK: node tools/owner-decisions/tests/verify-browser.mjs
  EXPECT: owner-decisions browser verified
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=owner-decisions browser verified

- [x] G6: screenshots visually match the quiet-control-room direction and expose no clipping or unreadable copy
  EVIDENCE: reviewer verdict PASS_WITH_NOTES; desktop/mobile shell and decision screenshots inspected at original size; no material clipping, unreadable copy or required pre-delivery fix; horizontal mobile summary/filter scrolling is a low-severity note with visible continuation cue

- [x] G7: implementation stays within the isolated worktree and leaves canonical decision documents unchanged
  CHECK: node tools/owner-decisions/tests/verify-scope.mjs
  EXPECT: owner-decisions scope verified
  CWD: ../..
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-WORKTREES\owner-decisions-console; path=3d825e46fa08/44 entries; output=owner-decisions scope verified
