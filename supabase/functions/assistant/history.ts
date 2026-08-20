import {
  ASSISTANT_ROLES,
  AssistantAnswerSchema,
  DATA_CLASSES,
  EVIDENCE_ENTITIES,
  FACT_KINDS,
  FACT_UNITS,
  type ActorContext,
  type AssistantAnswer,
  type DataClass,
  type EvidenceEntity,
  type Fact,
  type FactKind,
  type FactUnit,
  type SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import {
  authorizeAssistantEvidence,
  type EvidenceAuthorizationPort,
} from "./evidence-authorization.ts";
import { AssistantEdgeError } from "./errors.ts";
import { validateAnswer } from "./validate.ts";

export interface HistorySnapshotRpc {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface AuthorizedConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface SnapshotRow {
  runId: string;
  author: "user" | "assistant";
  question: string | null;
  blocks: unknown;
  actor: ActorContext;
  facts: Fact[];
  sources: SourceReference[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function parseActor(value: unknown): ActorContext | null {
  if (!isRecord(value) || !isRecord(value.capabilities)) return null;
  const capabilities = value.capabilities;
  if (
    typeof value.userId !== "string" || typeof value.orgId !== "string" ||
    !oneOf(value.role, ASSISTANT_ROLES) || !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    typeof value.canWrite !== "boolean" ||
    typeof capabilities.ui !== "boolean" ||
    typeof capabilities.history !== "boolean" ||
    typeof capabilities.drafts !== "boolean" ||
    typeof capabilities.confirmedActions !== "boolean"
  ) return null;
  return {
    userId: value.userId,
    orgId: value.orgId,
    role: value.role,
    scopes: value.scopes as string[],
    canWrite: value.canWrite,
    capabilities: {
      ui: capabilities.ui,
      history: capabilities.history,
      drafts: capabilities.drafts,
      confirmedActions: capabilities.confirmedActions,
    },
  };
}

function parseSubject(
  value: unknown,
): { entity: EvidenceEntity; id: string } | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) || !oneOf(value.entity, EVIDENCE_ENTITIES) ||
    typeof value.id !== "string"
  ) return undefined;
  return { entity: value.entity, id: value.id };
}

function parseFacts(value: unknown): Fact[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Fact[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const subject = parseSubject(item.subject);
    if (
      subject === undefined || typeof item.id !== "string" ||
      !oneOf(item.kind, FACT_KINDS) || typeof item.label !== "string" ||
      !oneOf(item.unit, FACT_UNITS) || typeof item.tool !== "string" ||
      typeof item.as_of !== "string" ||
      !oneOf(item.classification, DATA_CLASSES) ||
      !(
        item.value === null || typeof item.value === "number" ||
        typeof item.value === "string"
      )
    ) return null;
    parsed.push({
      id: item.id,
      kind: item.kind as FactKind,
      subject,
      label: item.label,
      value: item.value,
      unit: item.unit as FactUnit,
      tool: item.tool,
      as_of: item.as_of,
      classification: item.classification as DataClass,
    });
  }
  return parsed;
}

function parseSources(value: unknown): SourceReference[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SourceReference[] = [];
  for (const item of value) {
    if (
      !isRecord(item) || typeof item.id !== "string" ||
      !oneOf(item.entity, EVIDENCE_ENTITIES) ||
      typeof item.entity_id !== "string" || typeof item.label !== "string" ||
      !(item.route === null || typeof item.route === "string") ||
      !oneOf(item.classification, DATA_CLASSES)
    ) return null;
    parsed.push({
      id: item.id,
      entity: item.entity,
      entity_id: item.entity_id,
      label: item.label,
      route: item.route,
      classification: item.classification,
    });
  }
  return parsed;
}

function parseRow(value: unknown): SnapshotRow | null {
  if (!isRecord(value)) return null;
  const actor = parseActor(value.actor);
  const facts = parseFacts(value.facts);
  const sources = parseSources(value.sources);
  if (
    !actor || !facts || !sources || typeof value.run_id !== "string" ||
    (value.author !== "user" && value.author !== "assistant") ||
    !(value.question === null || typeof value.question === "string")
  ) return null;
  return {
    runId: value.run_id,
    author: value.author,
    question: value.question,
    blocks: value.blocks,
    actor,
    facts,
    sources,
  };
}

export async function loadAuthorizedConversationContext(
  service: HistorySnapshotRpc,
  authorization: EvidenceAuthorizationPort,
  values: { actor: ActorContext; conversationId: string; limit: number },
): Promise<AuthorizedConversationMessage[]> {
  const result = await service.rpc("service_assistant_conversation_snapshot", {
    p_org_id: values.actor.orgId,
    p_user_id: values.actor.userId,
    p_conversation_id: values.conversationId,
    p_limit: values.limit,
  });
  if (result.error || !isRecord(result.data) || !Array.isArray(result.data.messages)) {
    throw new AssistantEdgeError("assistant_history_unavailable");
  }

  const rows = result.data.messages.map(parseRow);
  const usableRows = rows.filter((row): row is SnapshotRow => row !== null);
  const answers = new Map<string, AssistantAnswer>();
  const byRun = new Map<string, SnapshotRow[]>();
  for (const row of usableRows) {
    const runRows = byRun.get(row.runId) ?? [];
    runRows.push(row);
    byRun.set(row.runId, runRows);
  }

  for (const [runId, runRows] of byRun) {
    const assistant = runRows.find((row) => row.author === "assistant");
    if (!assistant) continue;
    const parsedAnswer = AssistantAnswerSchema.safeParse(assistant.blocks);
    if (!parsedAnswer.success) continue;
    const validated = validateAnswer(
      parsedAnswer.data,
      assistant.facts,
      assistant.sources,
      assistant.actor.role,
    );
    if (!validated.ok) continue;
    const allowed = await authorizeAssistantEvidence(
      authorization,
      assistant.actor,
      validated.answer,
      assistant.facts,
      assistant.sources,
    );
    if (allowed.ok) answers.set(runId, validated.answer);
  }

  const context: AuthorizedConversationMessage[] = [];
  for (const row of usableRows) {
    const authorizedAnswer = answers.get(row.runId);
    if (!authorizedAnswer) continue;
    if (row.author === "user" && row.question) {
      context.push({ role: "user", content: row.question });
    } else if (row.author === "assistant") {
      context.push({ role: "assistant", content: JSON.stringify(authorizedAnswer) });
    }
  }
  return context;
}
