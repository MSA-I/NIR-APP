import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  LOCAL_QA_API_URL,
  assertIsolatedLocalTarget,
  detectCompetingQualityProcesses,
} from '../runner/lock.ts';
import { QA_DATABASE_CONTAINER } from '../runner/setup.ts';
import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

const execFileAsync = promisify(execFile);

export interface StaticSecurityAllowlist {
  approvedBy: string;
  reviewedAt: string;
  anonSecurityDefinerFunctions: readonly string[];
  browserDirectDmlGrants: readonly string[];
  serviceOnlyTables: readonly string[];
}

export interface StaticSecurityOptions {
  repoRoot?: string;
  allowlist?: StaticSecurityAllowlist;
}

const CATALOG_QUERIES = {
  orgTablesMissingRls: String.raw`
    select format('%I.%I', n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
      )
      and not c.relrowsecurity
    order by 1`,
  serviceRoleCrudGaps: String.raw`
    select format('%I.%I', n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not (
        has_table_privilege('service_role', c.oid, 'SELECT')
        and has_table_privilege('service_role', c.oid, 'INSERT')
        and has_table_privilege('service_role', c.oid, 'UPDATE')
        and has_table_privilege('service_role', c.oid, 'DELETE')
      )
    order by 1`,
  unsafeViews: String.raw`
    select format('%I.%I', n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and not (coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true'])
    order by 1`,
  browserTruncateGrants: String.raw`
    select grantee || '|public.' || table_name || '|TRUNCATE'
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type = 'TRUNCATE'
    order by 1`,
  anonSecurityDefinerFunctions: String.raw`
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by 1`,
  browserDirectDmlGrants: String.raw`
    select grantee || '|public.' || table_name || '|' || privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    order by 1`,
  browserTableGrants: String.raw`
    select grantee || '|public.' || table_name || '|' || privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
    order by 1`,
} as const;

type CatalogQueryId = keyof typeof CATALOG_QUERIES;

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(result)) {
    if (/^QA_|^(?:VITE_)?SUPABASE_|^(?:DATABASE_URL|POSTGRES_URL|PGPASSWORD)$/i.test(key)) delete result[key];
  }
  return result;
}

async function catalogRows(repoRoot: string, queryId: CatalogQueryId): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'exec',
        '-e',
        'PGPASSWORD=postgres',
        QA_DATABASE_CONTAINER,
        'psql',
        '-qAt',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        CATALOG_QUERIES[queryId],
      ],
      {
        cwd: repoRoot,
        env: cleanChildEnvironment(),
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    throw new Error(`Static catalog query ${queryId} failed; raw database output was withheld.`);
  }
}

function exactDiff(actual: readonly string[], expected: readonly string[]): {
  missing: string[];
  unexpected: string[];
} {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: [...expectedSet].filter((value) => !actualSet.has(value)).sort(),
    unexpected: [...actualSet].filter((value) => !expectedSet.has(value)).sort(),
  };
}

function zeroRowsCheck(id: string, summary: string, rows: readonly string[]): VerificationCheck {
  return {
    id,
    status: rows.length === 0 ? 'PASS' : 'FAIL',
    summary: rows.length === 0 ? summary : `${summary} Found ${rows.length} unexpected catalog rows.`,
    evidence: { unexpectedCount: rows.length, unexpected: rows.slice(0, 200) },
  };
}

function validateAllowlist(allowlist: StaticSecurityAllowlist): void {
  if (!allowlist.approvedBy.trim()) throw new Error('Static security allowlist requires approvedBy.');
  if (!Number.isFinite(Date.parse(allowlist.reviewedAt))) throw new Error('Static security allowlist requires reviewedAt.');
  for (const table of allowlist.serviceOnlyTables) {
    if (!/^public\.[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('Invalid service-only table identifier.');
  }
}

export async function verifyStaticSecurity(
  options: StaticSecurityOptions = {},
): Promise<VerificationResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  try {
    await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  } catch {
    return createVerificationResult('static-security', 'Static security target could not be proven local.', [{
      id: 'local-target-proof',
      status: 'BLOCKED',
      summary: 'Catalog verification refused an unproven target.',
    }]);
  }

  let competing: Awaited<ReturnType<typeof detectCompetingQualityProcesses>>;
  try {
    competing = await detectCompetingQualityProcesses();
  } catch {
    return createVerificationResult('static-security', 'Process stability could not be proven.', [{
      id: 'catalog-stability',
      status: 'BLOCKED',
      summary: 'Static verification could not inspect competing local quality/reset processes.',
    }]);
  }
  if (competing.length > 0) {
    return createVerificationResult('static-security', 'Catalog evidence is unstable during a competing quality/reset process.', [{
      id: 'catalog-stability',
      status: 'BLOCKED',
      summary: 'Wait for the competing isolated-stack process before catalog verification.',
      evidence: { competing },
    }]);
  }

  let catalog: Record<CatalogQueryId, string[]>;
  try {
    const entries = await Promise.all(
      (Object.keys(CATALOG_QUERIES) as CatalogQueryId[])
        .map(async (id) => [id, await catalogRows(repoRoot, id)] as const),
    );
    catalog = Object.fromEntries(entries) as Record<CatalogQueryId, string[]>;
  } catch {
    return createVerificationResult('static-security', 'Local catalog evidence could not be acquired.', [{
      id: 'catalog-query',
      status: 'BLOCKED',
      summary: 'One or more read-only catalog queries failed; no PASS was inferred.',
    }]);
  }

  const checks: VerificationCheck[] = [
    zeroRowsCheck('org-tables-rls', 'Every public org_id table has RLS enabled.', catalog.orgTablesMissingRls),
    zeroRowsCheck('service-role-crud', 'service_role has explicit CRUD on public base tables.', catalog.serviceRoleCrudGaps),
    zeroRowsCheck('view-security-invoker', 'Every public view uses security_invoker.', catalog.unsafeViews),
    zeroRowsCheck('browser-truncate', 'Browser roles have no TRUNCATE grants.', catalog.browserTruncateGrants),
  ];

  if (!options.allowlist) {
    checks.push({
      id: 'approved-static-allowlist',
      status: 'BLOCKED',
      summary: 'No approved SECURITY DEFINER/ACL baseline was supplied; catalog observations cannot be promoted to PASS.',
      evidence: {
        anonSecurityDefinerCount: catalog.anonSecurityDefinerFunctions.length,
        browserDirectDmlGrantCount: catalog.browserDirectDmlGrants.length,
      },
    });
    checks.push({
      id: 'anon-security-definer-observation',
      status: 'OBSERVATION',
      summary: 'Anonymous executable SECURITY DEFINER functions require human-approved baseline review.',
      evidence: { observedCount: catalog.anonSecurityDefinerFunctions.length },
    });
    checks.push({
      id: 'browser-dml-observation',
      status: 'OBSERVATION',
      summary: 'Browser direct-DML grants require human-approved baseline review.',
      evidence: { observedCount: catalog.browserDirectDmlGrants.length },
    });
  } else {
    try {
      validateAllowlist(options.allowlist);
      const functionDiff = exactDiff(
        catalog.anonSecurityDefinerFunctions,
        options.allowlist.anonSecurityDefinerFunctions,
      );
      const dmlDiff = exactDiff(catalog.browserDirectDmlGrants, options.allowlist.browserDirectDmlGrants);
      const serviceOnly = new Set(options.allowlist.serviceOnlyTables);
      const serviceOnlyExposure = catalog.browserTableGrants.filter((grant) => {
        const table = grant.split('|')[1];
        return serviceOnly.has(table);
      });
      checks.push({
        id: 'anon-security-definer-allowlist',
        status: functionDiff.missing.length === 0 && functionDiff.unexpected.length === 0 ? 'PASS' : 'FAIL',
        summary: 'Anonymous SECURITY DEFINER execution matches the approved baseline exactly.',
        evidence: { ...functionDiff, observedCount: catalog.anonSecurityDefinerFunctions.length },
      });
      checks.push({
        id: 'browser-dml-allowlist',
        status: dmlDiff.missing.length === 0 && dmlDiff.unexpected.length === 0 ? 'PASS' : 'FAIL',
        summary: 'Browser direct-DML grants match the approved baseline exactly.',
        evidence: { ...dmlDiff, observedCount: catalog.browserDirectDmlGrants.length },
      });
      checks.push(zeroRowsCheck(
        'service-only-acl',
        'Approved service-only tables expose no browser grants.',
        serviceOnlyExposure,
      ));
    } catch {
      checks.push({
        id: 'approved-static-allowlist',
        status: 'BLOCKED',
        summary: 'The supplied static security allowlist is malformed or lacks approval metadata.',
      });
    }
  }

  return createVerificationResult(
    'static-security',
    'Read-only local PostgreSQL catalogs were checked; allowlist absence remains BLOCKED by design.',
    checks,
    {
      target: LOCAL_QA_API_URL,
      allowlistSupplied: Boolean(options.allowlist),
      catalogQueryCount: Object.keys(CATALOG_QUERIES).length,
      mutationStatementsExecuted: 0,
    },
  );
}
