import { z } from 'zod';
import type {
  BrowserMutationEvidence,
} from '../browser/browser-tools.ts';
import type { QaRole } from '../config/roles.ts';
import {
  AgentEvidenceSchema,
  VerificationRequestSchema,
  type VerificationRequest,
} from './contracts.ts';
import { redactAgentText } from './model-adapter.ts';

const scalarFact = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const VerifierEvidenceSchema = AgentEvidenceSchema.pick({
  kind: true,
  ref: true,
});

export const VerifierResultSchema = z.object({
  status: z.enum(['verified', 'failed', 'blocked']),
  summary: z.string().trim().min(1).max(4_000),
  evidence: z.array(VerifierEvidenceSchema).max(100),
  facts: z.array(z.object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
    value: scalarFact,
  }).strict()).max(100),
}).strict();

export type VerifierResult = z.infer<typeof VerifierResultSchema>;

export const BrowserMutationEvidenceSchema = z.object({
  source: z.literal('browser-action'),
  actionId: z.string().uuid(),
  step: z.number().int().positive(),
  role: z.enum(['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier']),
  scenarioId: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  actionType: z.enum([
    'open', 'snapshot', 'click', 'fill', 'select', 'upload', 'press',
    'scroll', 'wait_for_text', 'screenshot', 'current_url',
  ]),
  description: z.string().trim().min(1).max(1_000),
  expectedMutation: z.string().trim().min(1).max(4_000),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  routeBefore: z.string().trim().startsWith('/').max(500),
  routeAfter: z.string().trim().startsWith('/').max(500),
  preScreenshot: z.string().trim().min(1).max(1_000),
  postScreenshot: z.string().trim().min(1).max(1_000),
  notification: z.object({
    kind: z.enum(['success', 'error', 'none']),
    text: z.string().trim().min(1).max(1_000).nullable(),
  }).strict(),
  network: z.array(z.object({
    requestId: z.string().trim().min(1).max(200),
    method: z.string().trim().min(1).max(20),
    pathname: z.string().trim().startsWith('/').max(1_000),
    resourceType: z.string().trim().min(1).max(100),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    failure: z.string().trim().min(1).max(1_000).nullable(),
    mutationCandidate: z.boolean(),
    responseBodyParsed: z.boolean(),
    responseFacts: z.record(z.union([
      z.string().max(300), z.number().finite(), z.boolean(), z.null(),
    ])),
    entityRefs: VerificationRequestSchema.shape.entityRefs,
  }).strict()).max(100),
  entityRefsSource: z.literal('response-body'),
  entityRefs: VerificationRequestSchema.shape.entityRefs,
  hasMutationRequest: z.boolean(),
  actionError: z.string().trim().min(1).max(1_000).nullable(),
  evidenceRefs: z.array(z.string().trim().min(1).max(1_000)).min(3).max(50),
}).strict();

export type { BrowserMutationEvidence } from '../browser/browser-tools.ts';

export interface VerifierCallbackInput {
  readonly runId: string;
  readonly role: QaRole;
  readonly scenarioId: string;
  readonly step: number;
  readonly actionType: BrowserMutationEvidence['actionType'];
  readonly meaningfulBusinessAction: boolean;
  /** Trusted output of the browser action for this exact step; never supplied by the model. */
  readonly mutationEvidence: BrowserMutationEvidence | null;
  readonly request: VerificationRequest;
}

/** Trusted outer-layer callback. It may close over verifier infrastructure; that closure is never
 * exposed by VerifierAgent and never appears in role-agent or model input. */
export type VerifierCallback = (
  input: VerifierCallbackInput,
) => Promise<VerifierResult>;

export interface VerifierAgent {
  readonly allowedCheckIds: readonly string[];
  verify(input: VerifierCallbackInput): Promise<VerifierResult>;
}

export class VerifierAgentError extends Error {
  readonly code:
    | 'verifier_check_not_allowed'
    | 'verifier_invalid_request'
    | 'verifier_invalid_result'
    | 'verifier_callback_failed';

  constructor(code: VerifierAgentError['code'], options?: { cause?: unknown }) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VerifierAgentError';
    this.code = code;
  }
}

export function createVerifierAgent(options: {
  readonly allowedCheckIds: readonly string[];
  readonly callback: VerifierCallback;
}): VerifierAgent {
  const allowed = new Set(options.allowedCheckIds);
  const seenActionIds = new Set<string>();
  return Object.freeze({
    allowedCheckIds: Object.freeze([...allowed]),
    async verify(input: VerifierCallbackInput): Promise<VerifierResult> {
      const request = VerificationRequestSchema.safeParse(input.request);
      if (!request.success) throw new VerifierAgentError('verifier_invalid_request');
      if (!allowed.has(request.data.checkId)) {
        throw new VerifierAgentError('verifier_check_not_allowed');
      }
      const mutationEvidence = input.mutationEvidence === null
        ? null
        : BrowserMutationEvidenceSchema.safeParse(input.mutationEvidence);
      if (mutationEvidence !== null && !mutationEvidence.success) {
        throw new VerifierAgentError('verifier_invalid_request');
      }
      const trustedMutation = (mutationEvidence?.data ?? null) as BrowserMutationEvidence | null;
      if (input.meaningfulBusinessAction && (
        trustedMutation === null
        || trustedMutation.step !== input.step
        || trustedMutation.actionType !== input.actionType
        || trustedMutation.role !== input.role
        || trustedMutation.scenarioId !== input.scenarioId
      )) {
        return {
          status: 'blocked',
          summary: 'The browser action exposed no trusted mutation evidence for this exact step; model-provided entity references were not used.',
          evidence: [],
          facts: [
            { key: 'trusted_mutation_evidence', value: false },
            { key: 'verification_step', value: input.step },
          ],
        };
      }
      if (input.meaningfulBusinessAction && trustedMutation) {
        if (seenActionIds.has(trustedMutation.actionId)) {
          return {
            status: 'failed',
            summary: 'The actionId was already verified; duplicate action evidence was rejected.',
            evidence: [],
            facts: [
              { key: 'unique_action_id', value: false },
              { key: 'verification_step', value: input.step },
            ],
          };
        }
        seenActionIds.add(trustedMutation.actionId);
        const mutationEntries = trustedMutation.network.filter(({ mutationCandidate }) =>
          mutationCandidate);
        if (!trustedMutation.hasMutationRequest || mutationEntries.length === 0) {
          return {
            status: 'blocked',
            summary: 'The action did not expose a trusted mutation request.',
            evidence: [],
            facts: [
              { key: 'trusted_mutation_request', value: trustedMutation.hasMutationRequest },
              { key: 'mutation_request_count', value: mutationEntries.length },
            ],
          };
        }
        const mutationSucceeded = mutationEntries.some(({ status }) =>
          status !== null && status >= 200 && status < 300);
        const mutationFailed = mutationEntries.some(({ status, failure }) =>
          failure !== null || (status !== null && (status < 200 || status >= 300)));
        const failureOutcomeObserved = mutationFailed
          || trustedMutation.notification.kind === 'error';
        if (mutationSucceeded && !failureOutcomeObserved && (
          trustedMutation.entityRefsSource !== 'response-body'
          || trustedMutation.entityRefs.length === 0
        )) {
          return {
            status: 'blocked',
            summary: 'The successful mutation did not expose response-derived entity identifiers.',
            evidence: [],
            facts: [
              { key: 'trusted_mutation_request', value: true },
              { key: 'successful_mutation_response', value: true },
              { key: 'response_entity_count', value: trustedMutation.entityRefs.length },
            ],
          };
        }
      }
      const callbackRequest = input.meaningfulBusinessAction && trustedMutation
        ? { ...request.data, entityRefs: [...trustedMutation.entityRefs] }
        : request.data;
      let raw: VerifierResult;
      try {
        raw = await options.callback({
          ...input,
          request: callbackRequest,
          mutationEvidence: trustedMutation,
        });
      } catch (error) {
        throw new VerifierAgentError('verifier_callback_failed', { cause: error });
      }
      const result = VerifierResultSchema.safeParse(raw);
      if (!result.success) throw new VerifierAgentError('verifier_invalid_result');
      return {
        ...result.data,
        summary: redactAgentText(result.data.summary, 4_000),
        evidence: result.data.evidence.map((evidence) => ({
          ...evidence,
          ref: redactAgentText(evidence.ref, 500),
        })),
      };
    },
  });
}
