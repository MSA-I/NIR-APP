import {
  ASSISTANT_ROLES,
  AssistantAnswerSchema,
  AssistantRunResultSchema,
  DATA_CLASSES,
  EVIDENCE_ENTITIES,
  FACT_KINDS,
  isFactUnit,
  type ActorContext,
  type AssistantRunResult,
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
import { classifyAssistantProviderText } from "./input-classification.ts";
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

export interface AuthorizedConversationView {
  question: string;
  result: AssistantRunResult;
}

export interface AuthorizedConversationListRow {
  id: string;
  title: string;
  updated_at: string;
}

interface SnapshotTool {
  tool: string;
  complete: boolean;
}

interface SnapshotRow {
  runId: string;
  runAsOf: string;
  complete: boolean;
  tools: SnapshotTool[];
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
      !isFactUnit(item.unit) || typeof item.tool !== "string" ||
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
      // The declared window travels with the citation or the citation is not the one that was
      // issued. Absent is fine -- most references declare no shaped filter -- but a value that
      // is not a map is a corrupt row, not a reference with no window.
      !(item.route_params === null || item.route_params === undefined || isRecord(item.route_params)) ||
      !oneOf(item.classification, DATA_CLASSES)
    ) return null;
    parsed.push({
      id: item.id,
      entity: item.entity,
      entity_id: item.entity_id,
      label: item.label,
      route: item.route,
      ...(isRecord(item.route_params) ? { route_params: item.route_params as Record<string, string> } : {}),
      classification: item.classification,
    });
  }
  return parsed;
}

function parseTools(value: unknown): SnapshotTool[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const tools: SnapshotTool[] = [];
  for (const item of value) {
    if (
      !isRecord(item) || typeof item.tool !== "string" ||
      typeof item.complete !== "boolean"
    ) return null;
    tools.push({ tool: item.tool, complete: item.complete });
  }
  return tools;
}

function parseRow(value: unknown): SnapshotRow | null {
  if (!isRecord(value)) return null;
  const actor = parseActor(value.actor);
  const facts = parseFacts(value.facts);
  const sources = parseSources(value.sources);
  const tools = parseTools(value.tools);
  if (
    !actor || !facts || !sources || !tools || typeof value.run_id !== "string" ||
    typeof value.run_as_of !== "string" || typeof value.complete !== "boolean" ||
    (value.author !== "user" && value.author !== "assistant") ||
    !(value.question === null || typeof value.question === "string")
  ) return null;
  return {
    runId: value.run_id,
    runAsOf: value.run_as_of,
    complete: value.complete,
    tools,
    author: value.author,
    question: value.question,
    blocks: value.blocks,
    actor,
    facts,
    sources,
  };
}

export async function loadAuthorizedConversationViews(
  service: HistorySnapshotRpc,
  authorization: EvidenceAuthorizationPort,
  values: { actor: ActorContext; conversationId: string; limit: number },
): Promise<AuthorizedConversationView[]> {
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
  const byRun = new Map<string, SnapshotRow[]>();
  for (const row of usableRows) {
    const runRows = byRun.get(row.runId) ?? [];
    runRows.push(row);
    byRun.set(row.runId, runRows);
  }

  const views: AuthorizedConversationView[] = [];
  for (const [runId, runRows] of byRun) {
    const user = runRows.find((row) => row.author === "user");
    const assistant = runRows.find((row) => row.author === "assistant");
    if (!user?.question || !assistant) continue;
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
    if (!allowed.ok) continue;

    // Stored questions and answer prose are browser-authored/model-authored free text, separate
    // from the field-projected facts and sources. Reclassify on every load; legacy content that
    // the current boundary would refuse is omitted as one whole run, never redacted into a
    // different-looking question.
    const serializedAnswer = JSON.stringify(validated.answer);
    if (
      !classifyAssistantProviderText(user.question).allowed ||
      !classifyAssistantProviderText(serializedAnswer).allowed
    ) continue;
    const candidate = AssistantRunResultSchema.safeParse({
      run_id: runId,
      conversation_id: values.conversationId,
      answer: validated.answer,
      facts: assistant.facts,
      sources: assistant.sources,
      tools_used: assistant.tools,
      complete: assistant.complete,
      as_of: assistant.runAsOf,
      proposal: null,
    });
    if (!candidate.success) continue;
    views.push({ question: user.question, result: candidate.data });
  }

  return views;
}

export async function loadAuthorizedConversationContext(
  service: HistorySnapshotRpc,
  authorization: EvidenceAuthorizationPort,
  values: { actor: ActorContext; conversationId: string; limit: number },
): Promise<AuthorizedConversationMessage[]> {
  const views = await loadAuthorizedConversationViews(service, authorization, values);
  const context: AuthorizedConversationMessage[] = [];
  for (const view of views) {
    context.push({ role: "user", content: view.question });
    context.push({ role: "assistant", content: JSON.stringify(view.result.answer) });
  }
  return context;
}

/**
 * How long a conversation survives without being used (OPEN-DECISIONS #272, owner 25.08.2026).
 *
 * The owner asked for a thread "without history — meaning after 24 hours of no use it resets".
 * That is an EXPIRY, not the absence of persistence: within the window a refresh, a tab close or
 * a lunch break must not end the conversation, which is the behaviour `95f10e2` was written to
 * fix. Past the window the thread is not offered back, and the next question starts a new one.
 */
export const CONVERSATION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** True when a conversation has been idle longer than the window and must not be resumed. */
export function isConversationExpired(updatedAt: string, now: Date): boolean {
  const last = Date.parse(updatedAt);
  // An unparsable timestamp is treated as expired: the safe direction is to start a new thread,
  // never to resurrect one whose age cannot be established.
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last > CONVERSATION_IDLE_TTL_MS;
}

export async function listAuthorizedConversations(
  service: HistorySnapshotRpc,
  authorization: EvidenceAuthorizationPort,
  values: { actor: ActorContext; limit: number; now?: Date },
): Promise<AuthorizedConversationListRow[]> {
  const recent = await service.rpc("service_assistant_recent_conversations", {
    p_org_id: values.actor.orgId,
    p_user_id: values.actor.userId,
    p_limit: values.limit,
  });
  if (
    recent.error || !isRecord(recent.data) ||
    !Array.isArray(recent.data.conversations)
  ) throw new AssistantEdgeError("assistant_history_unavailable");

  // The expiry is applied HERE, at the one boundary that decides what may come back. Everything
  // downstream -- the list the panel renders, and the adoption of the most recent thread on first
  // open -- reads this result, so filtering once is what makes the reset total rather than
  // cosmetic. A stale row is simply never offered; it is not deleted here, and the documents say
  // so rather than implying a purge this function does not perform.
  const now = values.now ?? new Date();
  const candidates = recent.data.conversations.flatMap((value) => {
    if (
      !isRecord(value) || typeof value.id !== "string" ||
      typeof value.updated_at !== "string"
    ) return [];
    if (isConversationExpired(value.updated_at, now)) return [];
    return [{ id: value.id, updated_at: value.updated_at }];
  });

  const rows: AuthorizedConversationListRow[] = [];
  let snapshotFailures = 0;
  for (const candidate of candidates) {
    try {
      const views = await loadAuthorizedConversationViews(service, authorization, {
        actor: values.actor,
        conversationId: candidate.id,
        limit: 2,
      });
      const latest = views.at(-1);
      if (!latest) continue;
      rows.push({
        id: candidate.id,
        title: latest.question.replace(/\s+/g, " ").trim().slice(0, 120),
        updated_at: candidate.updated_at,
      });
    } catch {
      snapshotFailures += 1;
    }
  }
  if (candidates.length > 0 && snapshotFailures === candidates.length) {
    throw new AssistantEdgeError("assistant_history_unavailable");
  }
  return rows;
}
