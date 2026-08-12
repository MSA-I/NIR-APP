import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { QA_ROLES, ROLE_EMAILS, type ActiveQaRole } from '../config/roles.ts';

export interface QaCredential {
  readonly email: string;
  readonly password: string;
}

type CredentialSet = Readonly<Record<ActiveQaRole, QaCredential>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function readAccounts(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value.accounts)) {
    throw new Error('QA credentials manifest must contain an accounts array.');
  }
  if (value.accounts.length !== QA_ROLES.length) {
    throw new Error('QA credentials manifest must contain exactly the three active demo accounts.');
  }
  return value.accounts;
}

export function loadQaCredentials(manifestPath: string, repoRoot: string): CredentialSet {
  const manifest = realpathSync(manifestPath);
  const repository = realpathSync(repoRoot);
  if (isInside(repository, manifest)) {
    throw new Error('QA credentials manifest must live outside the repository.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
  } catch {
    throw new Error('QA credentials manifest is not valid JSON.');
  }

  const activeEmails = QA_ROLES.map((role) => [ROLE_EMAILS[role], role] as const);
  const roleByEmail = new Map(activeEmails);
  const credentials: Partial<Record<ActiveQaRole, QaCredential>> = {};
  const passwords = new Set<string>();

  for (const value of readAccounts(parsed)) {
    if (!isRecord(value) || typeof value.email !== 'string' || typeof value.password !== 'string') {
      throw new Error('Every QA account must contain string email and password fields.');
    }
    const email = value.email.trim().toLowerCase();
    const role = roleByEmail.get(email);
    if (!role) throw new Error('QA credentials manifest contains an unexpected account email.');
    if (credentials[role]) throw new Error(`Duplicate QA account for role: ${role}`);
    if (value.password.length < 16) throw new Error(`QA password is too short for role: ${role}`);
    if (passwords.has(value.password)) throw new Error('Every QA role must use a distinct password.');
    passwords.add(value.password);
    credentials[role] = Object.freeze({ email, password: value.password });
  }

  for (const role of QA_ROLES) {
    if (!credentials[role]) throw new Error(`QA credentials manifest is missing role: ${role}`);
  }
  return Object.freeze(credentials) as CredentialSet;
}
