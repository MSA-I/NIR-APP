// Tool 14 -- get_product_help: "how do I do X in this product", answered ONLY from the versioned
// registry OPEN-DECISIONS #192 made the single authoritative source.
//
// This tool touches no tenant data and no database at all, which is why its classification is
// public_product_metadata: a screen name, a canonical route and a list of steps are facts about
// the PRODUCT, not about the organization asking. RLS is therefore not the boundary here — the
// registry's own per-entry role list is, and it can only ever be narrower than the route Guard.
//
// There is no fallback. A question the registry does not answer returns an empty envelope with a
// named failure, so the assistant says "no capability" rather than inventing a plausible-sounding
// instruction. A wrong instruction about the product is indistinguishable from a right one until
// somebody follows it, which is the whole reason #192 exists.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import { PRODUCT_HELP_LOCALES } from "../../../../src/lib/assistant/contracts.ts";
import {
  findProductHelp,
  PRODUCT_HELP_BASE_LOCALE,
  PRODUCT_HELP_MATCH_LIMIT,
  PRODUCT_HELP_REGISTRY_VERSION,
  productHelpPath,
} from "../../../../src/lib/assistant/productHelpRegistry.ts";
import { assistantSourceRouteDecision } from "../../../../src/lib/assistant/routeAccess.ts";
import { routePresentationTitle } from "../../../../src/lib/routePresentation.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { failure, sanitizeText } from "./shared.ts";

const inputSchema = z
  .object({
    question: z.string().trim().max(200).default(""),
    /** An exact registry id, when a previous turn already named one. Never a guess. */
    entry_id: z.string().trim().max(120).default(""),
    locale: z.enum(PRODUCT_HELP_LOCALES).default(PRODUCT_HELP_BASE_LOCALE),
  })
  .strict();

export const NO_REGISTRY_MATCH = {
  code: "product_help_not_registered",
  label: "אין רשומת עזרה מאושרת שעונה על השאלה הזו",
} as const;

export const getProductHelp: AssistantTool = {
  name: "get_product_help",
  description:
    "עזרה על המוצר עצמו — באיזה מסך עושים פעולה ומה הצעדים בו — מתוך רשם העזרה הרשמי של הריפו " +
    "בלבד. מחזיר לכל רשומה מתאימה את נתיב המסך הקנוני ואת הצעדים כפי שנכתבו מהקוד, ורק רשומות " +
    "שהתפקיד הנוכחי מורשה לראות. אין ניחוש ואין נפילה לרשומה קרובה: שאלה שאין לה רשומה מוחזרת " +
    "ככישלון בשם, ואז אין יכולת לענות עליה.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        maxLength: 200,
        description: "שאלת המשתמש על המוצר, כלשונה",
      },
      entry_id: {
        type: "string",
        maxLength: 120,
        description: "מזהה רשומת עזרה מדויק, אם כבר נמסר בתור קודם",
      },
      locale: {
        type: "string",
        enum: [...PRODUCT_HELP_LOCALES],
        description: "שפת הרשומה המבוקשת (ברירת מחדל: עברית)",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  // All three roles may ask; the registry narrows per entry, so an accountant asking a staff-only
  // question gets an honest "not registered for you" rather than a staff instruction.
  requiredRoles: ["owner", "office", "accountant"],
  classification: "public_product_metadata",
  run(ctx: ToolContext, input: unknown) {
    const { question, entry_id, locale } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters = {
      question: sanitizeText(question, 200),
      entry_id: entry_id || null,
      locale,
      registry_version: PRODUCT_HELP_REGISTRY_VERSION,
    };

    const matches = findProductHelp(question, ctx.actor.role, {
      locale,
      ...(entry_id ? { id: entry_id } : {}),
    });
    if (matches.length === 0) {
      return Promise.resolve(
        failure(ctx, NO_REGISTRY_MATCH.code, NO_REGISTRY_MATCH.label, filters),
      );
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const warnings: string[] = [];
    const rows: {
      id: string;
      locale: string;
      version: number;
      label: string;
      path: string;
      steps: readonly string[];
      source: string;
      updated_at: string;
    }[] = [];

    for (const entry of matches) {
      const path = productHelpPath(entry);
      rows.push({
        id: entry.id,
        locale: entry.locale,
        version: entry.version,
        label: entry.label,
        path,
        steps: entry.steps,
        source: entry.source,
        updated_at: entry.updated_at,
      });

      // The entry's anchor fact. Its VALUE is the canonical path, so a claim that names the screen
      // is pinned to a route the product actually has rather than to one the model composed.
      facts.push(ctx.evidence.fact({
        kind: "product_help.entry",
        subject: null,
        label: `רשומת עזרה — ${entry.label}`,
        value: path,
        unit: "text",
        tool: getProductHelp.name,
        as_of: asOf,
        classification: "public_product_metadata",
      }));
      // One fact per step, on the same path. `data` never crosses the provider boundary, so a
      // step that lives only there reaches nobody; issuing each step as evidence is what lets the
      // product RENDER the authoritative wording next to whatever the model says about it. The
      // numbers inside a step ("30 יום", "5 קבלות") stay label text and therefore stay out of the
      // model's numeral vocabulary -- it must describe them in words, while the exact figure is
      // still shown to the person by the product itself.
      entry.steps.forEach((step, index) => {
        facts.push(ctx.evidence.fact({
          kind: "product_help.entry",
          subject: null,
          label: `${index + 1}. ${step}`,
          value: path,
          unit: "text",
          tool: getProductHelp.name,
          as_of: asOf,
          classification: "public_product_metadata",
        }));
      });

      // A source is offered only when routeAccess.ts already allowlists this exact path for an
      // organization-scoped reference AND the current role may open it. Product help does not get
      // to widen that list: an entry whose screen is not allowlisted keeps its steps and loses its
      // link, and the envelope says so out loud instead of quietly dropping it.
      const candidate: SourceReference = {
        id: "candidate",
        entity: "organization",
        entity_id: ctx.actor.orgId,
        label: routePresentationTitle(path) ?? entry.label,
        route: path,
        classification: "public_product_metadata",
      };
      if (assistantSourceRouteDecision(candidate, ctx.actor.role) === "allowed") {
        const { id: _ignored, ...values } = candidate;
        sources.push(ctx.evidence.source(values));
      } else {
        warnings.push(
          `למסך "${entry.label}" אין קישור ישיר בתשובות העוזר; פותחים אותו מתפריט הניווט.`,
        );
      }
    }

    return Promise.resolve({
      data: rows,
      // The registry was consulted in full and answered. Nothing here is a partial measurement:
      // either an entry exists or the call above already returned a named failure.
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: rows.length,
      has_more: !entry_id && matches.length === PRODUCT_HELP_MATCH_LIMIT,
      facts,
      sources,
      warnings,
    });
  },
};
