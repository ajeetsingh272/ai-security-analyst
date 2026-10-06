/**
 * Strips known secret patterns from anything about to be logged (P0-10 AC3).
 *
 * "No secret, credential or raw log payload is ever logged" is a product
 * trust boundary, not a style preference — a security product that leaks
 * the credentials of the systems it is protecting, into its OWN logs, has
 * failed at its one job. This runs on EVERY log call (wired into the
 * logger's serializers in logger.ts), not as an opt-in utility a call site
 * has to remember to use — the whole point is that nobody has to remember.
 *
 * Deliberately pattern-based rather than an allowlist of known field names
 * ("redact anything called `password`"): a field-name allowlist misses a
 * secret sitting in a field called `note` or `description`, or embedded
 * inside a larger string (a connection string, a curl command pasted into
 * an error message). Matching the SHAPE of a secret catches it regardless
 * of where it was hiding.
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

// Order matters only in that a REDACTED marker should never itself trigger a
// later pattern — none of these can match "[REDACTED:...]" text, so order is
// otherwise irrelevant.
const PATTERNS: SecretPattern[] = [
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-secret-key', pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*secret|.*key|.*AKIA|$)/g },
  // JWT: three base64url segments joined by dots. Deliberately requires all
  // three segments to look base64url-ish, so an ordinary three-part version
  // string ("1.2.3") does not false-positive.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g },
  // A PEM private key block, in its entirety.
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g,
  },
  // `"password": "..."`, `password=...`, single- or double-quoted, with or
  // without a colon — covers JSON, query-string-shaped text, and plain
  // key=value logging alike. Named capture keeps the key name visible
  // (useful for debugging "something was redacted here") while dropping the
  // value.
  {
    name: 'key-value-secret',
    pattern:
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^"'\s,}]+)["']?/gi,
  },
];

const REPLACEMENT = '[REDACTED]';

/** Redacts a single string. The exported entry point (`redact`) below
 * applies this recursively through objects/arrays; this is the leaf case. */
function redactString(value: string): string {
  let result = value;
  for (const { pattern } of PATTERNS) {
    result = result.replace(pattern, (match, group1) => {
      // key-value-secret's capture group 1 is the KEY name (password,
      // api_key, ...) — keep it, since knowing WHICH field was redacted is
      // useful for debugging and is not itself sensitive.
      if (group1 && typeof group1 === 'string' && /^[a-z_-]+$/i.test(group1)) {
        return `${group1}: ${REPLACEMENT}`;
      }
      return REPLACEMENT;
    });
  }
  return result;
}

const MAX_DEPTH = 8;

/**
 * Field names redacted WHOLESALE when found as an object key, regardless of
 * what their value looks like. This is a different, complementary check
 * from the string patterns above: `redactString` catches a secret EMBEDDED
 * in free text (a Bearer token sitting inside a header string, a password
 * written into a URL), but has no visibility into a structured object's key
 * names at all — it only ever sees the value `"hunter2hunter2"` in
 * isolation, which matches no pattern on its own. Caught by this file's own
 * test: `{ password: "hunter2hunter2" }` walked through un-redacted the
 * first time, because nothing about that string LOOKS like a secret without
 * knowing the key it came from.
 */
const SENSITIVE_KEYS = /^(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization)$/i;

/**
 * Redacts recursively through an arbitrary log value — strings checked
 * directly, objects and arrays walked. Depth-limited so a pathological
 * circular-looking or deeply nested payload cannot make this recurse
 * forever; anything past MAX_DEPTH is replaced wholesale rather than walked,
 * which is a safe default (over-redacting, never under-redacting).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return typeof value === 'object' && value !== null ? '[REDACTED:max-depth]' : value;

  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? REPLACEMENT : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
