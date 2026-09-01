#!/usr/bin/env node
/**
 * check:gate-controls — the guards are themselves guarded.
 *
 * A guard that has never been observed to fail is not a guard; it is a line in a config file
 * that everyone believes. This repo has already shipped one of those: `gate-i18n.mjs` sat with
 * three red gates for days because nothing ran it, and merge 7278f787 silently orphaned 439
 * `t()` calls without a single test going red.
 *
 * So each guard below is handed a deliberately broken input and MUST exit non-zero. If a guard
 * passes an input that is obviously wrong, the guard is broken and this script fails the build —
 * which is the only way a green tick means anything.
 *
 * Every mutation happens on a COPY in a scratch directory. Nothing here writes to the tree.
 */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'gate-controls-'));

let failures = 0;
let ran = 0;

/**
 * Run a guard and assert it exits non-zero. `expect` is a fragment that must appear in the
 * output, so a guard that fails for an unrelated reason does not count as a pass.
 */
function mustFail(name, script, { env = {}, expect }) {
  ran += 1;
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', script)], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    exitCode = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (exitCode === 0) {
    failures += 1;
    console.error(`  ✗ ${name}\n      the guard PASSED an input that is broken on purpose.`);
    return;
  }
  if (expect && !output.includes(expect)) {
    failures += 1;
    console.error(`  ✗ ${name}\n      the guard failed, but not for the expected reason.\n`
      + `      wanted to see: ${expect}\n      got: ${output.split('\n').slice(0, 4).join(' / ')}`);
    return;
  }
  console.log(`  ✓ ${name}`);
}

function mustPass(name, script, { env = {} }) {
  ran += 1;
  try {
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', script)], {
      encoding: 'utf8', cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}\n      the guard FAILED on an input that is correct.\n`
      + `      ${String(error.stdout ?? error.stderr ?? '').split('\n').slice(0, 4).join(' / ')}`);
  }
}

// ============================================================ suite manifest
console.log('\ncheck:suite-manifest');
{
  const realGate = path.join(repoRoot, 'scripts', 'check-quality-gates.ps1');
  const realBaseline = path.join(repoRoot, 'scripts', 'suite-manifest.baseline.json');
  if (!existsSync(realBaseline)) {
    console.error('  ! no baseline yet — run: node scripts/check-suite-manifest.mjs --write');
    failures += 1;
  } else {
    const source = readFileSync(realGate, 'utf8');
    const baseline = readFileSync(realBaseline, 'utf8');
    const copyBaseline = path.join(scratch, 'baseline.json');
    writeFileSync(copyBaseline, baseline, 'utf8');

    // The registry lines we are allowed to mutate are the ones in the executable region.
    const startIndex = source.indexOf('$qaMutex = Enter-QaMutex');
    const head = source.slice(0, startIndex);
    const body = source.slice(startIndex);
    const suiteLines = [...body.matchAll(/^[ \t]*Invoke-SqlTest\b.*$/gm)].map((m) => m[0]);

    // control 1 — a suite disappears (the 7278f787-shaped accident)
    const dropped = suiteLines[Math.floor(suiteLines.length / 2)];
    const withDrop = path.join(scratch, 'gate-dropped.ps1');
    writeFileSync(withDrop, head + body.replace(dropped, ''), 'utf8');
    mustFail('a deleted suite is caught', 'check-suite-manifest.mjs', {
      env: { SUITE_MANIFEST_GATE_PATH: withDrop, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
      expect: 'DISAPPEARED',
    });

    // control 2 — a suite is registered twice
    const withDupe = path.join(scratch, 'gate-duped.ps1');
    writeFileSync(withDupe, head + body.replace(dropped, `${dropped}\n${dropped}`), 'utf8');
    mustFail('a duplicated suite is caught', 'check-suite-manifest.mjs', {
      env: { SUITE_MANIFEST_GATE_PATH: withDupe, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
      expect: 'more than once',
    });

    // control 3 — two suites swap places. Same count, same set: only order changed.
    const a = suiteLines[1];
    const b = suiteLines[2];
    const withSwap = path.join(scratch, 'gate-swapped.ps1');
    writeFileSync(withSwap, head + body.replace(a, ' A ').replace(b, a).replace(' A ', b), 'utf8');
    mustFail('a reordered suite is caught', 'check-suite-manifest.mjs', {
      env: { SUITE_MANIFEST_GATE_PATH: withSwap, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
      expect: 'order changed',
    });

    // control 4 — an ADDED suite must fail too. Tolerating additions silently opens a
    // two-wave hole: wave N adds a suite without re-baselining, wave N+1 deletes it, the tree
    // matches the stale baseline again, and the suite is gone with every check green.
    const withAdd = path.join(scratch, 'gate-added.ps1');
    // Inserted INSIDE the registry, at the same brace depth and indentation as a real call.
    // Appending it at the end of the file would trip the block-depth rule instead and the
    // control would pass for the wrong reason.
    const indent = dropped.match(/^[ \t]*/)[0];
    const addedLine = indent + 'Invoke-SqlTest "supabase\\\\tests\\\\p999_injected.sql" "Injected by the control"';
    writeFileSync(withAdd, head + body.replace(dropped, dropped + String.fromCharCode(10) + addedLine), 'utf8');
    mustFail('an added suite is caught', 'check-suite-manifest.mjs', {
      env: { SUITE_MANIFEST_GATE_PATH: withAdd, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
      expect: 'not in the baseline',
    });

    // control 5b — the subtler shape: the call STARTS its line, so the token count matches, both
    // parsers claim it, and the baseline stays valid. Only the block it sits in gives it away.
    const withBlock = path.join(scratch, 'gate-blocked.ps1');
    writeFileSync(withBlock, head + body.replace(dropped,
      '    if ($true) {' + String.fromCharCode(10) + dropped + String.fromCharCode(10) + '    }'), 'utf8');
    mustFail('a canonical-looking call nested inside a conditional block is caught',
      'check-suite-manifest.mjs', {
        env: { SUITE_MANIFEST_GATE_PATH: withBlock, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
        expect: 'nested inside a block',
      });

    // control 5 — a call the PowerShell gate runs but neither parser can see. This is the
    // shape that would enter no baseline and run in no CI job while everything exits 0.
    const withWrapped = path.join(scratch, 'gate-wrapped.ps1');
    writeFileSync(withWrapped, head + body.replace(dropped,
      'if ($true) { ' + dropped.trim() + ' }'), 'utf8');
    mustFail('a call wrapped in a conditional is caught', 'check-suite-manifest.mjs', {
      env: { SUITE_MANIFEST_GATE_PATH: withWrapped, SUITE_MANIFEST_BASELINE_PATH: copyBaseline },
      expect: 'this guard cannot see',
    });

    // control 5 — the untouched registry must still pass, or the four above prove nothing
    mustPass('the real registry still passes', 'check-suite-manifest.mjs', {});
  }
}

// ============================================================ migration numbers
console.log('\ncheck:migration-numbers');
{
  const migrations = path.join(repoRoot, 'supabase', 'migrations');
  mustFail('a duplicate migration number is caught', 'check-migration-numbers.mjs', {
    env: { MIGRATION_NUMBERS_INJECT: 'duplicate', MIGRATION_NUMBERS_DIR: migrations },
    expect: 'used twice',
  });
  mustFail('a gap in the migration sequence is caught', 'check-migration-numbers.mjs', {
    env: { MIGRATION_NUMBERS_INJECT: 'gap', MIGRATION_NUMBERS_DIR: migrations },
    expect: 'gap',
  });
  mustFail('deleting the HIGHEST migration is caught (it makes no gap)', 'check-migration-numbers.mjs', {
    env: { MIGRATION_NUMBERS_INJECT: 'delete-head', MIGRATION_NUMBERS_DIR: migrations },
    expect: 'DISAPPEARED',
  });
  mustPass('the real migration sequence still passes', 'check-migration-numbers.mjs', {});
}

// ============================================================ renumber closure
console.log('\ncheck:renumber-closure');
  mustFail('a stale dollar tag of ANY name is caught', 'check-renumber-closure.mjs', {
    env: { RENUMBER_CLOSURE_INJECT: 'dollartag' },
    expect: 'dollar tag',
  });
{
  mustFail('a stale raise-exception prefix is caught', 'check-renumber-closure.mjs', {
    env: { RENUMBER_CLOSURE_INJECT: 'prefix' },
    expect: 'names a different migration',
  });
  mustFail('a stale external reference is caught', 'check-renumber-closure.mjs', {
    env: { RENUMBER_CLOSURE_INJECT: 'external' },
    expect: 'at a migration filename that does not exist',
  });
  mustPass('the real tree still passes', 'check-renumber-closure.mjs', {});
}

// ============================================================ key manifest
console.log('\ncheck:key-manifest');
{
  mustFail('a key that loses its last production call site is caught', 'check-key-manifest.mjs', {
    env: { KEY_MANIFEST_INJECT: 'strand' },
    expect: 'LOST their last production call site',
  });
  // The attack a count cannot see: wire one orphan and strand another in the same wave, and
  // the total never moves. Names move, so this must still fail.
  mustFail('stranding one key while wiring another is caught (total unchanged)', 'check-key-manifest.mjs', {
    env: { KEY_MANIFEST_INJECT: 'offset' },
    expect: 'LOST their last production call site',
  });
  // Not deleted — COMMENTED OUT. A guard that greps the whole file sees no change at all.
  mustFail('a call site that is commented out rather than deleted is caught', 'check-key-manifest.mjs', {
    env: { KEY_MANIFEST_INJECT: 'commented' },
    expect: 'LOST their last production call site',
  });
  mustPass('the real dictionary still passes', 'check-key-manifest.mjs', {});
}

// ============================================================ renumber map mode
// Wave 4's renumber is a CYCLE (0281->0279, 0279->0280, 0280->0281), so every `from` number is
// somebody else's legitimate `to`. These two controls are the difference between a map that
// guards the cycle and one that condemns it.
console.log('\ncheck:renumber-closure (map mode)');
{
  // eslint-disable-next-line no-var
  var target = '0267_forecast_cohort_joins_the_teardown_window.sql';
  const okMap = path.join(scratch, 'map-complete.json');
  writeFileSync(okMap, JSON.stringify([{
    fromFile: '9998_a_name_it_used_to_have.sql', toFile: target, fromNumber: '9998',
    references: [], why: 'control: a finished move',
  }], null, 2), 'utf8');
  mustPass('a completed move passes, and the number it moved TO is not banned elsewhere',
    'check-renumber-closure.mjs', { env: { RENUMBER_MAP_PATH: okMap } });

  const badMap = path.join(scratch, 'map-incomplete.json');
  writeFileSync(badMap, JSON.stringify([{
    fromFile: '9997_a_name_it_used_to_have.sql', toFile: target, fromNumber: '0267',
    references: [], why: 'control: renamed, innards left behind',
  }], null, 2), 'utf8');
  mustFail('a move whose innards still carry the old number is caught',
    'check-renumber-closure.mjs', { env: { RENUMBER_MAP_PATH: badMap }, expect: 'survive inside the moved file' });

  const missingRef = path.join(scratch, 'map-missing-ref.json');
  writeFileSync(missingRef, JSON.stringify([{
    fromFile: '9996_a_name_it_used_to_have.sql', toFile: target, fromNumber: '9996',
    references: ['supabase/tests/p1_preflight.sql'], why: 'control: a declared reference that still says nothing',
  }], null, 2), 'utf8');
  mustPass('a declared reference that no longer carries the old number passes',
    'check-renumber-closure.mjs', { env: { RENUMBER_MAP_PATH: missingRef } });

  // A REAL cycle case. `9998` proves little: no other migration legitimately owns it, so even a
  // wrong global-ban implementation would pass. This picks a number that IS a live migration
  // elsewhere while being absent from the moved file — exactly the wave 4 shape, where 0279 is
  // #191's new identity and #192's old one at the same time.
  {
    // A DISCRIMINATING cycle case. 0267 is a live migration that carries its own number eight
    // times, so a wrong global-ban implementation would find those and fail. The correct per-file
    // implementation passes, because the file being MOVED (0001_init.sql) does not contain 0267.
    // That is the wave 4 shape: 0279 is #191's new identity and #192's old one at once.
    const cycleMap = path.join(scratch, 'map-real-cycle.json');
    writeFileSync(cycleMap, JSON.stringify([{
      fromFile: '9994_a_name_it_used_to_have.sql', toFile: '0001_init.sql', fromNumber: '0267',
      references: [],
      why: 'control: 0267 lives on in its own migration and must not be banned repo-wide',
    }], null, 2), 'utf8');
    mustPass('a completed move passes while its old number stays live in another migration',
      'check-renumber-closure.mjs', { env: { RENUMBER_MAP_PATH: cycleMap } });

    // A declared reference that has NOT been updated must fail. Previously only the passing
    // direction was covered, so the reference check itself was never observed to work.
    const staleRefMap = path.join(scratch, 'map-stale-ref.json');
    writeFileSync(staleRefMap, JSON.stringify([{
      // toFile is a file whose body does NOT carry 0267, so the only thing that can fail is
      // the declared reference — which does carry it. That isolates the reference check.
      fromFile: '9995_a_name_it_used_to_have.sql', toFile: '0001_init.sql', fromNumber: '0267',
      references: [`supabase/migrations/${target}`],
      why: 'control: the declared reference still carries the old number',
    }], null, 2), 'utf8');
    mustFail('a declared reference still carrying the old number is caught',
      'check-renumber-closure.mjs', { env: { RENUMBER_MAP_PATH: staleRefMap }, expect: 'now names a DIFFERENT migration' });
  }
}

// ============================================================ baseline drift
// The attack every other guard is blind to: break the tree, run --write, and the pin agrees
// with the breakage. Only a comparison against the PREVIOUS pin can see it. Mutating a tracked
// file is unavoidable here, so it is saved and restored in a finally.
console.log('\ncheck:baseline-drift');
{
  const suiteBaseline = path.join(repoRoot, 'scripts', 'suite-manifest.baseline.json');
  const original = readFileSync(suiteBaseline, 'utf8');
  try {
    const pinned = JSON.parse(original);
    const withoutOne = pinned.filter((e, idx) => !(e.kind === 'suite' && idx === pinned.findIndex((x) => x.kind === 'suite')));
    writeFileSync(suiteBaseline, `${JSON.stringify(withoutOne, null, 2)}\n`, 'utf8');
    mustFail('deleting a suite and re-pinning the baseline is caught', 'check-baseline-drift.mjs', {
      env: { BASELINE_DRIFT_BASE: 'HEAD' },
      expect: 'were removed, or survived but changed order',
    });
  } finally {
    writeFileSync(suiteBaseline, original, 'utf8');
  }
  mustPass('the real baselines still pass', 'check-baseline-drift.mjs', { env: { BASELINE_DRIFT_BASE: 'HEAD' } });
}

// ============================================================ decision numbers
// Two owner rulings sharing a number is the one collision a merge does NOT report: both
// pull requests append a row, git puts them side by side, and the merge is 'clean'.
console.log('\ncheck:decision-numbers');
{
  mustFail('a duplicated ruling number is caught', 'check-decision-numbers.mjs', {
    env: { DECISION_NUMBERS_INJECT: 'duplicate' },
    expect: 'used more than once',
  });
  mustFail('a citation of a ruling that does not exist is caught', 'check-decision-numbers.mjs', {
    env: { DECISION_NUMBERS_INJECT: 'dangling' },
    expect: 'point at a ruling that is not in the table',
  });
  // The rulings are cited from the code itself — 1,612 times. A stale one there still names a
  // REAL ruling, so it reads as authoritative while describing a different decision.
  mustFail('a code citation of a ruling that does not exist is caught', 'check-decision-numbers.mjs', {
    env: { DECISION_NUMBERS_INJECT: 'code' },
    expect: 'in the CODE name a ruling',
  });
  mustPass('the real decision table still passes', 'check-decision-numbers.mjs', {});
}

// ============================================================ wiring proof
// Every guard above is only real if something runs it. Deleting `check:migration-numbers` from
// package.json, or its step from build.yml, would leave every control passing while the guard
// never executed again — the same failure as a guard that cannot fail, one level up.
console.log('\nwiring');
{
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'build.yml'), 'utf8');
  const required = ['check:suite-manifest', 'check:migration-numbers', 'check:renumber-closure',
    'check:key-manifest', 'check:baseline-drift', 'check:decision-numbers', 'check:gate-controls'];
  const missingScript = required.filter((c) => !pkg.scripts?.[c]);
  const missingVerify = required.filter((c) => !String(pkg.scripts?.verify ?? '').includes(c));
  const missingStep = required.filter((c) => !workflow.includes(`npm run ${c}`));
  ran += 1;
  if (missingScript.length || missingVerify.length || missingStep.length) {
    failures += 1;
    console.error('  ✗ every guard is reachable from package.json AND build.yml');
    if (missingScript.length) console.error(`      no npm script: ${missingScript.join(', ')}`);
    if (missingVerify.length) console.error(`      not in \`verify\`: ${missingVerify.join(', ')}`);
    if (missingStep.length) console.error(`      no build.yml step: ${missingStep.join(', ')}`);
  } else {
    console.log(`  ✓ all ${required.length} guards reachable from package.json and build.yml`);
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`check:gate-controls FAILED — ${failures} of ${ran} control(s) did not behave.\n`
    + '  A guard that does not fail on a broken input cannot be trusted on a good one.');
  process.exit(1);
}
console.log(`check:gate-controls passed: ${ran} controls, every guard failed exactly when it should.`);
