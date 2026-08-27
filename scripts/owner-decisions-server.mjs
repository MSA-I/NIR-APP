import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createOwnerDecisionServer } from '../tools/owner-decisions/src/server.mjs';
import { resolveResultsDir } from '../tools/owner-decisions/src/paths.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.OWNER_DECISIONS_PORT || 43127);
const url = `http://127.0.0.1:${port}/`;
const shouldOpen = process.argv.includes('--open');

function openBrowser(target) {
  if (!shouldOpen) return;
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
  child.unref();
}
async function existingServer() {
  try {
    const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(900) });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.ok === true;
  } catch {
    return false;
  }
}

if (await existingServer()) {
  console.log(`מרכז ההחלטות כבר פעיל: ${url}`);
  openBrowser(url);
  process.exit(0);
}

const [{ stdout: sourceCommit }, resultsDir] = await Promise.all([
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, windowsHide: true }),
  resolveResultsDir(rootDir),
]);

const server = createOwnerDecisionServer({
  rootDir,
  resultsDir,
  port,
  sourceCommit: sourceCommit.trim(),
});

try {
  await server.start();
} catch (error) {
  if (error?.code === 'EADDRINUSE') {
    console.error(`הפורט ${port} כבר תפוס בידי תוכנה אחרת. לא נפתח שרת נוסף.`);
  } else if (error?.code === 'saved_state_source_changed') {
    console.error('מסמכי המקור השתנו מאז השמירה האחרונה. יש להעביר את current.json לארכיון לפני התחלה חדשה.');
  } else {
    console.error(error?.message || error);
  }
  process.exit(1);
}

console.log('');
console.log('מרכז ההחלטות של InPlace פעיל.');
console.log(`כתובת: ${url}`);
console.log(`תוצאות: ${resultsDir}`);
console.log('אפשר להשאיר חלון זה פתוח בזמן העבודה. Ctrl+C סוגר את הכלי.');
openBrowser(url);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
