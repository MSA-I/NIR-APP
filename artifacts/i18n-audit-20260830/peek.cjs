/** Prints the he/en value of named keys in a namespace, so a swap is made against the real text. */
const fs = require('node:fs');

function get(file, ns0, keys) {
  const arr = fs.readFileSync(file, 'utf8').split('\n');
  let ns = null;
  const out = [];
  for (const line of arr) {
    const m = line.match(/^ {2}([A-Za-z0-9_]+):\s*\{/);
    if (m) ns = m[1];
    const k = line.match(/^\s{4}([A-Za-z0-9_]+):\s*'(.*)',?\s*$/);
    if (ns === ns0 && k && (keys.length === 0 || keys.includes(k[1]))) out.push(k[1] + ' = ' + k[2]);
  }
  return out;
}

const [ns, ...keys] = process.argv.slice(2);
for (const [label, file] of [['he', 'src/lib/i18n/dictionaries/he.ts'], ['en', 'src/lib/i18n/dictionaries/en.ts']]) {
  console.log('--- ' + label + ' ' + ns);
  for (const row of get(file, ns, keys)) console.log('   ' + row);
}
