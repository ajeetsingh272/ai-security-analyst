package sentinelobs

import "regexp"

// Pattern-based rather than a field-name allowlist, for the same reason as
// packages/observability/src/redact.ts: a field-name allowlist misses a
// secret sitting in a field called "note", or embedded inside a larger
// string. Kept pattern-for-pattern identical to the TypeScript side so a
// secret shape caught in one language is caught in the other.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9\-._~+/]+=*`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b`),
	regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----`),
}

// key-value-secret needs its key name kept visible (knowing WHICH field was
// redacted is useful and not itself sensitive), so it's handled separately
// below rather than folded into secretPatterns.
var keyValueSecret = regexp.MustCompile(`(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^"'\s,}]+)["']?`)

const redacted = "[REDACTED]"

// RedactString strips known secret shapes out of a single string. Exported
// so logging.go's slog handler can apply it to a log record's Message field
// directly — mirroring why the TypeScript logger needs pino's
// hooks.logMethod rather than relying on formatters.log alone: a secret
// typed directly into a message string has no structured field to walk
// through the way an attribute does.
func RedactString(s string) string {
	for _, p := range secretPatterns {
		s = p.ReplaceAllString(s, redacted)
	}
	return keyValueSecret.ReplaceAllString(s, "$1: "+redacted)
}

// sensitiveKeys mirrors packages/observability/src/redact.ts's SENSITIVE_KEYS:
// field names redacted wholesale when found as a map/struct key, regardless
// of what their value looks like.
var sensitiveKeys = regexp.MustCompile(`(?i)^(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization)$`)

const maxDepth = 8

// Redact walks an arbitrary value recursively — strings redacted directly,
// maps and slices walked, map keys matching sensitiveKeys redacted
// wholesale. Depth-limited the same way and for the same reason as the
// TypeScript side: a pathological payload must not make this recurse
// forever, and over-redacting past the limit is the safe default.
func Redact(v any, depth int) any {
	if depth >= maxDepth {
		switch v.(type) {
		case map[string]any, []any:
			return "[REDACTED:max-depth]"
		default:
			return v
		}
	}

	switch val := v.(type) {
	case string:
		return RedactString(val)
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = Redact(item, depth+1)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			if sensitiveKeys.MatchString(k) {
				out[k] = redacted
			} else {
				out[k] = Redact(item, depth+1)
			}
		}
		return out
	default:
		return v
	}
}
