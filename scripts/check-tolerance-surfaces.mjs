/**
 * check:tolerance-surfaces — a tolerance the owner cannot state is a tolerance the product invented.
 *
 * `#288` decided that a money tolerance carries a currency, and that a used currency with no
 * configured value is "shown in settings as needing a decision — and does not get an invented one".
 * The database half of that decision shipped: `private.money_tolerance(org, currency, key)` returns
 * null rather than a number, and every caller respects the null. The settings half did not ship at
 * all, and nothing measured its absence — which is how FOUR keys reached production with ONE screen
 * between them, and that one screen editing a bare shekel scalar.
 *
 * This guard is the thing that was missing. It is deliberately not a test of behaviour: it is a
 * test that a decision the owner made still has somewhere to be made.
 *
 * THE TWO ASSERTIONS, each with its own exit code so a failure says which one fell:
 *
 *   keys      (2) every key reaching `private.money_tolerance` in any migration is classified in
 *                 scripts/tolerance-surfaces.json. A fifth tolerance cannot be born unlisted, which
 *                 is exactly how the first four came to have no screen.
 *   surfaces  (3) every key marked `surface: "settings"` literally appears in the surface file.
 *                 Deleting the field from the screen fails here rather than silently returning the
 *                 product to the state this plan exists to end.
 *
 * Keys marked `surface: "missing"` are the debt this plan is closing. They are ALLOWED, but only
 * while `closedBy` names the phase that closes them, and every run prints them. A guard that lets
 * a gap go quiet is the same guard that let this one live for a whole campaign.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = join(root, 'supabase', 'migrations');
const pinned = JSON.parse(readFileSync(join(root, 'scripts', 'tolerance-surfaces.json'), 'utf8'));

const EXIT = { keys: 2, surfaces: 3 };

/**
 * Every `money_tolerance(…, …, '<key>')` call site, with the file it sits in.
 *
 * The third argument is matched as a quoted literal rather than by argument position: the calls in
 * this schema are written both spaced and unspaced, and one of them passes a cast expression as the
 * first argument, so counting commas across `[^,]` would have missed it.
 */
function callSites() {
  /* `[^()]` rather than `[\s\S]`, and the reason is a false positive this guard produced against
     its own repository: `has_function_privilege('private.money_tolerance(uuid,text,text)',
     'execute')` names the function inside a STRING, and a permissive pattern read `execute` as a
     fifth tolerance key. A real call's arguments are identifiers, casts and literals — none of
     them contain a parenthesis — so refusing to cross one separates the call from the mention. */
  const re = /money_tolerance\s*\(\s*[^()]{0,160}?,\s*'([a-z_]+)'\s*\)/gi;
  const found = new Map();
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const text = readFileSync(join(migrationsDir, file), 'utf8');
    for (const match of text.matchAll(re)) {
      if (!found.has(match[1])) found.set(match[1], []);
      found.get(match[1]).push(file);
    }
  }
  return found;
}

function assertKeys() {
  const sites = callSites();
  const unlisted = [...sites.keys()].filter((k) => !(k in pinned.keys) && !(k in pinned.probes));

  if (unlisted.length > 0) {
    console.error(
      `check:tolerance-surfaces keys FAILED — ${unlisted.length} tolerance key(s) reach\n`
      + '  private.money_tolerance and are classified nowhere:\n\n'
      + unlisted.map((k) => `    ${k}  (${[...new Set(sites.get(k))].join(', ')})`).join('\n')
      + '\n\n  Add it to scripts/tolerance-surfaces.json. If the owner can state this amount, give it\n'
      + '  a screen and mark it `settings`; if it is a self-check probe, put it under `probes` with\n'
      + '  the reason. What must not happen is a fifth tolerance with no way to configure it — that\n'
      + '  is how the first four got here (#288, PLAN-currency-tolerances-20260830).',
    );
    return EXIT.keys;
  }

  // A key that is classified but that nothing calls any more is dead weight in the list, and a list
  // that describes a schema that moved is how a guard starts lying.
  const orphans = Object.keys(pinned.keys).filter((k) => !sites.has(k));
  if (orphans.length > 0) {
    console.error(
      `check:tolerance-surfaces keys FAILED — ${orphans.length} pinned key(s) are no longer read by\n`
      + `  any migration: ${orphans.join(', ')}.\n`
      + '  Remove them from scripts/tolerance-surfaces.json in the same change that stopped reading\n'
      + '  them, so the list keeps describing the database that exists.',
    );
    return EXIT.keys;
  }

  console.log(`GATE_TOLERANCE_KEYS_OK — ${sites.size - Object.keys(pinned.probes).length} tolerance key(s) classified, 0 unlisted.`);
  return 0;
}

function assertSurfaces() {
  const surface = readFileSync(join(root, pinned.surfaceFile), 'utf8');
  const claimed = Object.entries(pinned.keys).filter(([, v]) => v.surface === 'settings');
  const absent = claimed.filter(([key]) => !surface.includes(key)).map(([key]) => key);

  if (absent.length > 0) {
    console.error(
      `check:tolerance-surfaces surfaces FAILED — ${absent.length} key(s) claim a settings screen\n`
      + `  that ${pinned.surfaceFile} does not mention: ${absent.join(', ')}.\n\n`
      + '  Either the field was removed from the screen, or the key was renamed on one side only.\n'
      + '  #288 is explicit: a used currency with no configured value is shown in settings as\n'
      + '  needing a decision. A key with nowhere to be decided cannot satisfy that.',
    );
    return EXIT.surfaces;
  }

  // Keys living in a component proves nothing if no screen renders it. A panel nobody mounts is
  // the same silence this guard exists to end, and it would pass every other assertion here.
  const mount = readFileSync(join(root, pinned.mountedIn.file), 'utf8');
  if (!mount.includes(`<${pinned.mountedIn.component}`)) {
    console.error(
      `check:tolerance-surfaces surfaces FAILED — ${pinned.mountedIn.file} does not render\n`
      + `  <${pinned.mountedIn.component} …>. The fields exist in a file no screen reaches, which is\n`
      + '  indistinguishable from having no screen at all.',
    );
    return EXIT.surfaces;
  }

  const missing = Object.entries(pinned.keys).filter(([, v]) => v.surface === 'missing');
  const undated = missing.filter(([, v]) => !v.closedBy).map(([key]) => key);
  if (undated.length > 0) {
    console.error(
      `check:tolerance-surfaces surfaces FAILED — ${undated.length} key(s) have no screen and name\n`
      + `  no phase that gives them one: ${undated.join(', ')}.\n`
      + '  `missing` is a debt, and a debt without a closing step is just a gap.',
    );
    return EXIT.surfaces;
  }

  for (const [key, value] of missing) {
    console.log(`  tolerance-surfaces DEBT — ${key} has no screen in any currency; closed by ${value.closedBy}.`);
  }
  console.log(`GATE_TOLERANCE_SURFACES_OK — ${claimed.length}/${Object.keys(pinned.keys).length} key(s) configurable in ${pinned.surfaceFile}.`);
  return 0;
}

const ASSERTIONS = { keys: assertKeys, surfaces: assertSurfaces };
const requested = process.argv[2] ?? 'all';

if (requested !== 'all' && !(requested in ASSERTIONS)) {
  console.error(`Unknown assertion "${requested}". Expected one of: ${Object.keys(ASSERTIONS).join(', ')}, all.`);
  process.exit(1);
}

for (const assertion of requested === 'all' ? Object.values(ASSERTIONS) : [ASSERTIONS[requested]]) {
  const code = assertion();
  if (code !== 0) process.exit(code);
}
