// The measurement taken immediately before a production rollout, and again after it.
//
// WHY IT EXISTS. The 25.08.2026 rollout recorded functions 515->630, tables 129->140,
// policies 180->181, definer 386->475, `scope_enforcement_violations()` = 0 before and after,
// and every business row count identical. That record is the only reason anybody can say what
// that rollout did. This script takes the same reading, so the claim does not depend on
// somebody remembering to run nine queries by hand in the right order.
//
// It also refuses the rollout outright on the two conditions that have actually stopped one:
//
//   CR IN FUNCTION BODIES. A body is stored as the bytes it was created from. Applying a
//   migration from Windows writes CRLF into `prosrc`; the anchored-replacement migrations then
//   build a multi-line anchor with e'\n' and search for text that cannot exist. That is exactly
//   how `0171`-`0205` aborted at `0181` with "platform scope lock anchor moved", against 302
//   bodies carrying CR. `db-query.ps1` normalises to LF now, so this should read 0 -- and if it
//   ever does not, the rollout stops here rather than halfway through.
//
//   A STALE RESTORE POINT. PITR is off on this project. The nightly physical backup is the ONLY
//   way back, so starting a rollout late in the day means a restore costs a full day of work.
//
// Read-only. It never writes, and it prints no secret.
//
//   node scripts/rollout-preflight.mjs                 -- the reading, plus the go/no-go
//   node scripts/rollout-preflight.mjs --save before.json
//   node scripts/rollout-preflight.mjs --compare before.json
import { readFileSync, writeFileSync } from 'node:fs'

const PROJECT = 'rkftlbctohswhbbiaqin'
const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const val = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1] }

const TOKEN_FILE = 'D:/משה פרוייקטים/פיתוח אתרים/AI/API/NIR-TOKEN-SUPABASE.txt'
let token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  try { token = readFileSync(TOKEN_FILE, 'utf8').trim() } catch {
    console.error('no SUPABASE_ACCESS_TOKEN, and the token file is unreadable.')
    process.exit(2)
  }
}

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
const one = async (sql) => Number(Object.values((await q(sql))[0])[0])

const IN_SCHEMAS = "n.nspname in ('public','private')"
const COUNTS = {
  functions: `select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${IN_SCHEMAS}`,
  tables: `select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and ${IN_SCHEMAS}`,
  policies: `select count(*) n from pg_policies where schemaname in ('public','private')`,
  definer_functions: `select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${IN_SCHEMAS} and p.prosecdef`,
  ledger_rows: `select count(*) n from supabase_migrations.schema_migrations`,
}
// Every table whose count MUST NOT MOVE. A migration that touches one of these has done
// something no migration in this rollout is supposed to do.
const BUSINESS = ['suppliers', 'products', 'purchase_orders', 'purchase_order_items', 'invoices',
  'payments', 'payment_allocations', 'bank_transactions', 'bank_imports', 'organizations', 'profiles']

const reading = { at: new Date().toISOString(), project: PROJECT, counts: {}, business: {} }

for (const [k, sql] of Object.entries(COUNTS)) reading.counts[k] = await one(sql)
reading.ledger_head = (await q('select max(version) v from supabase_migrations.schema_migrations'))[0].v
for (const t of BUSINESS) {
  try { reading.business[t] = await one(`select count(*) n from public.${t}`) } catch { reading.business[t] = null }
}
reading.cr_bodies = await one(
  `select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where ${IN_SCHEMAS} and p.prosrc like '%'||chr(13)||'%'`
)
reading.scope_violations = (await q('select * from private.scope_enforcement_violations()')).length

const backups = await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/backups`, {
  headers: { Authorization: `Bearer ${token}` },
})).json()
const newest = (backups.backups || []).filter((b) => b.status === 'COMPLETED')[0]
reading.pitr_enabled = backups.pitr_enabled
reading.newest_backup = newest ? { id: newest.id, at: newest.inserted_at } : null
const ageHours = newest ? (Date.now() - Date.parse(newest.inserted_at)) / 36e5 : Infinity

// ---------------------------------------------------------------------------- report

console.log(`${PROJECT} at ${reading.at}\n`)
console.log(`  ledger head        ${reading.ledger_head}`)
for (const [k, v] of Object.entries(reading.counts)) console.log(`  ${k.padEnd(18)} ${v}`)
console.log(`\n  CR in bodies       ${reading.cr_bodies}`)
console.log(`  scope violations   ${reading.scope_violations}`)
console.log(`  PITR               ${reading.pitr_enabled ? 'on' : 'OFF — the nightly backup is the only way back'}`)
console.log(`  newest backup      ${reading.newest_backup ? `${reading.newest_backup.id} at ${reading.newest_backup.at} (${ageHours.toFixed(1)}h old)` : 'NONE'}`)
console.log('\n  business row counts (these must not move)')
for (const [t, n] of Object.entries(reading.business)) console.log(`    ${t.padEnd(24)} ${n === null ? 'n/a' : n}`)

const prior = flag('compare') ? JSON.parse(readFileSync(val('compare') || 'rollout-before.json', 'utf8')) : null
if (prior) {
  console.log('\n=== compared with the reading taken before ===')
  console.log(`  ledger head    ${prior.ledger_head} -> ${reading.ledger_head}`)
  for (const k of Object.keys(COUNTS)) {
    const d = reading.counts[k] - prior.counts[k]
    console.log(`  ${k.padEnd(18)} ${prior.counts[k]} -> ${reading.counts[k]}  ${d >= 0 ? '+' : ''}${d}`)
  }
  const moved = Object.keys(prior.business).filter((t) => prior.business[t] !== reading.business[t])
  if (moved.length) {
    console.log('\n  BUSINESS ROW COUNTS MOVED — stop, do not deploy the frontend:')
    for (const t of moved) console.log(`    ${t}: ${prior.business[t]} -> ${reading.business[t]}`)
  } else {
    console.log('\n  every business row count is identical.')
  }
  if (reading.counts.policies < prior.counts.policies) {
    console.log('  POLICY COUNT FELL — 0252 dropped policies it did not recreate.')
  }
}

if (flag('save')) {
  const path = val('save') || 'rollout-before.json'
  writeFileSync(path, JSON.stringify(reading, null, 2))
  console.log(`\nsaved to ${path}`)
}

// ------------------------------------------------------------------------- go / no-go

if (prior) process.exit(0)
const stop = []
if (reading.cr_bodies !== 0) {
  stop.push(`${reading.cr_bodies} function bodies store CR. The anchored migrations WILL fail, the way 0181 did. Normalise first.`)
}
if (reading.scope_violations !== 0) {
  stop.push(`scope_enforcement_violations() returns ${reading.scope_violations} row(s). Production is already out of contract.`)
}
if (ageHours > 24) {
  stop.push(`the newest completed backup is ${ageHours.toFixed(1)}h old and PITR is off. A restore would cost that much work.`)
}
console.log('')
if (stop.length) {
  for (const s of stop) console.error(`  NO-GO  ${s}`)
  process.exit(1)
}
console.log('  GO — nothing blocks the rollout. Save this reading before applying:')
console.log('       node scripts/rollout-preflight.mjs --save rollout-before.json')
