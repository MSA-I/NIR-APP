import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { QaRole } from '../config/roles.ts';
import { redactText } from '../reporting/redact.ts';
import {
  ComponentCoverageResultSchema,
  RouteCoverageResultSchema,
  StateCoverageRecordSchema,
  type ComponentCoverageResult,
  type RouteCoverageResult,
  type StateCoverageRecord,
} from './types.ts';

/**
 * Per-route result files.
 *
 * One file per (role, route) rather than one growing document: each Playwright test owns exactly
 * one file, so a walk that dies halfway leaves every completed route intact and readable instead
 * of a truncated aggregate. The report runner merges them and treats a missing file as an
 * uninspected route — which is a gap it prints, not a zero it hides.
 */

export const RouteRecordFileSchema = z.object({
  runId: z.string(),
  role: z.string(),
  route: z.string(),
  recordedAt: z.string(),
  routeResult: RouteCoverageResultSchema,
  components: z.array(ComponentCoverageResultSchema),
  states: z.array(StateCoverageRecordSchema),
  observations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      category: z.enum([
        'authorization',
        'functional',
        'accessibility',
        'usability',
        'visual',
        'discoverability',
        'network',
        'console',
        'coverage_gap',
      ]),
      severityHint: z.enum(['high', 'medium', 'low', 'info']),
      evidence: z.array(z.string()).default([]),
    }),
  ),
});
export type RouteRecordFile = z.infer<typeof RouteRecordFileSchema>;
export type CoverageObservation = RouteRecordFile['observations'][number];

export function coverageResultsRoot(artifactRoot: string): string {
  return path.join(artifactRoot, 'coverage', 'results');
}

/** Route paths carry slashes and colons; the file name must survive both Windows and a URL. */
export function routeSlug(route: string): string {
  const cleaned = route.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'root';
}

export function writeRouteRecord(artifactRoot: string, record: RouteRecordFile): string {
  const parsed = RouteRecordFileSchema.parse({
    ...record,
    observations: record.observations.map((observation) => ({
      ...observation,
      title: redactText(observation.title),
      detail: redactText(observation.detail).slice(0, 2_000),
    })),
  });
  const directory = path.join(coverageResultsRoot(artifactRoot), parsed.role);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${routeSlug(parsed.route)}.json`);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return file;
}

export function readRouteRecords(artifactRoot: string, role: QaRole): RouteRecordFile[] {
  const directory = path.join(coverageResultsRoot(artifactRoot), role);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const records: RouteRecordFile[] = [];
  for (const name of names) {
    try {
      records.push(RouteRecordFileSchema.parse(JSON.parse(readFileSync(path.join(directory, name), 'utf8'))));
    } catch {
      // A record that will not parse is not evidence. It is dropped here and shows up downstream
      // as a route with no result, which the summary reports as an uninspected route.
      continue;
    }
  }
  return records;
}

export function emptyRouteResult(
  role: QaRole,
  route: string,
  expectedVerdict: RouteCoverageResult['expectedVerdict'],
  status: RouteCoverageResult['status'],
  rationale: string,
): RouteCoverageResult {
  return {
    route,
    role,
    expectedVerdict,
    navigationVisible: null,
    directAccessOutcome: 'NOT_ATTEMPTED',
    protectedContentRendered: null,
    dataReturned: null,
    refreshStable: null,
    informationLeakBeforeRedirect: null,
    consoleErrors: [],
    failedRequests: [],
    timingsMs: {},
    status,
    rationale,
    evidence: [],
  };
}

export type { ComponentCoverageResult, RouteCoverageResult, StateCoverageRecord };
