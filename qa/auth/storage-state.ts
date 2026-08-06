import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { QA_ROLES, type QaRole } from '../config/roles.ts';

function checkedRoot(root: string): string {
  const value = resolve(root);
  const relativeSegments = value.slice(parse(value).root.length).split(/[\\/]/).filter(Boolean);
  if (!isAbsolute(value) || value === parse(value).root || basename(value) === ''
      || !relativeSegments.some((segment) => segment.toLowerCase() === '.qa-auth')) {
    throw new Error('Unsafe QA auth-state directory.');
  }
  return value;
}

export function storageStatePath(root: string, role: QaRole): string {
  return join(checkedRoot(root), `${role}.json`);
}

export function prepareStorageStateDirectory(root: string): void {
  const directory = checkedRoot(root);
  mkdirSync(directory, { recursive: true });
  for (const role of QA_ROLES) rmSync(storageStatePath(directory, role), { force: true });
}

export function assertStorageStateCreated(root: string, role: QaRole): void {
  const path = storageStatePath(root, role);
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`Authentication state was not created for role: ${role}`);
  }
}
