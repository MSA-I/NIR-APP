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
import { readerText } from "../reader-locale.ts";
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
    entry_id: z.string().trim().max(120).nullish().transform((value) => value ?? ""),
    // Not defaulted here any more: `null` used to become Hebrew, which made the reader’s own
    // language reachable only when the model guessed it. The fallback moved into `run`, where
    // the run’s actual locale is known (`OPEN-DECISIONS #283`).
    locale: z.enum(PRODUCT_HELP_LOCALES).nullish(),
  })
  .strict();

export const NO_REGISTRY_MATCH = {
  code: "product_help_not_registered",
  labelKey: "assistantTools.helpNoEntry" as const,
} as const;

/** The canonical screen name for a path, in the reader’s language, or null when unnamed. */
function screenLabel(path: string, locale: Parameters<typeof readerText>[0]): string | null {
  const key = routePresentationTitle(path);
  return key ? readerText(locale, key) : null;
}

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
        type: ["string", "null"],
        maxLength: 120,
        description: "מזהה רשומת עזרה מדויק, אם כבר נמסר בתור קודם",
      },
      locale: {
        anyOf: [
          { type: "string", enum: [...PRODUCT_HELP_LOCALES] },
          { type: "null" },
        ],
        description:
          "שפת הרשומה המבוקשת. יש לבחור את השפה שבה המשתמש כתב את השאלה: " +
          "\"en\" לשאלה באנגלית, \"he\" לשאלה בעברית. null נופל לשפה שבה המשתמש קורא את המערכת.",
      },
    },
    required: ["question", "entry_id", "locale"],
    additionalProperties: false,
  },
  // All three roles may ask; the registry narrows per entry, so an accountant asking a staff-only
  // question gets an honest "not registered for you" rather than a staff instruction.
  requiredRoles: ["owner", "office", "accountant"],
  classification: "public_product_metadata",
  run(ctx: ToolContext, input: unknown) {
    const parsed = inputSchema.parse(input);
    const { question, entry_id } = parsed;
    // The model may still name a language — a Hebrew reader asking in English should get the
    // English steps. What changed is the FALLBACK: silence now means the reader’s own language
    // instead of Hebrew, and the reader’s language is a fact the server holds rather than a
    // guess the model makes.
    const locale = parsed.locale ?? ctx.locale ?? PRODUCT_HELP_BASE_LOCALE;
    const requestAsOf = ctx.now().toISOString();
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
        failure(
          ctx,
          NO_REGISTRY_MATCH.code,
          readerText(ctx.locale, NO_REGISTRY_MATCH.labelKey),
          filters,
        ),
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
      // Registry dates are date-only source metadata. Facts require a datetime with an offset, so
      // normalize the source's own date instead of stamping static guidance with request time.
      const entryAsOf = `${entry.updated_at}T00:00:00Z`;
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
        label: `${readerText(ctx.locale, "assistantTools.helpEntry")} — ${entry.label}`,
        value: path,
        unit: "text",
        tool: getProductHelp.name,
        as_of: entryAsOf,
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
          as_of: entryAsOf,
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
        // `routePresentationTitle` returns a dictionary KEY since the interface was extracted.
        // Handing it straight to a `SourceReference` label put `nav.routeTitle_inventory` in
        // front of a person; it is resolved in their language instead.
        label: screenLabel(path, locale) ?? entry.label,
        route: path,
        classification: "public_product_metadata",
      };
      if (assistantSourceRouteDecision(candidate, ctx.actor.role) === "allowed") {
        const { id: _ignored, ...values } = candidate;
        sources.push(ctx.evidence.source(values));
      } else {
        warnings.push(
          readerText(ctx.locale, "assistantTools.helpNoDirectLink", { screen: entry.label }),
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
      as_of: requestAsOf,
      result_count: rows.length,
      has_more: !entry_id && matches.length === PRODUCT_HELP_MATCH_LIMIT,
      facts,
      sources,
      warnings,
    });
  },
};
