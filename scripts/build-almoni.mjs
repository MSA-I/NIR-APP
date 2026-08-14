import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const sourceDir = process.env.SUPPLYFLOW_ALMONI_FONT_DIR;
const stagingDir = path.resolve('public/fonts/almoni');
const weights = [400, 500, 600];

if (!sourceDir) {
  throw new Error('SUPPLYFLOW_ALMONI_FONT_DIR is required for a licensed Almoni build.');
}

const sourceNames = {
  400: 'AlmoniNeue-400.woff2',
  500: 'AlmoniNeue-500.woff2',
  600: 'AlmoniNeue-600.woff2',
};

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function runBuild() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['run', 'build'], {
      stdio: 'inherit',
      env: { ...process.env, VITE_FONT_MODE: 'almoni' },
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Almoni build failed with exit code ${code}.`)));
  });
}

try {
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  for (const weight of weights) {
    const source = path.resolve(sourceDir, sourceNames[weight]);
    const expected = process.env[`SUPPLYFLOW_ALMONI_${weight}_SHA256`]?.trim().toLowerCase();
    if (!expected) throw new Error(`SUPPLYFLOW_ALMONI_${weight}_SHA256 is required.`);
    if ((await stat(source)).size === 0) throw new Error(`${sourceNames[weight]} is empty.`);
    const actual = await sha256(source);
    if (actual !== expected) throw new Error(`${sourceNames[weight]} SHA-256 mismatch.`);
    await cp(source, path.join(stagingDir, sourceNames[weight]));
  }

  await runBuild();
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
