import { access } from 'node:fs/promises';
import path from 'node:path';

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
export async function resolveResultsDir(rootDir, environment = process.env) {
  const override = environment.OWNER_DECISIONS_RESULTS_DIR;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('results_path_must_be_absolute');
    return path.resolve(override);
  }

  let cursor = path.resolve(rootDir);
  while (true) {
    const parent = path.dirname(cursor);
    const candidate = path.join(parent, 'NIR-APP-DOCS');
    if (await exists(candidate)) return path.join(candidate, 'owner-decisions');
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('nir_app_docs_not_found');
}
