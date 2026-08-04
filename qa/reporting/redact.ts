const replacement = '[REDACTED]';
const sensitiveKey = /password|token|secret|authorization|cookie|api.?key|service.?role|storage.?state|local.?storage/i;

const patterns: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${replacement}`],
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement],
  [/("?(?:access_token|refresh_token|service_role|service_role_key|api_key|apikey|password|cookie|authorization)"?\s*[:=]\s*["']?)[^"'\s,}]+/gi, `$1${replacement}`],
  [/([?&](?:apikey|token|access_token|refresh_token|code)=)[^&\s]+/gi, `$1${replacement}`],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]'],
  [/((?:account|bank account|מספר חשבון|חשבון)\s*[:#-]?\s*)\d{5,}/gi, `$1${replacement}`],
];

export function redactText(value: string): string {
  return patterns.reduce((safe, [pattern, next]) => safe.replace(pattern, next), value);
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const namedSecret = typeof record.name === 'string' && sensitiveKey.test(record.name);
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, sensitiveKey.test(key) || (namedSecret && key === 'value')
        ? replacement
        : redactUnknown(entry)]),
    );
  }
  return value;
}

export function safeJson(value: unknown, space = 2): string {
  return JSON.stringify(redactUnknown(value), null, space);
}
