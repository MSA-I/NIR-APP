import {
  mayReachProvider,
  type DataClass,
} from "../../../src/lib/assistant/contracts.ts";
import { AssistantEdgeError } from "./errors.ts";

export type AssistantProviderInputClass = Extract<
  DataClass,
  | "public_product_metadata"
  | "tenant_standard"
  | "financial_sensitive"
  | "bank_restricted"
  | "personal_contact"
  | "document_raw"
  | "provider_forbidden"
>;

export type AssistantProviderTextDecision =
  | {
    allowed: true;
    classification:
      | "public_product_metadata"
      | "tenant_standard"
      | "financial_sensitive";
  }
  | {
    allowed: false;
    classification:
      | "bank_restricted"
      | "personal_contact"
      | "document_raw"
      | "provider_forbidden";
    reason:
      | "bank_restricted"
      | "personal_contact"
      | "document_raw"
      | "provider_forbidden";
  };

// Invisible bidi/zero-width controls must not turn a blocked token into a different spelling for
// the classifier while leaving it visually unchanged for the human reviewing the question.
const INVISIBLE_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

const EMAIL = /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/iu;

/**
 * A calendar date is not a phone number, and it is the single most ordinary thing to write in a
 * business question. The previous phone pattern read `0(?:[23489]|5\d)` followed by any six
 * loosely separated digits, so "03.08.2026" parsed as an 03 area code plus 08-2026 -- and every
 * date beginning 02/03/04/08/09 refused the whole question as `personal_contact`. Measured in
 * production on 27.08.2026: "מה קרה בתאריך 03.08.2026 בהזמנות?" returned HTTP 400.
 *
 * Dates are therefore masked out BEFORE the phone test rather than being pattern-fought inside
 * it. Two rules, each saying one thing: this is what a date looks like, and this is what a phone
 * number looks like.
 */
const CALENDAR_DATE =
  /(?<![\p{N}])(?:\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})(?![\p{N}])/gu;

/**
 * An Israeli phone number, in the shapes people actually type: a local area or mobile prefix, or
 * the +972/00972 international form, followed by exactly seven subscriber digits with at most one
 * separator between groups. Bounded on both sides so a longer digit run -- an invoice id, a
 * catalogue number -- is not a phone number that happens to start correctly.
 */
const PHONE =
  /(?<![\p{N}])(?:(?:\+|00)972[-.\s]?|0)(?:[23489]|5\d)[-.\s]?\d{3}[-.\s]?\d{4}(?![\p{N}])/u;

/**
 * Naming a subject is not disclosing it.
 *
 * "מה הטלפון של ספק שטראוס?" and "איך אני מוסיף ספק חדש עם פרטי בנק?" send no contact detail and
 * no bank coordinate anywhere -- they ask for one. Refusing them told the owner, in the product's
 * own words, that his legitimate question looked like a leak (27.08.2026: both measured as HTTP
 * 400 in production). The topic words are gone from the refusal set for that reason.
 *
 * What is NOT relaxed is the boundary that actually withholds such a detail. A fact classified
 * `personal_contact` or `bank_restricted` still cannot reach the provider -- `mayReachProvider`
 * decides that on the fact's own classification, and `validate.ts` refuses any answer citing one.
 * This classifier only ever had to catch a value the BROWSER is sending, and now that is all it
 * claims to do.
 */
// Hebrew attaches its definite article to the word, so "מספר החשבון" and "מספר חשבון" are the
// same phrase and a literal pattern for one silently misses the other. Every Hebrew keyword here
// therefore admits the prefix explicitly -- the same trap that let "איש הקשר" walk past the old
// contact rule while "איש קשר" was refused.
const BANK_VALUE =
  /(?:(?:(?:מספר|מס['׳])\s*ה?חשבון|ה?חשבון\s*ה?בנק|ה?כרטיס\s*ה?אשראי|bank\s*account|account\s*(?:number|no\.?)|routing\s*number|credit\s*card|card\s*(?:number|no\.?))[^\p{N}\n]{0,24}\d{4,}|\b(?:swift|bic)\b[^\p{N}\p{L}\n]{0,8}[A-Z]{4}[A-Z0-9]{2,7}\b)/iu;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/iu;

/**
 * `password` and `סיסמה` are ordinary words -- "שכחתי את הסיסמה, איך מאפסים?" is a support
 * question, not a credential. They are refused only next to an actual value. Every other token
 * below stays a bare-mention refusal: `service_role`, `api_key` and `client_secret` are not words
 * that appear in a Hebrew-speaking business owner's question by accident.
 */
const PROVIDER_FORBIDDEN =
  /(?:service[_\s-]*role|api[_\s-]*key|authorization\s*:|bearer\s+|access[_\s-]*token|refresh[_\s-]*token|client[_\s-]*secret|מפתח\s*(?:api|גישה)|סוד\s*גישה)/iu;
const CREDENTIAL_ASSIGNMENT =
  /(?:\bpass(?:word|wd)\b|סיסמ[אה])[^\n]{0,16}?(?:[:=]\s*|(?:^|\s)(?:היא|הוא|is)\s+)\S/iu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const SECRET_QUERY = /[?&](?:token|api_?key|signature|secret)=[^\s&#]{8,}/iu;
const KNOWN_SECRET_MATERIAL = /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|\bsb_secret_[A-Za-z0-9._-]{8,}\b|\bghp_[A-Za-z0-9]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH)\s+)?PRIVATE\s+KEY-----)/iu;

const DATA_URI = /\bdata:[^\s;,]{1,80}(?:;[^\s,]{1,40})*;base64,[A-Za-z0-9+/=]{32,}/iu;
const BASE64_BLOB = /(?:^|\s)[A-Za-z0-9+/]{64,}={0,2}(?:$|\s)/u;
const RAW_DOCUMENT_HINT =
  /(?:\b(?:ocr\s*raw|raw\s*ocr|document\s*raw|raw\s*document)\b|(?:טקסט|תוכן)\s+(?:ה[-־]?)?(?:ocr|מסמך)\s+(?:ה)?(?:מלא|גולמי))/iu;

const FINANCIAL =
  /(?:חשבוני(?:ת|ות)|הזמנ(?:ה|ות)|תשלו(?:ם|מים)|זיכו(?:י|יים)|בנק|יתרה|סכום|מחיר|כסף|חשיפה|חריגה|₪|ש["״']?ח|\bils\b|invoice|order|payment|credit|balance|amount|price|bank)/iu;
const PRODUCT_HELP =
  /(?:איך|איפה|עזרה|הסבר|מסך|נתיב|ניווט|how\s+do|where\s+is|help|screen|navigation)/iu;

function normalizeForClassification(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE_CONTROLS, "");
}

/** The same text with calendar dates blanked, so only phone-shaped digit runs remain. */
function withoutCalendarDates(value: string): string {
  return value.replace(CALENDAR_DATE, " ");
}

function refused(
  classification: "bank_restricted" | "personal_contact" | "document_raw" | "provider_forbidden",
): AssistantProviderTextDecision {
  return { allowed: false, classification, reason: classification };
}

/**
 * Server-owned classification for every free-text item before it can enter provider input.
 *
 * This is intentionally a refusal classifier, not a redactor. Silently deleting a phone, bank
 * coordinate or credential could change the question while making the answer look authoritative.
 * The safe result is no provider call and one bounded product error. Tool projections still carry
 * their own field classifications; this closes the separate browser-authored text boundary.
 *
 * It refuses VALUES, not SUBJECTS (27.08.2026). Asking about a phone, a contact or a bank detail
 * carries none of them; sending one does. The earlier topic-word rules refused nine of fourteen
 * ordinary business questions in a measured sample and three of three when replayed against
 * production, which is how a working assistant came to read as a broken one. Nothing about what
 * may leave InPlace changed: the output boundary is `mayReachProvider` on each fact's own
 * classification, re-checked in validate.ts, and it is untouched.
 */
export function classifyAssistantProviderText(
  value: string,
): AssistantProviderTextDecision {
  const text = normalizeForClassification(value);

  if (DATA_URI.test(text) || BASE64_BLOB.test(text) || RAW_DOCUMENT_HINT.test(text)) {
    return refused("document_raw");
  }
  // A question is capped at ASSISTANT_QUESTION_MAX_CHARS (600) by the request schema before this
  // runs, so "many lines" is the only thing left that distinguishes a paste from a person. Four
  // was a person: someone who puts each thought on its own line was told he had pasted a raw
  // document. Twelve lines inside 600 characters is a paste.
  const nonEmptyLines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (nonEmptyLines.length >= 12) return refused("document_raw");

  if (
    PROVIDER_FORBIDDEN.test(text) || CREDENTIAL_ASSIGNMENT.test(text) || JWT.test(text) ||
    SECRET_QUERY.test(text) || KNOWN_SECRET_MATERIAL.test(text)
  ) {
    return refused("provider_forbidden");
  }
  if (BANK_VALUE.test(text) || IBAN.test(text)) {
    return refused("bank_restricted");
  }
  // Dates are masked for the phone test only. Nothing else reads the masked copy, so a date can
  // never hide a keyword from any other rule.
  if (EMAIL.test(text) || PHONE.test(withoutCalendarDates(text))) {
    return refused("personal_contact");
  }

  const classification: AssistantProviderInputClass = FINANCIAL.test(text)
    ? "financial_sensitive"
    : PRODUCT_HELP.test(text)
    ? "public_product_metadata"
    : "tenant_standard";
  if (!mayReachProvider(classification)) {
    // Closed even if the registry changes and one of today's allowed classes becomes forbidden.
    return refused("provider_forbidden");
  }
  return { allowed: true, classification };
}

export function assertAssistantProviderTextAllowed(value: string): void {
  if (!classifyAssistantProviderText(value).allowed) {
    throw new AssistantEdgeError("assistant_input_restricted");
  }
}
