/**
 * check:assistant-tool-schemas — the assistant's tool declarations, checked against the one rule
 * the provider enforces and no test in this repository did.
 *
 * `provider.ts` sends every tool with `strict: true`. OpenAI's strict function schemas require
 * that EVERY key in `properties` also appears in `required`; an argument the model may omit is
 * expressed by making its type nullable, not by leaving it out of `required`. A schema that
 * breaks the rule is rejected with HTTP 400 `invalid_function_parameters`, and `provider.ts`
 * turns every non-2xx into the same `assistant_provider_unavailable` the UI shows for a network
 * failure. So the whole assistant refuses, and the reason is indistinguishable from the provider
 * being down.
 *
 * That is exactly what happened: ten of the seventeen tools shipped with `required: []` or a
 * partial list. 208 Deno contract tests, the full CI gate and a merged PR all passed, because
 * every one of them stubs the provider. The first real call was the first measurement.
 *
 * This runs in `npm run verify`: arithmetic over the source, no stack, no network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('../supabase/functions/assistant/tools', import.meta.url));

/** The brace-matched object literal that follows `marker`, or null. */
function objectAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const open = source.indexOf('{', at + marker.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Keys declared at the TOP level of a `properties: { … }` block. Depth is sampled at the start of
 * each line, not the end: `window: {` opens a brace, so a depth check taken after the line would
 * miss the very keys this exists to find.
 */
function topLevelPropertyKeys(schemaText) {
  const block = objectAfter(schemaText, 'properties:');
  if (!block) return [];
  const keys = [];
  let depth = 0;
  let depthAtLineStart = 0;
  let atLineStart = true;
  let line = '';
  const flush = () => {
    const match = /^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(line);
    if (match && depthAtLineStart === 0) keys.push(match[1]);
  };
  for (const char of block.slice(1, -1)) {
    if (atLineStart) { depthAtLineStart = depth; atLineStart = false; }
    if (char === '\n') { flush(); line = ''; atLineStart = true; continue; }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    line += char;
  }
  flush();
  return keys;
}

/** The `required: [ … ]` that belongs to the schema's own top level. */
function topLevelRequired(schemaText) {
  let depth = 0;
  for (let i = 0; i < schemaText.length; i += 1) {
    const char = schemaText[i];
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    else if (depth === 1 && schemaText.startsWith('required:', i)) {
      const open = schemaText.indexOf('[', i);
      const close = schemaText.indexOf(']', open);
      if (open < 0 || close < 0) return null;
      return [...schemaText.slice(open + 1, close).matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    }
  }
  return null;
}

const failures = [];
let checked = 0;

for (const file of readdirSync(toolsDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
  const source = readFileSync(join(toolsDir, file), 'utf8');
  const schema = objectAfter(source, 'inputJsonSchema:');
  if (!schema) continue;
  checked += 1;
  const name = /name:\s*["']([^"']+)["']/.exec(source)?.[1] ?? file;
  const properties = topLevelPropertyKeys(schema);
  const required = topLevelRequired(schema);

  if (properties.length && required === null) {
    failures.push(`${name} (${file}): declares ${properties.length} propert(ies) and no 'required' array`);
    continue;
  }
  const missing = properties.filter((key) => !(required ?? []).includes(key));
  if (missing.length) {
    failures.push(`${name} (${file}): missing from 'required': ${missing.join(', ')}`);
  }
}

// A checker that silently found nothing to check is not a passing checker.
if (checked === 0) {
  console.error(
    'check:assistant-tool-schemas FAILED — no tool declared an inputJsonSchema.\n'
    + '  Either the tools moved, or the marker this scans for was renamed. Both mean this guard\n'
    + '  is no longer looking at anything, which is worse than a failure.',
  );
  process.exit(1);
}

if (failures.length) {
  console.error(
    'check:assistant-tool-schemas FAILED — OpenAI strict mode rejects these tool declarations.\n\n'
    + failures.map((line) => `    ${line}`).join('\n')
    + '\n\n  Strict mode requires EVERY key in `properties` to appear in `required`. An argument the\n'
    + '  model may omit is expressed as a nullable type — `type: ["integer", "null"]`, or\n'
    + '  `anyOf: [{…enum…}, { type: "null" }]` — with the Zod schema mapping null to the default.\n'
    + '  Leaving a key out of `required` makes the provider return 400 for EVERY question, which\n'
    + '  reaches the user as `assistant_provider_unavailable` and looks like an outage.',
  );
  process.exit(1);
}

console.log(
  `check:assistant-tool-schemas passed: ${checked} tool declaration(s); every property is required, `
  + 'so strict mode accepts them.',
);
