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
const PHONE = /(?:(?:\+|00)972|0(?:[23489]|5\d))(?:[\s().-]*\d){6,9}/u;
const PERSONAL_CONTACT =
  /(?:אימייל|דוא["״']?ל|טלפון|וואטסאפ|איש(?:ת)?\s+קשר|email|e-?mail|phone|whats?app|contact\s+person)/iu;

const BANK_RESTRICTED =
  /(?:מספר\s*חשבון|פרטי\s*בנק|חשבון\s*בנק|סניף\s*(?:מספר\s*)?\d|כרטיס\s*אשראי|iban|swift|\bbic\b|bank\s*account|routing\s*number|credit\s*card|card\s*(?:number|no\.?))/iu;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/iu;

const PROVIDER_FORBIDDEN =
  /(?:service[_\s-]*role|api[_\s-]*key|authorization\s*:|bearer\s+|access[_\s-]*token|refresh[_\s-]*token|client[_\s-]*secret|\bpassword\b|\bpasswd\b|מפתח\s*(?:api|גישה)|סיסמ[אה]|סוד\s*גישה)/iu;
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
 */
export function classifyAssistantProviderText(
  value: string,
): AssistantProviderTextDecision {
  const text = normalizeForClassification(value);

  if (DATA_URI.test(text) || BASE64_BLOB.test(text) || RAW_DOCUMENT_HINT.test(text)) {
    return refused("document_raw");
  }
  const nonEmptyLines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (nonEmptyLines.length >= 4) return refused("document_raw");

  if (
    PROVIDER_FORBIDDEN.test(text) || JWT.test(text) || SECRET_QUERY.test(text) ||
    KNOWN_SECRET_MATERIAL.test(text)
  ) {
    return refused("provider_forbidden");
  }
  if (BANK_RESTRICTED.test(text) || IBAN.test(text)) {
    return refused("bank_restricted");
  }
  if (EMAIL.test(text) || PHONE.test(text) || PERSONAL_CONTACT.test(text)) {
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
