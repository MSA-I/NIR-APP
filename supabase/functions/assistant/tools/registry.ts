// The typed, allowlisted tool registry. The model may never choose SQL, a table, a column, an
// RPC name or a route -- it may only name a tool registered here, and every tool declares its
// input schema, the roles that may run it, and the classification of what it returns. Tool
// output reaches the provider only through serializeEnvelopeForProvider(), which is where the
// provider-forbidden classes are enforced mechanically rather than by convention.
import { z } from "zod";
import {
  type ActorContext,
  type AssistantRole,
  type DataClass,
  type Fact,
  mayReachProvider,
  type SourceReference,
  type ToolEnvelope,
} from "../../../../src/lib/assistant/contracts.ts";

export interface ToolRpcResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * The narrow database surface tools may touch, always under the CALLER's JWT so RLS applies.
 * A supabase-js client is adapted to this in index.ts; tests hand in fakes.
 */
export interface ToolDataPort {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<ToolRpcResult>;
  /** `purchase_orders` rows with status='sent', counted head-only -- the one non-RPC read. */
  countSentOrders(): Promise<
    { count: number | null; error: { message: string } | null }
  >;
}

/** Issues run-scoped fact/source ids. Ids are meaningless outside the run that issued them --
 * that is what makes "cite only what this run returned" checkable. */
export class RunEvidence {
  readonly facts: Fact[] = [];
  readonly sources: SourceReference[] = [];

  fact(values: Omit<Fact, "id">): Fact {
    const issued: Fact = { ...values, id: `f${this.facts.length + 1}` };
    this.facts.push(issued);
    return issued;
  }

  source(values: Omit<SourceReference, "id">): SourceReference {
    const issued: SourceReference = {
      ...values,
      id: `s${this.sources.length + 1}`,
    };
    this.sources.push(issued);
    return issued;
  }
}

export interface ToolContext {
  db: ToolDataPort;
  actor: ActorContext;
  evidence: RunEvidence;
  now: () => Date;
}

export interface AssistantTool {
  name: string;
  /** Hebrew, because the answer is Hebrew and the description is the model's only manual. */
  description: string;
  inputSchema: z.ZodTypeAny;
  /** Strict JSON schema for the provider's function declaration. */
  inputJsonSchema: Record<string, unknown>;
  requiredRoles: readonly AssistantRole[];
  /** The classification of this tool's OUTPUT as a whole; individual facts may narrow it. */
  classification: DataClass;
  run(ctx: ToolContext, input: unknown): Promise<ToolEnvelope>;
}

export type ToolRegistry = ReadonlyMap<string, AssistantTool>;

export function buildRegistry(tools: readonly AssistantTool[]): ToolRegistry {
  const registry = new Map<string, AssistantTool>();
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    registry.set(tool.name, tool);
  }
  return registry;
}

export function emptyEnvelope(
  failures: { code: string; label: string }[],
  asOf: string,
): ToolEnvelope {
  return {
    data: [],
    complete: false,
    failures,
    filters: {},
    as_of: asOf,
    result_count: 0,
    has_more: false,
    facts: [],
    sources: [],
    warnings: [],
  };
}

/**
 * Runs one tool call from the model. Every refusal is an envelope, not an exception: the model
 * gets a named failure it can explain, and a failure can never read as a clean sheet because
 * `complete` is false on every one of these paths.
 */
export async function runRegisteredTool(
  registry: ToolRegistry,
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<ToolEnvelope> {
  const asOf = ctx.now().toISOString();
  const tool = registry.get(name);
  if (!tool) {
    return emptyEnvelope(
      [{ code: "unknown_tool", label: "כלי לא מוכר" }],
      asOf,
    );
  }
  if (!tool.requiredRoles.includes(ctx.actor.role)) {
    return emptyEnvelope(
      [{ code: "not_permitted", label: "אין הרשאה לכלי הזה" }],
      asOf,
    );
  }
  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return emptyEnvelope(
      [{ code: "invalid_tool_input", label: "קלט הכלי אינו תקין" }],
      asOf,
    );
  }
  try {
    return await tool.run(ctx, parsed.data);
  } catch {
    return emptyEnvelope(
      [{ code: "tool_failed", label: "שליפת הנתונים נכשלה" }],
      asOf,
    );
  }
}

/**
 * What the provider is allowed to see of a tool result. Three deliberate reductions:
 *  - facts and sources with a provider-forbidden classification are removed and replaced by a
 *    failure entry, so their absence is stated rather than silent;
 *  - routes are withheld -- the model references sources by id and the browser resolves routes
 *    from the server's own copy, so an invented route has nowhere to enter;
 *  - `data` is withheld -- facts and sources ARE the interface; raw rows never ride along.
 */
export function serializeEnvelopeForProvider(
  envelope: ToolEnvelope,
): Record<string, unknown> {
  const withheld: { code: string; label: string }[] = [];
  const facts = envelope.facts.filter((fact) => {
    if (mayReachProvider(fact.classification)) return true;
    withheld.push({
      code: "fact_withheld_by_classification",
      label: fact.label,
    });
    return false;
  });
  const sources = envelope.sources.filter((source) => {
    if (mayReachProvider(source.classification)) return true;
    withheld.push({
      code: "source_withheld_by_classification",
      label: source.label,
    });
    return false;
  });
  return {
    complete: withheld.length === 0 ? envelope.complete : false,
    failures: [...envelope.failures, ...withheld],
    filters: envelope.filters,
    as_of: envelope.as_of,
    result_count: envelope.result_count,
    has_more: envelope.has_more,
    warnings: envelope.warnings,
    facts: facts.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      label: fact.label,
      value: fact.value,
      unit: fact.unit,
      as_of: fact.as_of,
    })),
    sources: sources.map((source) => ({
      id: source.id,
      entity: source.entity,
      label: source.label,
    })),
  };
}
