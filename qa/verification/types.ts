export type VerificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'OBSERVATION';

export interface VerificationCheck {
  id: string;
  status: VerificationStatus;
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface VerificationResult {
  verifier: string;
  status: VerificationStatus;
  summary: string;
  checks: VerificationCheck[];
  evidence: Record<string, unknown>;
}

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|service.?role|api.?key|private.?key|account.?number|bank.?account|iban)/i;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_LIKE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const LONG_KEY_LIKE = /\b(?:sb_[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{48,})\b/g;

function sanitizeString(value: string): string {
  return value
    .replace(JWT_LIKE, '[REDACTED_JWT]')
    .replace(BEARER_LIKE, 'Bearer [REDACTED]')
    .replace(LONG_KEY_LIKE, '[REDACTED_KEY]');
}

function sanitizeUnknown(value: unknown, depth: number): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === undefined) return undefined;
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeUnknown(item, depth + 1));
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const safeChild = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeUnknown(child, depth + 1);
      if (safeChild !== undefined) sanitized[key] = safeChild;
    }
    return sanitized;
  }
  return String(value);
}

export function sanitizeEvidence(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeUnknown(input, 0) as Record<string, unknown>;
}

export function combineVerificationStatus(checks: readonly VerificationCheck[]): VerificationStatus {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'OBSERVATION')) return 'OBSERVATION';
  return 'PASS';
}

export function createVerificationResult(
  verifier: string,
  summary: string,
  checks: VerificationCheck[],
  evidence: Record<string, unknown> = {},
): VerificationResult {
  const safeChecks = checks.map((check) => ({
    ...check,
    evidence: check.evidence ? sanitizeEvidence(check.evidence) : undefined,
  }));
  return {
    verifier,
    status: combineVerificationStatus(safeChecks),
    summary,
    checks: safeChecks,
    evidence: sanitizeEvidence(evidence),
  };
}
