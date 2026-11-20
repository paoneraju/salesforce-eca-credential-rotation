/**
 * Best-effort secret redaction. This is a defense-in-depth measure, not a substitute
 * for never logging response bodies that can contain credentials.
 */

const SENSITIVE_KEY = /(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|consumer[_-]?secret|sfdxauthurl|authorization|password|secret)/i;

const AUTH_SCHEME_PATTERN =
  /(authorization\s*["']?\s*[:=]\s*["']?(?:Bearer|Basic|Digest|Token)\s+)([^\s"',;}]+)/gi;
const BEARER_PATTERN = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

const KEY_VALUE_PATTERNS: RegExp[] = [
  /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|consumer[_-]?secret|secret|password|authorization|sfdxAuthUrl)\s*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Digest|Token)\b)([^\s"',;}]+)/gi
];

const TOKEN_PATTERNS: RegExp[] = [
  // Salesforce access tokens look like 00D...!AQ...
  /\b00D[A-Za-z0-9]{12,}(?:![A-Za-z0-9._~+/=-]{8,})?/g,
  // SFDX auth URLs embed a refresh token.
  /force:\/\/[^\s"']+/g,
  // Long opaque values often used for secrets.
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g
];

export function redact(value: string): string {
  if (!value) {
    return value;
  }
  let output = value;
  output = output.replace(AUTH_SCHEME_PATTERN, "$1[REDACTED]");
  output = output.replace(BEARER_PATTERN, "$1[REDACTED]");
  for (const pattern of KEY_VALUE_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string, _secret: string) => {
      return `${prefix}[REDACTED]`;
    });
  }
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Returns a deep copy with sensitive keys replaced. Arrays and primitives are preserved.
 * Intended for error/context payloads, never for credential objects sent to the UI.
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactObject(entry, depth + 1);
    }
    return output;
  }
  return value;
}
