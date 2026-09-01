#!/usr/bin/env node
// Proves the fast reset produces the same database as `supabase db reset`.
//
// The snapshot in ci-sql-suites.mjs exists only to save time. It is worth nothing if the
// database it restores differs from the one the gate has always run against -- a dropped grant
// or a drifted sequence would turn every later suite into a lie rather than a failure. So this
// compares them directly, on the same stack, in the same run:
//
//   1. fingerprint the database
//   2. snapshot it, commit a probe table, restore the snapshot
//   3. fingerprint again, and require the two to be identical and the probe gone
//
// The fingerprint is read from the catalogs rather than from pg_dump. pg_dump is not reliably
// on PATH in the Supabase image -- the first version of this check died on exactly that -- and
// its text output is not order-stable, so an ORDER BY over the catalogs is both more portable
// and a stricter comparison than diffing two dumps.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const container = `supabase_db_${process.env.SUPABASE_PROJECT_ID ?? 'supplyflow-p0'}`;
const TEMPLATE_DB = 'ci_pristine';

function sql(db, statement) {
  return spawnSync('docker', ['exec', '-e', 'PGPASSWORD=postgres', container,
    'psql', '-qAt', '-F', '|', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function fail(message) { console.error(`check:fast-reset-equivalence FAILED — ${message}`); process.exit(1); }

// Everything a bad copy could quietly lose: tables and their columns, constraints, indexes,
// RLS state, policies with their expressions, function bodies, triggers, sequences, grants
// and enum members. Ordered, so the comparison is of content and never of catalog order.
const FINGERPRINT = `
select string_agg(line, E'\\n' order by line) from (
  select 'col|' || c.table_schema||'.'||c.table_name||'.'||c.column_name||'|'||c.data_type
         ||'|'||c.is_nullable||'|'||coalesce(c.column_default,'-') as line
    from information_schema.columns c
   where c.table_schema not in ('pg_catalog','information_schema')
  union all
  select 'con|' || n.nspname||'.'||t.relname||'|'||con.conname||'|'||pg_get_constraintdef(con.oid)
    from pg_constraint con join pg_class t on t.oid=con.conrelid join pg_namespace n on n.oid=t.relnamespace
   where n.nspname not in ('pg_catalog','information_schema')
  union all
  select 'idx|' || schemaname||'.'||tablename||'|'||indexname||'|'||indexdef from pg_indexes
   where schemaname not in ('pg_catalog','information_schema')
  union all
  select 'rls|' || n.nspname||'.'||c.relname||'|'||c.relrowsecurity::text||'|'||c.relforcerowsecurity::text
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema')
  union all
  select 'pol|' || schemaname||'.'||tablename||'|'||policyname||'|'||coalesce(qual,'-')||'|'||coalesce(with_check,'-')
         ||'|'||cmd||'|'||array_to_string(roles,',') from pg_policies
  union all
  select 'fun|' || n.nspname||'.'||p.proname||'|'||md5(pg_get_functiondef(p.oid))||'|'||p.prosecdef::text
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
  union all
  select 'trg|' || n.nspname||'.'||c.relname||'|'||t.tgname||'|'||pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where not t.tgisinternal and n.nspname not in ('pg_catalog','information_schema')
  union all
  select 'seq|' || schemaname||'.'||sequencename||'|'||coalesce(last_value::text,'-') from pg_sequences
   where schemaname not in ('pg_catalog','information_schema')
  union all
  select 'acl|' || table_schema||'.'||table_name||'|'||grantee||'|'||privilege_type
    from information_schema.role_table_grants
   where table_schema not in ('pg_catalog','information_schema')
  union all
  select 'enu|' || n.nspname||'.'||t.typname||'|'||e.enumlabel||'|'||e.enumsortorder::text
    from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
) parts`;

function fingerprint(label) {
  const out = sql('postgres', FINGERPRINT);
  if (out.status !== 0) fail(`could not fingerprint (${label}): status ${out.status}, ${(out.stderr ?? '').trim().slice(0, 200)}`);
  const text = (out.stdout ?? '').trim();
  if (text.split('\n').length < 500) fail(`the ${label} fingerprint has only ${text.split('\n').length} lines — the stack is not migrated, so this check would prove nothing`);
  return text;
}
// Nothing may hold a connection to a database being used as a template or being dropped, and
// TERMINATING is not enough: Supabase's own services reconnect between the terminate and the
// CREATE, and Postgres refuses with "source database is being accessed by other users". So
// connections are DISALLOWED first, which no reconnect can defeat, and allowed again in a
// finally: a database left with datallowconn=false is a bricked stack. The SQL job needs none of
// those services; it uses `docker exec psql`.
//
// AND THEN IT WAITS, which the first version did not. `datallowconn = false` stops NEW
// connections; it does not hang up the ones already open. `pg_terminate_backend` only SIGNALS a
// backend — it returns before the process is gone. `CREATE DATABASE ... TEMPLATE` ran into that
// gap and Postgres refused with "There are 2 other sessions using the database", which is how
// this failed on PR #213's first CI run. Signalling is not the same as being alone, so the
// count is read back until it is zero.
//
// The `alter` is checked too. It was assumed to succeed, and a silent failure there would have
// left every later error pointing at the wrong thing.
function withConnectionsBlocked(database, body) {
  const blocked = sql('template1', `alter database ${database} with allow_connections false`);
  if (blocked.status !== 0) {
    throw new Error(`could not disallow connections to ${database}: `
      + `${(blocked.stderr ?? '').trim().split('\n')[0]}`);
  }
  try {
    sql('template1', `select pg_terminate_backend(pid) from pg_stat_activity`
      + ` where datname = '${database}' and pid <> pg_backend_pid()`);
    // Up to ~10s. A backend that will not die in that long is not a race, it is a stuck session,
    // and the caller's own error is a better report than a longer wait would be.
    const others = () => Number(
      (sql('template1', `select count(*) from pg_stat_activity`
        + ` where datname = '${database}' and pid <> pg_backend_pid()`).stdout ?? '').trim() || '0');
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let i = 0; i < 100 && others() > 0; i += 1) pause(100);
    return body();
  } finally {
    sql('template1', `alter database ${database} with allow_connections true`);
  }
}

console.log('1. fingerprinting the migrated stack');
const before = fingerprint('baseline');
console.log(`   ${before.split('\n').length} catalog facts`);

console.log('2. taking the snapshot');
sql('template1', `drop database if exists ${TEMPLATE_DB}`);
const created = withConnectionsBlocked('postgres', () =>
  sql('template1', `create database ${TEMPLATE_DB} template postgres`));
sql('template1', `alter database ${TEMPLATE_DB} with allow_connections true`);
if (created.status !== 0) fail(`could not create the template: ${(created.stderr ?? '').trim().slice(0, 200)}`);

console.log('3. committing a probe, the way a concurrency suite commits fixtures');
const dirty = sql('postgres', 'create table public.fast_reset_probe (id int primary key)');
if (dirty.status !== 0) fail(`could not commit the probe: ${(dirty.stderr ?? '').trim().slice(0, 200)}`);
if (!fingerprint('dirtied').includes('fast_reset_probe')) fail('the probe never reached the fingerprint — the check would prove nothing');

console.log('4. restoring the snapshot');
const restored = withConnectionsBlocked('postgres', () => {
  const dropped = sql('template1', 'drop database if exists postgres');
  if (dropped.status !== 0) fail(`could not drop: ${(dropped.stderr ?? '').trim().slice(0, 200)}`);
  return sql('template1', `create database postgres template ${TEMPLATE_DB}`);
});
sql('template1', 'alter database postgres with allow_connections true');
if (restored.status !== 0) fail(`could not restore: ${(restored.stderr ?? '').trim().slice(0, 200)}`);

console.log('5. comparing');
const after = fingerprint('restored');
if (after.includes('fast_reset_probe')) fail('the restore left the committed probe table behind');
if (after !== before) {
  const a = new Set(before.split('\n')), b = new Set(after.split('\n'));
  const lost = [...a].filter((l) => !b.has(l)).slice(0, 10);
  const gained = [...b].filter((l) => !a.has(l)).slice(0, 10);
  writeFileSync('fingerprint-before.txt', before);
  writeFileSync('fingerprint-after.txt', after);
  fail('the restored database differs from the original\n'
    + (lost.length ? `\n  LOST (${lost.length} shown):\n${lost.map((l) => '    ' + l.slice(0, 150)).join('\n')}` : '')
    + (gained.length ? `\n  GAINED (${gained.length} shown):\n${gained.map((l) => '    ' + l.slice(0, 150)).join('\n')}` : '')
    + '\n\n  Full fingerprints written to fingerprint-before.txt and fingerprint-after.txt.');
}
console.log(`check:fast-reset-equivalence passed: ${before.split('\n').length} catalog facts identical after a snapshot restore, and the committed probe is gone.`);
