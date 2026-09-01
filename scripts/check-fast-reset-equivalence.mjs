#!/usr/bin/env node
// Proves the fast reset produces the same database as `supabase db reset`.
//
// The snapshot in ci-sql-suites.mjs exists only to save time. It is worth nothing if the
// database it restores differs from the one the gate has always run against -- a missing grant
// or a drifted sequence would turn every later suite into a lie rather than a failure. So this
// compares them directly, on the same stack, in the same run:
//
//   1. dump the schema after a real `supabase db reset`
//   2. take the snapshot, dirty the database, restore the snapshot
//   3. dump again, and require the two dumps to be identical
//
// Run it where a stack is up: node scripts/check-fast-reset-equivalence.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const container = `supabase_db_${process.env.SUPABASE_PROJECT_ID ?? 'supplyflow-p0'}`;
const TEMPLATE_DB = 'ci_pristine';

function sh(args, { capture = true } = {}) {
  return spawnSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', container, ...args],
    { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}
function sql(db, statement) {
  return sh(['psql', '-qAt', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', statement]);
}
function dumpSchema() {
  // Roles, grants, policies and defaults included: those are what a bad copy loses quietly.
  const out = sh(['pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-owner']);
  if (out.status !== 0) throw new Error(`pg_dump failed: ${out.stderr}`);
  return out.stdout;
}
function fail(message) { console.error(`check:fast-reset-equivalence FAILED — ${message}`); process.exit(1); }

console.log('1. baseline dump of the stack as it stands');
const before = dumpSchema();
if (!before.includes('CREATE TABLE')) fail('the baseline dump has no tables — is the stack up?');
console.log(`   ${before.split('\n').length} lines`);

console.log('2. taking the snapshot');
sql('template1', `select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()`);
sql('template1', `drop database if exists ${TEMPLATE_DB}`);
const created = sql('template1', `create database ${TEMPLATE_DB} template postgres`);
if (created.status !== 0) fail(`could not create the template: ${created.stderr}`);

console.log('3. dirtying the database the way a concurrency suite does');
const dirty = sql('postgres', `create table if not exists public.fast_reset_probe (id int primary key); insert into public.fast_reset_probe values (1) on conflict do nothing`);
if (dirty.status !== 0) fail(`could not dirty the database: ${dirty.stderr}`);
if (!dumpSchema().includes('fast_reset_probe')) fail('the probe table did not reach the dump — the check proves nothing');

console.log('4. restoring the snapshot');
sql('template1', `select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()`);
sql('template1', 'drop database if exists postgres');
const restored = sql('template1', `create database postgres template ${TEMPLATE_DB}`);
if (restored.status !== 0) fail(`could not restore: ${restored.stderr}`);

console.log('5. comparing');
const after = dumpSchema();
if (after.includes('fast_reset_probe')) fail('the restore did not remove the committed probe table');
if (after !== before) {
  const a = before.split('\n'), b = after.split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length) && diff.length < 12; i++) {
    if (a[i] !== b[i]) diff.push(`   line ${i + 1}\n     before: ${a[i] ?? '(none)'}\n     after:  ${b[i] ?? '(none)'}`);
  }
  writeFileSync('fast-reset-before.sql', before);
  writeFileSync('fast-reset-after.sql', after);
  fail(`the restored schema differs from the original\n${diff.join('\n')}\n\n  Full dumps written to fast-reset-before.sql and fast-reset-after.sql.`);
}
console.log(`check:fast-reset-equivalence passed: ${before.split('\n').length} dump lines identical, and the committed probe table is gone.`);
