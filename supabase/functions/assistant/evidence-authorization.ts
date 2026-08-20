import type {
  ActorContext,
  AssistantAnswer,
  EvidenceEntity,
  Fact,
  SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import { assistantSourceRouteDecision } from "../../../src/lib/assistant/routeAccess.ts";
import { resolveActorContext, type RpcPort } from "./auth.ts";

export interface EvidenceAuthorizationPort {
  resolveCurrentActor(): Promise<ActorContext>;
  visibleEntityIds(
    entity: EvidenceEntity,
    ids: readonly string[],
  ): Promise<readonly string[]>;
}

export type EvidenceAuthorizationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

interface EvidenceRowsResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

export interface EvidenceAuthorizationClient extends RpcPort {
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: readonly unknown[],
      ): PromiseLike<EvidenceRowsResult>;
    };
  };
}

const ENTITY_TABLES: Partial<Record<EvidenceEntity, string>> = {
  invoice: "invoices",
  purchase_order: "purchase_orders",
  supplier: "suppliers",
  product: "products",
  payment_request: "payment_requests",
  payment: "payments",
  credit_note: "credit_requests",
  exception: "exceptions",
  document: "documents",
  bank_transaction: "bank_transactions",
  organization: "organizations",
};

export function assistantActorContextsEqual(
  current: ActorContext,
  expected: ActorContext,
): boolean {
  const normalizedScopes = (actor: ActorContext) => [...actor.scopes].sort();
  return current.userId === expected.userId &&
    current.orgId === expected.orgId &&
    current.role === expected.role &&
    current.canWrite === expected.canWrite &&
    JSON.stringify(normalizedScopes(current)) ===
      JSON.stringify(normalizedScopes(expected)) &&
    current.capabilities.ui === expected.capabilities.ui &&
    current.capabilities.history === expected.capabilities.history &&
    current.capabilities.drafts === expected.capabilities.drafts &&
    current.capabilities.confirmedActions === expected.capabilities.confirmedActions;
}

export function createSupabaseEvidenceAuthorizationPort(
  client: EvidenceAuthorizationClient,
  userId: string,
): EvidenceAuthorizationPort {
  return {
    // Deliberately do not cache this lookup. History load, first generated answer and the one
    // validation retry are separate authorization moments. A role, scope, flag, profile or
    // organization lifecycle change between them must be observed before any stored or generated
    // prose crosses the provider/browser boundary.
    resolveCurrentActor: () => resolveActorContext(client, userId),
    async visibleEntityIds(entity, ids) {
      if (ids.length === 0) return [];
      const table = ENTITY_TABLES[entity];
      if (!table) return [];
      const result = await client.from(table).select("id").in("id", ids);
      if (result.error || !Array.isArray(result.data)) {
        throw new Error("assistant_evidence_access_unavailable");
      }
      return result.data.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const id = (row as Record<string, unknown>).id;
        return typeof id === "string" ? [id] : [];
      });
    },
  };
}

export async function authorizeAssistantEvidence(
  port: EvidenceAuthorizationPort,
  expectedActor: ActorContext,
  _answer: AssistantAnswer,
  facts: readonly Fact[],
  sources: readonly SourceReference[],
): Promise<EvidenceAuthorizationResult> {
  let currentActor: ActorContext;
  try {
    currentActor = await port.resolveCurrentActor();
  } catch {
    return { ok: false, errors: ["evidence:authorization_unavailable"] };
  }

  if (
    !assistantActorContextsEqual(currentActor, expectedActor) ||
    !currentActor.capabilities.ui
  ) {
    return { ok: false, errors: ["evidence:actor_context_changed"] };
  }

  const requested = new Map<EvidenceEntity, Set<string>>();
  const request = (entity: EvidenceEntity, id: string) => {
    if (entity === "organization") return;
    const ids = requested.get(entity) ?? new Set<string>();
    ids.add(id);
    requested.set(entity, ids);
  };
  for (const issuedFact of facts) {
    if (issuedFact.subject) {
      request(issuedFact.subject.entity, issuedFact.subject.id);
    }
  }
  for (const issuedSource of sources) {
    request(issuedSource.entity, issuedSource.entity_id);
  }

  const visible = new Map<EvidenceEntity, Set<string>>();
  try {
    await Promise.all([...requested].map(async ([entity, ids]) => {
      const rows = await port.visibleEntityIds(entity, [...ids]);
      visible.set(entity, new Set(rows));
    }));
  } catch {
    return { ok: false, errors: ["evidence:authorization_unavailable"] };
  }

  const mayRead = (entity: EvidenceEntity, id: string): boolean =>
    entity === "organization"
      ? id === currentActor.orgId
      : (visible.get(entity)?.has(id) ?? false);
  const errors: string[] = [];
  for (const issuedFact of facts) {
    if (
      issuedFact.subject &&
      !mayRead(issuedFact.subject.entity, issuedFact.subject.id)
    ) {
      errors.push(`fact:${issuedFact.id}:subject_not_authorized`);
    }
  }
  for (const issuedSource of sources) {
    if (!mayRead(issuedSource.entity, issuedSource.entity_id)) {
      errors.push(`source:${issuedSource.id}:entity_not_authorized`);
    }
    const route = assistantSourceRouteDecision(issuedSource, currentActor.role);
    if (route !== "allowed") {
      errors.push(`source:${issuedSource.id}:route_${route}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
