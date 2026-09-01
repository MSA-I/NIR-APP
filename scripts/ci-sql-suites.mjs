// Runs the gate's SQL half on Linux CI, without PowerShell.
//
// The suite list is NOT copied here. It is parsed out of check-quality-gates.ps1 at run time,
// so CI and the manual gate can never disagree about which suites exist, in what order, under
// which database role, or where the mid-run resets fall. Six waves of drift in this repo came
// from a second copy of a list; this is the same list, read once.
//
// Usage:  node scripts/ci-sql-suites.mjs [--list]
//   --list   print the parsed sequence and exit (no database needed)

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const gatePath = path.join(repoRoot, 'scripts', 'check-quality-gates.ps1');
const container = 'supabase_db_supplyflow-p0';

// Only the executable region matters. Invoke-SqlTest also appears inside its own function
// definition and in the fixture loaders above it; the sequence we want is the one after the
// mutex is taken, which is where the run actually begins.
const source = readFileSync(gatePath, 'utf8');
const startIndex = source.indexOf('$qaMutex = Enter-QaMutex');
if (startIndex < 0) throw new Error('Could not find the start of the gate run in check-quality-gates.ps1');
const body = source.slice(startIndex);
const preflightRelPath = 'supabase/tests/p1_preflight.sql';
const preflightSource = readFileSync(path.join(repoRoot, preflightRelPath), 'utf8');
const expectedPreflightRows = [...preflightSource.matchAll(/select\s+'/g)].length;
if (expectedPreflightRows === 0) {
  throw new Error('Parsed zero preflight arms from p1_preflight.sql');
}

/** @type {{kind:string,relPath?:string,label:string,user?:string}[]} */
const sequence = [];
const lineRe = /^\s*(Invoke-SqlTest|Invoke-Preflight|Reset-LocalDatabase)\b(.*)$/gm;
for (const match of body.matchAll(lineRe)) {
  const [, kind, rest] = match;
  if (kind === 'Reset-LocalDatabase') {
    sequence.push({ kind: 'reset', label: 'supabase db reset' });
    continue;
  }
  if (kind === 'Invoke-Preflight') {
    sequence.push({
      kind: 'preflight',
      relPath: preflightRelPath,
      label: `P1 preflight (${expectedPreflightRows} anomaly checks)`,
    });
    continue;
  }
  // Invoke-SqlTest "supabase\tests\x.sql" "Label" ["role"]
  const args = [...rest.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (args.length < 2) throw new Error(`Unparsable Invoke-SqlTest call: ${match[0].trim()}`);
  sequence.push({
    kind: 'suite',
    relPath: args[0].replace(/\\/g, '/'),
    label: args[1],
    user: args[2] ?? 'postgres',
  });
}

// The manual PowerShell gate performs two final resets before Edge/browser work. This runner ends
// after SQL, so carrying those trailing resets into CI only rebuilds the same database twice with
// no consumer. Resets between SQL suites remain part of the parsed sequence.
while (sequence.at(-1)?.kind === 'reset') sequence.pop();

const suites = sequence.filter((s) => s.kind === 'suite');
if (suites.length === 0) throw new Error('Parsed zero SQL suites — the parser and the gate have diverged.');

// One-off mode for the fixture loads the browser job needs (demo_seed, browser-fixture, …).
// Same transport as the suites so a fixture failure reads identically to a suite failure.
const fileFlag = process.argv.indexOf('--file');
if (fileFlag >= 0) {
  const relPath = process.argv[fileFlag + 1];
  const role = process.argv[fileFlag + 2] ?? 'postgres';
  if (!relPath) throw new Error('--file needs a repository-relative path');
  const containerPath = `/var/lib/postgresql/ci-${path.basename(relPath)}`;
  const copy = spawnSync('docker', ['cp', path.join(repoRoot, relPath), `${container}:${containerPath}`],
    { stdio: 'inherit' });
  if (copy.status !== 0) process.exit(copy.status ?? 1);
  const run1 = spawnSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', '-e', 'PGTZ=Asia/Jerusalem', container,
    'psql', '-U', role, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', containerPath], { stdio: 'inherit' });
  process.exit(run1.status ?? 1);
}

if (process.argv.includes('--list')) {
  for (const step of sequence) {
    const role = step.user && step.user !== 'postgres' ? `  [${step.user}]` : '';
    console.log(`${step.kind.padEnd(9)} ${(step.relPath ?? '').padEnd(52)} ${step.label}${role}`);
  }
  console.log(`\n${suites.length} SQL suites, ${sequence.filter((s) => s.kind === 'reset').length} resets, ` +
    `${sequence.filter((s) => s.kind === 'preflight').length} preflight`);
  process.exit(0);
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'postgres', PGTZ: 'Asia/Jerusalem' },
  });
  if (result.error) throw result.error;
  return result;
}

function psql(relPath, user) {
  const containerPath = `/var/lib/postgresql/ci-${path.basename(relPath)}`;
  const copy = run('docker', ['cp', path.join(repoRoot, relPath), `${container}:${containerPath}`], { capture: true });
  if (copy.status !== 0) throw new Error(`docker cp failed for ${relPath}: ${copy.stderr}`);
  return { containerPath, user };
}


// ---------------------------------------------------------------- the mid-run resets
// MEASURED 01.09.2026: `supabase db reset` takes 323s and the job performs it three times, on
// top of the 380s `supabase start` already spent applying the same migrations. That is ~22 of
// the job's ~28 minutes replaying 272 migrations four times. The suites themselves total about
// a minute -- the slowest is 21s and most are under three.
//
// The resets are NOT gratuitous: each follows a concurrency suite that must COMMIT to prove
// anything, so it cannot roll back its fixtures. What is gratuitous is rebuilding the schema
// from scratch to delete a handful of committed rows.
//
// So the schema is built once and copied. `CREATE DATABASE ... TEMPLATE` is a file copy inside
// one Postgres instance; the migrations do not run again. The fallback is the real reset, so a
// snapshot that cannot be taken costs time and never correctness.
const TEMPLATE_DB = 'ci_pristine';

function sql(database, statement) {
  return run('docker', ['exec', '-e', 'PGPASSWORD=postgres', container,
    'psql', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { capture: true });
}

// Nothing may hold a connection to a database being used as a template or being dropped, and
// TERMINATING is not enough: Supabase's own services reconnect between the terminate and the
// CREATE, and Postgres refuses with "source database is being accessed by other users" -- which
// is exactly how the first attempt at this failed. So connections are DISALLOWED first, which no
// reconnect can defeat, and allowed again in a finally: a database left with datallowconn=false
// is a bricked stack. The SQL job needs none of those services; it uses `docker exec psql`.
function withConnectionsBlocked(database, body) {
  sql('template1', `alter database ${database} with allow_connections false`);
  sql('template1', `select pg_terminate_backend(pid) from pg_stat_activity`
    + ` where datname = '${database}' and pid <> pg_backend_pid()`);
  try {
    return body();
  } finally {
    sql('template1', `alter database ${database} with allow_connections true`);
  }
}

function takeSnapshot() {
  const started = Date.now();
  sql('template1', `drop database if exists ${TEMPLATE_DB}`);
  const created = withConnectionsBlocked('postgres', () =>
    sql('template1', `create database ${TEMPLATE_DB} template postgres`));
  if (created.status !== 0) {
    console.log(`  snapshot unavailable, every reset will rebuild from migrations:`
      + ` ${(created.stderr ?? '').trim().split('\n')[0]}`);
    return false;
  }
  // A database created with TEMPLATE inherits datallowconn from its source, and the source had
  // connections disallowed a moment ago. Leaving that inherited would make every restore produce
  // a database nothing can connect to, and the failure would surface as 114 broken suites.
  sql('template1', `alter database ${TEMPLATE_DB} with allow_connections true`);
  console.log(`  pristine snapshot taken in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

function restoreSnapshot() {
  const done = withConnectionsBlocked('postgres', () => {
    const dropped = sql('template1', 'drop database if exists postgres');
    if (dropped.status !== 0) return false;
    return sql('template1', `create database postgres template ${TEMPLATE_DB}`).status === 0;
  });
  // The finally above re-allowed connections on a database that no longer existed by then; the
  // new `postgres` carries whatever the template had, so it is set explicitly.
  sql('template1', 'alter database postgres with allow_connections true');
  return done;
}

let failures = 0;
const snapshotOptOut = process.env.CI_SQL_NO_SNAPSHOT === '1';
let snapshotReady = snapshotOptOut ? false : takeSnapshot();
const timings = [];

for (const step of sequence) {
  const started = Date.now();
  let ok = true;

  if (step.kind === 'reset') {
    console.log(`\n== ${step.label}`);
    if (snapshotReady && restoreSnapshot()) {
      ok = true;
    } else {
      // The snapshot is an optimisation, never an authority. Anything unexpected falls back to
      // the reset this runner has always performed, and says so.
      if (snapshotReady) console.log('  snapshot restore failed — falling back to supabase db reset');
      const reset = run('supabase', ['db', 'reset']);
      ok = reset.status === 0;
      if (ok) snapshotReady = takeSnapshot();
    }
  } else if (step.kind === 'preflight') {
    console.log(`\n== ${step.label}`);
    const { containerPath } = psql(step.relPath, 'postgres');
    // Preflight is a report, not an assertion script: it returns one row per check and the
    // gate requires every arm declared in the canonical SQL file, all with rows_found=0.
    const out = run('docker', ['exec', '-e', 'PGPASSWORD=postgres', container,
      'psql', '-qAt', '-F', '|', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
      { capture: true });
    process.stdout.write(out.stdout ?? '');
    const rows = (out.stdout ?? '').split('\n').filter((l) => /^([^|]+)\|([0-9]+)\|/.test(l));
    const bad = rows.filter((l) => Number(l.split('|')[1]) !== 0);
    if (out.status !== 0) { ok = false; console.error(out.stderr); }
    else if (rows.length !== expectedPreflightRows) {
      ok = false;
      console.error(`P1 preflight returned ${rows.length} rows instead of ${expectedPreflightRows}.`);
    }
    else if (bad.length) { ok = false; console.error(`P1 preflight found anomalies: ${bad.join('; ')}`); }
    else console.log(`P1 preflight passed: ${expectedPreflightRows}/${expectedPreflightRows} checks returned rows_found=0.`);
  } else {
    console.log(`\n== ${step.label}`);
    const { containerPath, user } = psql(step.relPath, step.user);
    const out = run('docker', ['exec', '-e', 'PGPASSWORD=postgres', '-e', 'PGTZ=Asia/Jerusalem', container,
      'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', containerPath]);
    ok = out.status === 0;
  }

  const seconds = (Date.now() - started) / 1000;
  timings.push({ label: step.label, seconds, ok });
  if (!ok) {
    failures += 1;
    console.error(`FAIL: ${step.label}`);
  }
  console.log(`-- ${step.label} took ${seconds.toFixed(1)}s`);
}

const total = timings.reduce((sum, t) => sum + t.seconds, 0);
console.log('\n== Stage timings (slowest first)');
for (const t of [...timings].sort((a, b) => b.seconds - a.seconds)) {
  const share = total > 0 ? (t.seconds / total) * 100 : 0;
  console.log(`${t.seconds.toFixed(1).padStart(8)}s ${share.toFixed(1).padStart(5)}%  ${t.ok ? ' ' : 'x'} ${t.label}`);
}
console.log(`${total.toFixed(1).padStart(8)}s         TOTAL across ${timings.length} stages, ${failures} failed`);

// This runner resets the database, which drops the demo tenant with it. On CI that is the end
// of the story; on a developer machine it leaves a stack nobody can sign in to. The restore is
// Windows-and-manifest-only and -Quiet exits 0 when either is absent, so CI no-ops here. It is
// deliberately outside the failure count: a failed restore must not turn a red suite green or
// a green suite red.
if (process.platform === 'win32' && !process.env.CI) {
  const restoreScript = path.join(repoRoot, 'scripts', 'restore-demo-local.ps1');
  console.log('\n== Restoring the local demo accounts');
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', restoreScript, '-Quiet']);
}

process.exit(failures ? 1 : 0);
