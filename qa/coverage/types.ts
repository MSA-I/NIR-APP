import { z } from 'zod';
import { QA_ROLES } from '../config/roles.ts';

/**
 * Coverage contracts for the full role-coverage phase.
 *
 * Every artifact under qa/coverage/ is validated against these schemas before it is written,
 * so a report can never claim a shape the consumer cannot rely on. The schemas are the
 * source of truth; the TypeScript types are inferred from them and never hand-maintained.
 */

export const QaRoleSchema = z.enum(QA_ROLES);

export const ControlTypeSchema = z.enum([
  'button',
  'link',
  'input',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'file_upload',
  'table_action',
  'menu',
  'tab',
  'dialog',
  'drawer',
  'pagination',
  'search',
  'filter',
  'download',
  'print',
  'status_transition',
  'other',
]);
export type ControlType = z.infer<typeof ControlTypeSchema>;

export const ActionTypeSchema = z.enum([
  'navigation',
  'read',
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'upload',
  'download',
  'export',
  'import',
  'search',
  'filter',
  'state_change',
  'none',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/**
 * How a manifest entry was learned. Static extraction is a heuristic over JSX and is never
 * presented as proof that a control renders; `runtime` and `both` are the discovery sources a
 * coverage claim may rest on. Keeping the provenance on every record is what lets the final
 * report separate "we know this exists" from "the parser guessed".
 */
export const DiscoverySourceSchema = z.enum(['static', 'runtime', 'both', 'curated']);
export type DiscoverySource = z.infer<typeof DiscoverySourceSchema>;

export const ControlManifestEntrySchema = z.object({
  id: z.string().min(1),
  route: z.string().min(1),
  section: z.string().min(1),
  controlType: ControlTypeSchema,
  visibleLabel: z.string().optional(),
  accessibleName: z.string().optional(),
  expectedRoles: z.array(QaRoleSchema),
  actionType: ActionTypeSchema,
  expectedResult: z.string().optional(),
  expectedPersistence: z.string().optional(),
  destructive: z.boolean(),
  financial: z.boolean(),
  requiresFixture: z.boolean(),
  discoveredBy: DiscoverySourceSchema,
  sourceFile: z.string().optional(),
  sourceLine: z.number().int().positive().optional(),
});
export type ControlManifestEntry = z.infer<typeof ControlManifestEntrySchema>;

export const SectionManifestEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  component: z.string().optional(),
  purpose: z.string().min(1),
  expectedRoles: z.array(QaRoleSchema),
  controls: z.array(ControlManifestEntrySchema),
  discoveredBy: DiscoverySourceSchema,
});
export type SectionManifestEntry = z.infer<typeof SectionManifestEntrySchema>;

export const ActionManifestEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  actionType: ActionTypeSchema,
  expectedRoles: z.array(QaRoleSchema),
  destructive: z.boolean(),
  financial: z.boolean(),
  /** RPC / table / storage path the action is expected to reach, when known from source. */
  backend: z.array(z.string()).default([]),
  requiresFixture: z.boolean(),
});
export type ActionManifestEntry = z.infer<typeof ActionManifestEntrySchema>;

export const RouteManifestEntrySchema = z.object({
  route: z.string().min(1),
  pageComponent: z.string().min(1),
  title: z.string().optional(),
  navigationLabel: z.string().optional(),
  expectedRoles: z.array(QaRoleSchema),
  deniedRoles: z.array(QaRoleSchema),
  dynamicParameters: z.array(z.string()).optional(),
  queryParameters: z.array(z.string()).optional(),
  majorSections: z.array(SectionManifestEntrySchema),
  knownActions: z.array(ActionManifestEntrySchema),
  knownStates: z.array(z.string()),
  sourceFiles: z.array(z.string()),
  /** True when the route is not a tenant-role route (platform console, public auth screens). */
  outsideTenantRoleModel: z.boolean().default(false),
  /** Route this path redirects to instead of rendering a page, when it is a pure redirect. */
  redirectsTo: z.string().optional(),
});
export type RouteManifestEntry = z.infer<typeof RouteManifestEntrySchema>;

export const ApplicationManifestSchema = z.object({
  generatedFrom: z.object({
    commit: z.string(),
    branch: z.string(),
    appSource: z.string(),
    navigationSource: z.string(),
  }),
  /** Honest statement of what static extraction can and cannot prove. Rendered into reports. */
  limitations: z.array(z.string()).min(1),
  routes: z.array(RouteManifestEntrySchema),
  totals: z.object({
    routes: z.number().int().nonnegative(),
    sections: z.number().int().nonnegative(),
    controls: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  }),
});
export type ApplicationManifest = z.infer<typeof ApplicationManifestSchema>;

/* ------------------------------------------------------------------ role-route matrix */

export const RouteAccessVerdictSchema = z.enum([
  'EXPECTED_ACCESS',
  'EXPECTED_DENIAL',
  'CONDITIONAL_ACCESS',
  'NOT_APPLICABLE',
  'UNKNOWN_REQUIRES_REVIEW',
]);
export type RouteAccessVerdict = z.infer<typeof RouteAccessVerdictSchema>;

export const RoleRouteCellSchema = z.object({
  verdict: RouteAccessVerdictSchema,
  /** Why the verdict is what it is, traced to a guard in App.tsx or a nav rule in Layout.tsx. */
  rationale: z.string().min(1),
  navigationVisible: z.boolean(),
  redirectsTo: z.string().optional(),
});
export type RoleRouteCell = z.infer<typeof RoleRouteCellSchema>;

export const RoleRouteMatrixSchema = z.object({
  generatedFrom: z.object({ commit: z.string(), branch: z.string() }),
  roles: z.array(QaRoleSchema),
  rows: z.array(
    z.object({
      route: z.string(),
      pageComponent: z.string(),
      cells: z.record(QaRoleSchema, RoleRouteCellSchema),
    }),
  ),
});
export type RoleRouteMatrix = z.infer<typeof RoleRouteMatrixSchema>;

/* ----------------------------------------------------------------- role-action matrix */

export const ActionAuthorizationVerdictSchema = z.enum([
  'ALLOWED_AND_SUCCEEDS',
  'DENIED_IN_UI',
  'DENIED_BY_SERVER',
  'HIDDEN_BUT_SERVER_ALLOWS',
  'VISIBLE_BUT_SERVER_DENIES',
  'CONDITIONAL',
  'NOT_APPLICABLE',
  'NOT_TESTED',
]);
export type ActionAuthorizationVerdict = z.infer<typeof ActionAuthorizationVerdictSchema>;

export const RoleActionCellSchema = z.object({
  verdict: ActionAuthorizationVerdictSchema,
  uiVisible: z.boolean().nullable(),
  serverAllows: z.boolean().nullable(),
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type RoleActionCell = z.infer<typeof RoleActionCellSchema>;

export const RoleActionMatrixSchema = z.object({
  generatedFrom: z.object({ commit: z.string(), branch: z.string() }),
  roles: z.array(QaRoleSchema),
  rows: z.array(
    z.object({
      actionId: z.string(),
      route: z.string(),
      name: z.string(),
      actionType: ActionTypeSchema,
      destructive: z.boolean(),
      financial: z.boolean(),
      cells: z.record(QaRoleSchema, RoleActionCellSchema),
    }),
  ),
});
export type RoleActionMatrix = z.infer<typeof RoleActionMatrixSchema>;

/* --------------------------------------------------------------- component coverage */

export const InteractionResultSchema = z.enum([
  'PASSED',
  'FAILED',
  'BLOCKED',
  'NOT_APPLICABLE',
  'NOT_RENDERED',
]);
export type InteractionResult = z.infer<typeof InteractionResultSchema>;

export const ComponentCoverageResultSchema = z.object({
  runId: z.string().min(1),
  role: QaRoleSchema,
  route: z.string().min(1),
  section: z.string().min(1),
  controlId: z.string().min(1),
  visibleLabel: z.string().optional(),
  accessibleName: z.string().optional(),
  semanticRole: z.string().optional(),
  expectedAvailability: z.boolean(),
  actualAvailability: z.boolean(),
  interactionAttempted: z.boolean(),
  interactionResult: InteractionResultSchema,
  persistenceChecked: z.boolean(),
  authorizationChecked: z.boolean(),
  accessibilityChecked: z.boolean(),
  evidence: z.array(z.string()),
  findingIds: z.array(z.string()),
  /** Free-text note; redacted before it is written. Empty when there is nothing to say. */
  note: z.string().optional(),
});
export type ComponentCoverageResult = z.infer<typeof ComponentCoverageResultSchema>;

/* ------------------------------------------------------------------- state coverage */

export const COVERAGE_STATES = [
  'loading',
  'empty',
  'populated',
  'validation_error',
  'server_error',
  'success',
  'disabled',
  'permission_denied',
  'expired_session',
  'stale_data',
  'duplicate_submission',
  'long_text',
  'large_table',
  'no_search_results',
  'filtered_results',
  'dialog_open',
  'dialog_closed',
  'upload_in_progress',
  'upload_failed',
  'download_completed',
  'offline_or_failed_request',
] as const;
export const CoverageStateSchema = z.enum(COVERAGE_STATES);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

export const StateCoverageStatusSchema = z.enum([
  'OBSERVED',
  'NOT_OBSERVED',
  'BLOCKED',
  'NOT_APPLICABLE',
  'UNSAFE_TO_PRODUCE',
]);
export type StateCoverageStatus = z.infer<typeof StateCoverageStatusSchema>;

export const StateCoverageRecordSchema = z.object({
  runId: z.string(),
  role: QaRoleSchema,
  route: z.string(),
  state: CoverageStateSchema,
  status: StateCoverageStatusSchema,
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type StateCoverageRecord = z.infer<typeof StateCoverageRecordSchema>;

export const StateCoverageSchema = z.object({
  runId: z.string(),
  records: z.array(StateCoverageRecordSchema),
});
export type StateCoverage = z.infer<typeof StateCoverageSchema>;

/* -------------------------------------------------------------------- role coverage */

export const CoverageStatusSchema = z.enum([
  'COVERAGE_COMPLETED',
  'COVERAGE_PARTIAL',
  'COVERAGE_BLOCKED',
  'INFRASTRUCTURE_FAILED',
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

export const RouteCoverageResultSchema = z.object({
  route: z.string(),
  role: QaRoleSchema,
  expectedVerdict: RouteAccessVerdictSchema,
  navigationVisible: z.boolean().nullable(),
  directAccessOutcome: z.enum(['RENDERED', 'REDIRECTED', 'ERROR', 'NOT_ATTEMPTED']),
  landedPath: z.string().optional(),
  protectedContentRendered: z.boolean().nullable(),
  dataReturned: z.boolean().nullable(),
  refreshStable: z.boolean().nullable(),
  informationLeakBeforeRedirect: z.boolean().nullable(),
  consoleErrors: z.array(z.string()).default([]),
  failedRequests: z.array(z.string()).default([]),
  timingsMs: z.record(z.string(), z.number()).default({}),
  status: z.enum([
    'PASSED',
    'FAILED',
    'BLOCKED',
    'SKIPPED_BY_CONFIGURATION',
    'NOT_RENDERED',
    'NOT_APPLICABLE',
    'REQUIRES_BUSINESS_DECISION',
  ]),
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type RouteCoverageResult = z.infer<typeof RouteCoverageResultSchema>;

export const CoveragePercentagesSchema = z.object({
  routes: z.number(),
  components: z.number(),
  actions: z.number(),
  forms: z.number(),
  tables: z.number(),
  dialogs: z.number(),
  permissions: z.number(),
  accessibility: z.number(),
  states: z.number(),
  responsiveViewports: z.number(),
  dataPersistence: z.number(),
});
export type CoveragePercentages = z.infer<typeof CoveragePercentagesSchema>;

export const RoleCoverageSummarySchema = z.object({
  role: QaRoleSchema,
  coverageStatus: CoverageStatusSchema,
  assignedRoutes: z.number().int().nonnegative(),
  inspectedRoutes: z.number().int().nonnegative(),
  notInspectedRoutes: z.array(z.string()).default([]),
  discoveredControls: z.number().int().nonnegative(),
  testedControls: z.number().int().nonnegative(),
  percentages: CoveragePercentagesSchema,
  unexplainedGaps: z.array(z.string()).default([]),
  blockedItems: z.array(z.string()).default([]),
});
export type RoleCoverageSummary = z.infer<typeof RoleCoverageSummarySchema>;

export const CoverageSummarySchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  branch: z.string(),
  commit: z.string(),
  /** Coverage completeness. Deliberately separate from product quality. */
  coverageStatus: CoverageStatusSchema,
  productQualityStatus: z.enum(['PASS', 'PASS_WITH_FINDINGS', 'FAIL', 'NOT_ASSESSED']),
  totals: z.object({
    routes: z.number().int().nonnegative(),
    sections: z.number().int().nonnegative(),
    controls: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    componentCoverageRecords: z.number().int().nonnegative(),
    stateCoverageRecords: z.number().int().nonnegative(),
  }),
  roles: z.array(RoleCoverageSummarySchema),
  limitations: z.array(z.string()).min(1),
});
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

/* -------------------------------------------------------------------------- triage */

export const TriageClassificationSchema = z.enum([
  'CONFIRMED_DEFECT',
  'EXPECTED_BEHAVIOR',
  'FALSE_POSITIVE',
  'BUSINESS_DECISION_REQUIRED',
  'INCONCLUSIVE',
]);
export type TriageClassification = z.infer<typeof TriageClassificationSchema>;

export const TriagedObservationSchema = z.object({
  id: z.string(),
  title: z.string(),
  role: QaRoleSchema.nullable(),
  route: z.string().nullable(),
  classification: TriageClassificationSchema,
  rationale: z.string().min(1),
  reproducedTimes: z.number().int().nonnegative(),
  sourceReference: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  duplicateOf: z.string().nullable().default(null),
});
export type TriagedObservation = z.infer<typeof TriagedObservationSchema>;
