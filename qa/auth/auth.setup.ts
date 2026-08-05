import { chromium, type APIRequestContext, type Page } from '@playwright/test';
import { qaRepositoryRoot, QA_SUPABASE_URL } from '../config/environments.ts';
import {
  QA_ORGANIZATION_ID,
  QA_ROLES,
  QA_SUPPLIER_PROFILE_ID,
  type QaRole,
} from '../config/roles.ts';
import { loadQaCredentials, type QaCredential } from './credential-loader.ts';
import { assertStorageStateCreated, prepareStorageStateDirectory, storageStatePath } from './storage-state.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';

export interface SetupRoleAuthenticationInput {
  readonly apiUrl: string;
  readonly anonKey: string;
  readonly credentialsPath: string;
  readonly authDirectory: string;
  readonly runId: string;
  readonly baseUrl?: string;
}

export interface SetupRoleAuthenticationResult {
  readonly states: Record<QaRole, string>;
  readonly userIds: Record<QaRole, string>;
}

interface AuthSession {
  readonly accessToken: string;
  readonly userId: string;
}

interface VerifiedProfile {
  readonly userId: string;
  readonly role: QaRole;
  readonly orgId: string;
  readonly supplierId: string | null;
}

interface AuthenticatePageInput {
  readonly page: Page;
  readonly role: QaRole;
  readonly credential: QaCredential;
  readonly apiUrl: typeof QA_SUPABASE_URL;
  readonly anonKey: string;
  readonly baseUrl: string;
  readonly statePath: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAuthSession(value: unknown): AuthSession {
  if (!isRecord(value) || typeof value.access_token !== 'string' || !isRecord(value.user)
      || typeof value.user.id !== 'string') {
    throw new Error('Local auth response did not contain a usable session.');
  }
  return { accessToken: value.access_token, userId: value.user.id };
}

function parseProfile(value: unknown, expectedRole: QaRole): Omit<VerifiedProfile, 'userId'> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error(`Local profile fixture is missing or ambiguous for role: ${expectedRole}`);
  }
  const row = value[0];
  if (row.role !== expectedRole || row.org_id !== QA_ORGANIZATION_ID) {
    throw new Error(`Authenticated account resolved to the wrong profile role: ${expectedRole}`);
  }
  if (row.active !== true) throw new Error(`Authenticated profile is inactive for role: ${expectedRole}`);
  const supplierId = typeof row.supplier_id === 'string' ? row.supplier_id : null;
  if (expectedRole === 'supplier' && supplierId !== QA_SUPPLIER_PROFILE_ID) {
    throw new Error('Supplier QA profile is not linked to the canonical supplier.');
  }
  if (expectedRole !== 'supplier' && supplierId !== null) {
    throw new Error(`Non-supplier QA profile is unexpectedly linked to a supplier: ${expectedRole}`);
  }
  return { role: expectedRole, orgId: row.org_id, supplierId };
}

function assertIsolatedApiUrl(value: string): typeof QA_SUPABASE_URL {
  const url = new URL(value);
  if (url.origin !== QA_SUPABASE_URL || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password) {
    throw new Error(`Refusing authentication target other than ${QA_SUPABASE_URL}.`);
  }
  return QA_SUPABASE_URL;
}

function assertLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  const port = Number(url.port);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || !Number.isInteger(port) || port < 1
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QA authentication base URL must be an HTTP loopback origin with an explicit port.');
  }
  return url.origin;
}

function assertSafeRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error('QA authentication run id is invalid.');
  }
}

async function verifyRoleWithRest(
  request: APIRequestContext,
  session: AuthSession,
  role: QaRole,
  apiUrl: typeof QA_SUPABASE_URL,
  anonKey: string,
): Promise<VerifiedProfile> {
  const url = new URL('/rest/v1/profiles', apiUrl);
  url.searchParams.set('select', 'role,org_id,supplier_id,active');
  url.searchParams.set('id', `eq.${session.userId}`);
  const response = await request.get(url.toString(), {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.accessToken}`,
    },
    failOnStatusCode: false,
  });
  if (response.status() !== 200) {
    throw new Error(`Local profile verification failed for role ${role} with HTTP ${response.status()}.`);
  }
  return { ...parseProfile(await response.json() as unknown, role), userId: session.userId };
}

async function authenticateRoleInPage(input: AuthenticatePageInput): Promise<VerifiedProfile> {
  await input.page.goto(new URL('/login', input.baseUrl).toString());
  await input.page.getByLabel('אימייל').fill(input.credential.email);
  await input.page.getByLabel('סיסמה').fill(input.credential.password);

  const authResponse = input.page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === input.apiUrl && url.pathname === '/auth/v1/token'
      && url.searchParams.get('grant_type') === 'password';
  });
  await input.page.getByRole('button', { name: 'התחברות', exact: true }).click();
  const response = await authResponse;
  if (response.status() !== 200) throw new Error(`Local UI authentication failed for role: ${input.role}`);
  const session = parseAuthSession(await response.json() as unknown);
  const profile = await verifyRoleWithRest(
    input.page.context().request,
    session,
    input.role,
    input.apiUrl,
    input.anonKey,
  );

  await input.page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 25_000 });
  await input.page.locator('#main h1').first().waitFor({ state: 'visible', timeout: 10_000 });
  await input.page.context().storageState({ path: input.statePath });
  return profile;
}

export async function setupRoleAuthentication(
  input: SetupRoleAuthenticationInput,
): Promise<SetupRoleAuthenticationResult> {
  assertSafeRunId(input.runId);
  const apiUrl = assertIsolatedApiUrl(input.apiUrl);
  const baseUrl = assertLoopbackBaseUrl(input.baseUrl ?? process.env.QA_BASE_URL ?? DEFAULT_BASE_URL);
  const anonKey = input.anonKey.trim();
  if (!anonKey) throw new Error('Local anonymous key is required for role authentication.');

  const credentials = loadQaCredentials(input.credentialsPath, qaRepositoryRoot());
  prepareStorageStateDirectory(input.authDirectory);
  const browser = await chromium.launch({ headless: true });
  const stateEntries: Array<readonly [QaRole, string]> = [];
  const userIdEntries: Array<readonly [QaRole, string]> = [];
  const organizationIds = new Set<string>();
  try {
    for (const role of QA_ROLES) {
      const statePath = storageStatePath(input.authDirectory, role);
      const context = await browser.newContext({
        baseURL: baseUrl,
        locale: 'he-IL',
        timezoneId: 'Asia/Jerusalem',
        colorScheme: 'light',
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        const profile = await authenticateRoleInPage({
          page,
          role,
          credential: credentials[role],
          apiUrl,
          anonKey,
          baseUrl,
          statePath,
        });
        organizationIds.add(profile.orgId);
        assertStorageStateCreated(input.authDirectory, role);
        stateEntries.push([role, statePath]);
        userIdEntries.push([role, profile.userId]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (organizationIds.size !== 1) {
    throw new Error('Canonical QA role accounts do not resolve to one known organization.');
  }
  return {
    states: Object.freeze(Object.fromEntries(stateEntries)) as Record<QaRole, string>,
    userIds: Object.freeze(Object.fromEntries(userIdEntries)) as Record<QaRole, string>,
  };
}
