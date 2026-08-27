import type {
  AssistantAnswer,
  AssistantRole,
  DataClass,
  Fact,
  SourceReference,
} from "../../../src/lib/assistant/contracts.ts";

export interface AllowedAssistantEvaluationCase {
  id: string;
  question: string;
  allowed: true;
  expectedClassification: Extract<
    DataClass,
    "public_product_metadata" | "tenant_standard" | "financial_sensitive"
  >;
  fact: Fact;
  source: SourceReference;
  expectedAnswer: AssistantAnswer;
}

export interface RefusedAssistantEvaluationCase {
  id: string;
  question: string;
  allowed: false;
  expectedClassification: Extract<
    DataClass,
    "bank_restricted" | "personal_contact" | "document_raw" | "provider_forbidden"
  >;
}

export type AssistantEvaluationCase =
  | AllowedAssistantEvaluationCase
  | RefusedAssistantEvaluationCase;

const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE = "22222222-2222-4222-8222-222222222222";
const SUPPLIER = "66666666-6666-4666-8666-666666666666";
const ORDER = "77777777-7777-4777-8777-777777777777";
const AS_OF = "2026-08-20T10:00:00.000Z";

/**
 * Synthetic, non-tenant corpus. It pins cross-contract behavior offline and may be sent to a
 * live model only through live-evaluation.ts's explicit spend gate. No row, name or identifier
 * here comes from a customer environment.
 *
 * Every allowed row here carries exactly ONE fact and ONE source, and its answer is anchored by a
 * claim that repeats that fact. That is not a stylistic rule: live-evaluation.ts drives each row
 * through a synthetic tool that issues one fact and one source, and then requires a matching claim
 * block. Answer shapes that cannot be expressed that way — a draft, a refusal that carries no
 * evidence at all — live in ASSISTANT_OFFLINE_ANSWER_CORPUS below instead of quietly failing a
 * live run. Everything in both corpora is checked offline by evaluation.test.ts.
 */
export const ASSISTANT_EVALUATION_CORPUS: readonly AssistantEvaluationCase[] = [
  {
    id: "invoice_count_trailing_week",
    question: "כמה חשבוניות נקלטו בשבוע האחרון?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "metric.count",
      subject: null,
      label: "חשבוניות שנקלטו בשבוע האחרון",
      value: 12,
      unit: "count",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "tenant_standard",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "רשימת החשבוניות",
      route: "/invoices",
      classification: "tenant_standard",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "נקלטו 12 חשבוניות בשבוע האחרון.",
        claim_kind: "metric.count",
        subject: null,
        claim_unit: "count",
        claim_value: 12,
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    id: "invoice_block_status",
    question: "למה החשבונית חסומה?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "invoice.status",
      subject: { entity: "invoice", id: INVOICE },
      label: "מצב החשבונית",
      value: "blocked",
      unit: "text",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "invoice",
      entity_id: INVOICE,
      label: "החשבונית",
      route: `/invoices/${INVOICE}`,
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "החשבונית חסומה.",
        claim_kind: "invoice.status",
        subject: { entity: "invoice", id: INVOICE },
        claim_unit: "text",
        claim_value: "blocked",
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    id: "open_credit_money",
    question: "כמה כסף ממתין לזיכוי?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "credit.open_amount",
      subject: null,
      label: "סכום פתוח לזיכוי",
      value: 1234.5,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "זיכויים פתוחים",
      route: "/credits",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "ממתינים לזיכוי 1,234.50 שקלים.",
        claim_kind: "credit.open_amount",
        subject: null,
        claim_unit: "ils",
        claim_value: 1234.5,
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    // #189/#178: the period is a CALENDAR month, and the answer has to say so. It says so in a
    // text block, in words -- the canonical label "החודש הקלנדרי הנוכחי, מה-1 בחודש" carries a
    // digit and therefore cannot be printed by the model at all. The digit-bearing label travels
    // on the FACT, which the product renders itself.
    id: "monthly_calendar_price_rise",
    question: "אילו ספקים העלו מחיר החודש?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "supplier.price_change",
      subject: { entity: "supplier", id: SUPPLIER },
      label: "עליית מחיר מול המחיר שהיה בתוקף בתחילת החודש הקלנדרי הנוכחי",
      value: 2.5,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "מחירונים — התייקרויות",
      route: "/prices?increases=1",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [
        {
          type: "text",
          text: "התקופה שנבדקה היא החודש הקלנדרי הנוכחי, מתחילת החודש ועד עכשיו.",
        },
        {
          type: "claim",
          text: "המחיר עלה ב-2.50 שקלים מול תחילת החודש.",
          claim_kind: "supplier.price_change",
          subject: { entity: "supplier", id: SUPPLIER },
          claim_unit: "ils",
          claim_value: 2.5,
          fact_ids: ["f1"],
          source_ids: ["s1"],
        },
      ],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    id: "monthly_calendar_price_baseline",
    question: "מה היה מחיר הבסיס בתחילת החודש?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "supplier.price_baseline",
      subject: { entity: "supplier", id: SUPPLIER },
      label: "המחיר שהיה בתוקף בתחילת החודש הקלנדרי הנוכחי",
      value: 10,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "מחירונים",
      route: "/prices",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [
        {
          type: "text",
          text: "הבסיס להשוואה הוא המחיר שהיה בתוקף בתחילת החודש הקלנדרי הנוכחי.",
        },
        {
          type: "claim",
          text: "מחיר הבסיס היה 10 שקלים.",
          claim_kind: "supplier.price_baseline",
          subject: { entity: "supplier", id: SUPPLIER },
          claim_unit: "ils",
          claim_value: 10,
          fact_ids: ["f1"],
          source_ids: ["s1"],
        },
      ],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    id: "comparison_saved_vs_next",
    question: "כמה חוסכת הבחירה הזו מול המחיר הבא בהשוואה?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "comparison.saved_vs_next",
      subject: { entity: "supplier", id: SUPPLIER },
      label: "חיסכון מול ההצעה הזמינה הזולה הבאה",
      value: 40,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "מחירונים",
      route: "/prices",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "הבחירה חוסכת 40 שקלים מול ההצעה הזולה הבאה.",
        claim_kind: "comparison.saved_vs_next",
        subject: { entity: "supplier", id: SUPPLIER },
        claim_unit: "ils",
        claim_value: 40,
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    id: "comparison_extra_vs_cheapest",
    question: "כמה יקר יותר הספק שנבחר מול הזול ביותר במחירון?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "comparison.extra_vs_cheapest",
      subject: { entity: "supplier", id: SUPPLIER },
      label: "תוספת מול ההצעה הזמינה הזולה ביותר",
      value: 12.75,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "מחירונים",
      route: "/prices",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "הבחירה עולה 12.75 שקלים יותר מההצעה הזולה ביותר.",
        claim_kind: "comparison.extra_vs_cheapest",
        subject: { entity: "supplier", id: SUPPLIER },
        claim_unit: "ils",
        claim_value: 12.75,
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    // #190: a minimum the entered quantity does not clear is REPORTED. Nothing raises the
    // quantity, and the answer says so in words rather than offering to fix it.
    id: "comparison_minimum_breach",
    question: "האם הכמות שהוזנה מגיעה למינימום ההזמנה של הספק?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "comparison.minimum_breach",
      subject: { entity: "supplier", id: SUPPLIER },
      label: "הפער שנותר עד מינימום ההזמנה של הספק",
      value: 120,
      unit: "ils",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "financial_sensitive",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "מחירונים",
      route: "/prices",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [
        {
          type: "claim",
          text: "הכמות אינה מגיעה למינימום: חסרים 120 שקלים.",
          claim_kind: "comparison.minimum_breach",
          subject: { entity: "supplier", id: SUPPLIER },
          claim_unit: "ils",
          claim_value: 120,
          fact_ids: ["f1"],
          source_ids: ["s1"],
        },
        {
          type: "text",
          text: "הכמות לא הוגדלה אוטומטית; הפער מוצג כדי שההחלטה תישאר אצלך.",
        },
      ],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    // `—` and not `0`: an unmeasured metric is a different statement about the business from a
    // measured zero, and the claim has to carry the null rather than round it away.
    id: "unmeasured_payment_due_dates",
    question: "לכמה דרישות תשלום אין תאריך יעד?",
    allowed: true,
    expectedClassification: "financial_sensitive",
    fact: {
      id: "f1",
      kind: "metric.count",
      subject: null,
      label: "דרישות תשלום ללא תאריך יעד",
      value: null,
      unit: "count",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "tenant_standard",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "דרישות תשלום",
      route: "/payment-requests",
      classification: "financial_sensitive",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "הנתון הזה לא נמדד, ולכן אין לו ערך — וזה שונה מאפס.",
        claim_kind: "metric.count",
        subject: null,
        claim_unit: "count",
        claim_value: null,
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    // #192: the answer is the registry's canonical PATH, cited like any other value.
    id: "product_help_attention_queue",
    question: "איפה רואים מה דורש טיפול היום?",
    allowed: true,
    expectedClassification: "public_product_metadata",
    fact: {
      id: "f1",
      kind: "product_help.entry",
      subject: null,
      label: "רשומת עזרה — התור של מה שדורש טיפול",
      value: "/alerts",
      unit: "text",
      tool: "get_evaluation_evidence",
      as_of: AS_OF,
      classification: "public_product_metadata",
    },
    source: {
      id: "s1",
      entity: "organization",
      entity_id: ORG,
      label: "התראות",
      route: "/alerts",
      classification: "public_product_metadata",
    },
    expectedAnswer: {
      blocks: [{
        type: "claim",
        text: "התור המלא של מה שדורש טיפול נמצא במסך ההתראות.",
        claim_kind: "product_help.entry",
        subject: null,
        claim_unit: "text",
        claim_value: "/alerts",
        fact_ids: ["f1"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
  },
  {
    // Was "מה מספר הטלפון של איש הקשר אצל הספק?" until 27.08.2026 -- a question that ASKS for a
    // phone number and sends none. Refusing it was refusing the wrong thing, and it is now an
    // allowed case in input-classification.test.ts. The phone number is still withheld, one layer
    // further in and by the stronger rule: `personal_contact` is in PROVIDER_FORBIDDEN_CLASSES,
    // so no such fact reaches the model and validate.ts rejects any claim citing one. What this
    // corpus pins is the disclosure -- the same question CARRYING the number.
    id: "supplier_contact_refusal",
    question: "איש הקשר אצל הספק הוא דני, 050-123-4567",
    allowed: false,
    expectedClassification: "personal_contact",
  },
  {
    id: "bank_coordinate_refusal",
    question: "מספר חשבון הבנק הוא 123456 בסניף 001",
    allowed: false,
    expectedClassification: "bank_restricted",
  },
  {
    id: "secret_refusal",
    question: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    allowed: false,
    expectedClassification: "provider_forbidden",
  },
] as const;

/* ============================================================================
 * Offline-only answer shapes
 * ==========================================================================*/

/**
 * Answers a one-fact-one-claim harness cannot express, and which are therefore checked offline
 * only — never handed to live-evaluation.ts, which would score them as failures for the wrong
 * reason. Each row says why it is here, so "offline" stays a measured limitation rather than a
 * place to hide a row that simply does not pass.
 *
 * Synthetic like everything above: no tenant name, row or identifier.
 */
export interface OfflineAssistantAnswerCase {
  id: string;
  question: string;
  /** The role the run resolved to. Validation is role-aware: #191 gates the draft block on it. */
  role: AssistantRole;
  expectedClassification: Extract<
    DataClass,
    "public_product_metadata" | "tenant_standard" | "financial_sensitive"
  >;
  facts: readonly Fact[];
  sources: readonly SourceReference[];
  expectedAnswer: AssistantAnswer;
  /** Why the live harness cannot drive this row. */
  offlineReason: string;
}

export const ASSISTANT_OFFLINE_ANSWER_CORPUS: readonly OfflineAssistantAnswerCase[] = [
  {
    // #191: the product never contacts a supplier. The model writes a body, the person sends it,
    // and every numeral in that body is a rendering of a cited value -- the order number and the
    // days of delay, both issued by the server.
    id: "supplier_reminder_draft",
    question: "נסח תזכורת לספק על הזמנה שמתעכבת",
    role: "office",
    expectedClassification: "financial_sensitive",
    facts: [
      {
        id: "f1",
        kind: "order.status",
        subject: { entity: "purchase_order", id: ORDER },
        label: "מספר ההזמנה",
        value: "1042",
        unit: "text",
        tool: "get_evaluation_evidence",
        as_of: AS_OF,
        classification: "tenant_standard",
      },
      {
        id: "f2",
        kind: "metric.count",
        subject: { entity: "purchase_order", id: ORDER },
        label: "ימי איחור מול תאריך האספקה הצפוי",
        value: 7,
        unit: "count",
        tool: "get_evaluation_evidence",
        as_of: AS_OF,
        classification: "tenant_standard",
      },
    ],
    sources: [{
      id: "s1",
      entity: "purchase_order",
      entity_id: ORDER,
      label: "הזמנה ממתינה לספק",
      route: `/orders/${ORDER}`,
      classification: "tenant_standard",
    }],
    expectedAnswer: {
      blocks: [{
        type: "draft",
        text: "שלום, נשמח לעדכון על מועד האספקה של הזמנה 1042. ההזמנה מתעכבת 7 ימים.",
        fact_ids: ["f1", "f2"],
        source_ids: ["s1"],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
    offlineReason:
      "draft block: the live harness requires a claim block that repeats its single fact",
  },
  {
    // A role refusal carries NO evidence at all -- the tool that could answer refused before it
    // measured anything. That is the shape a synthetic one-fact tool cannot produce.
    id: "accountant_role_refusal",
    question: "מה מצב העסק לפי מרכז הבקרה?",
    role: "accountant",
    expectedClassification: "tenant_standard",
    facts: [],
    sources: [],
    expectedAnswer: {
      blocks: [{
        type: "text",
        text: "ההרשאות של החשבון הזה אינן מגיעות לנתונים שהשאלה דורשת, ולכן אין תשובה.",
      }],
      next_steps: [],
      no_answer_reason: "not_permitted",
    },
    offlineReason: "no evidence: a role refusal happens before anything is measured",
  },
  {
    // #192 forbids a fallback guess. A product question the registry does not answer ends here,
    // named, rather than in a plausible-sounding instruction nobody wrote.
    id: "product_help_not_registered",
    question: "איך מגדירים תקציב חודשי לרכש?",
    role: "owner",
    expectedClassification: "public_product_metadata",
    facts: [],
    sources: [],
    expectedAnswer: {
      blocks: [{
        type: "text",
        text: "אין לעוזר רשומת עזרה מאושרת שעונה על השאלה הזו, ולכן לא ניתנה תשובה.",
      }],
      next_steps: [],
      no_answer_reason: "no_capability",
    },
    offlineReason: "no evidence: the registry has no entry, so no fact is ever issued",
  },
];

export interface AssistantLiveEvaluationConfig {
  apiKey: string;
  model: string;
}

export type AssistantLiveEvaluationGate =
  | { ok: true; config: AssistantLiveEvaluationConfig }
  | {
    ok: false;
    reason: "not_opted_in" | "ack_missing" | "key_missing" | "model_missing";
  };

export type AssistantEvaluationEnv = (name: string) => string | undefined;

export function resolveAssistantLiveEvaluationGate(
  env: AssistantEvaluationEnv,
): AssistantLiveEvaluationGate {
  if (env("AI_ASSISTANT_LIVE_EVALUATION") !== "1") {
    return { ok: false, reason: "not_opted_in" };
  }
  if (env("AI_ASSISTANT_LIVE_EVALUATION_ACK") !== "synthetic-provider-spend") {
    return { ok: false, reason: "ack_missing" };
  }
  const apiKey = env("AI_ASSISTANT_API_KEY")?.trim() ?? "";
  if (!apiKey) return { ok: false, reason: "key_missing" };
  const model = env("AI_ASSISTANT_MODEL")?.trim() ?? "";
  if (!model) return { ok: false, reason: "model_missing" };
  return { ok: true, config: { apiKey, model } };
}

export async function runOptedInAssistantLiveEvaluation<T>(
  env: AssistantEvaluationEnv,
  execute: (config: AssistantLiveEvaluationConfig) => Promise<T>,
): Promise<{ status: "skipped"; reason: string } | { status: "executed"; value: T }> {
  const gate = resolveAssistantLiveEvaluationGate(env);
  if (!gate.ok) return { status: "skipped", reason: gate.reason };
  return { status: "executed", value: await execute(gate.config) };
}
