// Tool 10 -- find_entity: turns what a human says out loud ("חשבונית 4471", "אחים כהן") into an
// id the other tools can take. Backed by public.global_search(q, per_type) (0011/0069/0137/0145):
// SECURITY INVOKER, tenant-scoped, and the reachable result TYPES are decided server-side from
// auth_role(). Returns id + label + route only. Supplier subtitles (contact name, phone) are
// personal_contact and are never surfaced; payment subtitles (method, reference) are dropped too.
import { z } from "zod";
import type {
  EvidenceEntity,
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import {
  failure,
  list,
  num,
  record,
  sanitizeText,
  str,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const KINDS = [
  "any",
  "invoice",
  "supplier",
  "order",
  "product",
  "payment",
  "credit",
] as const;
const RESULT_LIMIT_PER_TYPE = 5;

const inputSchema = z
  .object({
    query: z.string().trim().min(2).max(80),
    kind: z.enum(KINDS).nullish().transform((value) => value ?? "any"),
  })
  .strict();

interface EntityMapping {
  evidence: EvidenceEntity;
  route: (id: string) => string | null;
  /** Whether the subtitle (always a supplier name for these types) is safe to show. */
  keepSubtitle: boolean;
  kindName: (typeof KINDS)[number];
}

// 'draft' (purchase request drafts, 0145) is deliberately absent: it has no evidence entity, and
// a resolver hit the other tools cannot act on is noise.
//
// THE ROUTE IS THE ROW, not the screen the row lives on. This tool answers "which record did you
// mean", so a reference that opens an unfiltered list has answered nothing — the reader is handed
// back the search they had already done. Products, payments and credits have no page of their own
// and were the three doing exactly that; each of those screens takes an `?id=` that pins the list
// to one row and opens it, so the reference carries it now.
const ENTITY_MAP: Record<string, EntityMapping> = {
  supplier: {
    evidence: "supplier",
    route: (id) => `/suppliers/${id}`,
    keepSubtitle: false, // contact name + phone -- personal_contact
    kindName: "supplier",
  },
  product: {
    evidence: "product",
    route: (id) => `/products?id=${id}`,
    keepSubtitle: false, // category + sku: harmless but not needed for resolution
    kindName: "product",
  },
  invoice: {
    evidence: "invoice",
    route: (id) => `/invoices/${id}`,
    keepSubtitle: true, // the supplier's name
    kindName: "invoice",
  },
  order: {
    evidence: "purchase_order",
    route: (id) => `/orders/${id}`,
    keepSubtitle: true,
    kindName: "order",
  },
  payment: {
    evidence: "payment",
    route: (id) => `/payments?id=${id}`,
    keepSubtitle: false, // supplier · method · reference -- reference stays inside
    kindName: "payment",
  },
  credit: {
    evidence: "credit_note",
    route: (id) => `/credits?id=${id}`,
    keepSubtitle: true,
    kindName: "credit",
  },
};

export const findEntity: AssistantTool = {
  name: "find_entity",
  description:
    "מאתר ישות במערכת לפי טקסט חופשי — מספר חשבונית, שם ספק, מספר הזמנה, שם מוצר, מספר תשלום " +
    "או זיכוי — ומחזיר מזהה, תווית ומסך יעד, כדי שכלים אחרים יוכלו לפעול על מה שהמשתמש נקב " +
    "בשמו. סוגי התוצאה מוגבלים בשרת לפי התפקיד. זהו איתור, לא תשובה: הערכים הכספיים של הישות " +
    "נמדדים בכלי הייעודי שלה.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        maxLength: 80,
        description: "מה שהמשתמש נקב בשמו: מספר מסמך, שם ספק או מוצר",
      },
      kind: {
        anyOf: [
          { type: "string", enum: [...KINDS] },
          { type: "null" },
        ],
        description: "צמצום לסוג ישות מסוים, או null לברירת המחדל (הכול)",
      },
    },
    required: ["query", "kind"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office", "accountant"],
  classification: "tenant_standard",
  async run(ctx: ToolContext, input: unknown) {
    const { query, kind } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters = { query: sanitizeText(query, 80), kind };

    const result = await ctx.db.rpc("global_search", {
      q: query,
      per_type: RESULT_LIMIT_PER_TYPE + 1,
    });
    if (result.error) {
      return failure(ctx, "entity_search_failed", readerText(ctx.locale, "assistantTools.entitySearchFailed"), filters);
    }

    const hits = list(result.data)
      .map((entry) => record(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);

    const boundedHits: {
      hit: Record<string, unknown>;
      mapping: EntityMapping;
      id: string;
    }[] = [];
    const hitsPerType = new Map<string, number>();
    let hasMore = false;
    for (const hit of hits) {
      const mapping = ENTITY_MAP[str(hit.entity) ?? ""];
      if (!mapping) continue;
      if (kind !== "any" && mapping.kindName !== kind) continue;
      const id = str(hit.id);
      if (!id) continue;
      const seen = hitsPerType.get(mapping.kindName) ?? 0;
      if (seen >= RESULT_LIMIT_PER_TYPE) {
        hasMore = true;
        continue;
      }
      hitsPerType.set(mapping.kindName, seen + 1);
      boundedHits.push({ hit, mapping, id });
    }

    const sources: SourceReference[] = [];
    const dataRows: {
      entity: EvidenceEntity;
      id: string;
      label: string;
      route: string | null;
    }[] = [];
    for (const { hit, mapping, id } of boundedHits) {
      const title = sanitizeText(hit.title, 60);
      const subtitle = mapping.keepSubtitle ? sanitizeText(hit.subtitle, 40) : "";
      const label = subtitle ? `${title} — ${subtitle}` : title;
      const route = mapping.route(id);
      dataRows.push({ entity: mapping.evidence, id, label, route });
      sources.push(ctx.evidence.source({
        entity: mapping.evidence,
        entity_id: id,
        label,
        route,
        classification: "tenant_standard",
      }));
    }

    const facts: Fact[] = [ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: readerText(ctx.locale, "assistantTools.entityResultsFound"),
      value: dataRows.length,
      unit: "count",
      tool: findEntity.name,
      as_of: asOf,
      classification: "tenant_standard",
    })];

    // amount rides on invoice/payment/credit hits; it is already computed server-side and citable.
    for (const { hit, mapping, id } of boundedHits) {
      if (mapping.evidence !== "invoice") continue;
      const amount = num(hit.amount);
      if (amount === null) continue;
      facts.push(ctx.evidence.fact({
        kind: "invoice.total",
        subject: { entity: "invoice", id },
        label: `${readerText(ctx.locale, "assistantTools.invoiceAmount")} — ${sanitizeText(hit.title, 40)}`,
        value: amount,
        unit: "ils",
        tool: findEntity.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
    }

    return {
      data: dataRows,
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: dataRows.length,
      has_more: hasMore,
      facts,
      sources,
      warnings: dataRows.length > 0 ? [UNTRUSTED_TEXT_WARNING] : [],
    };
  },
};
