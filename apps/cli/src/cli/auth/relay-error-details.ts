/** Local diagnostics retain user/error context, but never intentionally retain credentials. */
const REDACTED = "[REDACTED]";
const MAX_INPUT_CHARACTERS = 1024 * 1024;
const MAX_SECRET_CHARACTERS = 1024 * 1024;
const MAX_SECRETS = 4096;
const MAX_ERROR_NODES = 32;
const MAX_ERROR_DEPTH = 8;
const MAX_ERROR_CHARACTERS = 24 * 1024;

// Supplement exact-value removal for credentials not yet observed by this relay.
const AUTH = /\b(Bearer|Basic)\s+[^\s"'<>`,;)\]}]+/gi;
const SECRET_FIELD =
  /(["']?\b(?:authorization|proxy[-_]authorization|(?:set[-_])?cookie|extension_auth_token|encryptedSession|encrypted[-_]session(?:[-_]data)?|x[-_]encrypted[-_]session[-_]data|x[-_]session[-_]refresh[-_]token|sessionRefreshToken|refreshedSession|new_session_data|access[-_]?token|refresh[-_]?token|api[-_]?key|x[-_]api[-_]key|token|password|secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:Bearer|Basic)\s+[^\s,;)}\]]+|[^\s,;)}\]&#]+)/gi;

export interface RelayRedactor {
  protectSecret(value: string | null | undefined): void;
  text(value: string, limit?: number): string;
}

export function createRelayRedactor(): RelayRedactor {
  const secrets = new Set<string>();
  let secretCharacters = 0;
  let saturated = false;
  let orderedSecrets: string[] = [];
  let dirty = false;
  return {
    protectSecret(value) {
      if (!value || secrets.has(value) || saturated) return;
      // Keep old rotations for late errors from long-lived MCP/model streams. If
      // this bounded launch-local registry fills, omit text rather than evicting
      // a still-sensitive token. It is never serialized or passed to Pi.
      const variants = new Set([
        value,
        JSON.stringify(value).slice(1, -1),
        JSON.stringify(value).slice(1, -1).replace(/\//g, "\\/"),
        Array.from(
          value,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ).join(""),
        encodeURIComponent(value),
        encodeURI(value),
        new URLSearchParams({ v: value }).toString().slice(2),
      ]);
      for (const variant of [...variants]) {
        variants.add(variant.replace(/%[\da-f]{2}/gi, (part) => part.toLowerCase()));
      }
      for (const variant of variants) {
        if (secrets.has(variant)) continue;
        if (
          secrets.size >= MAX_SECRETS ||
          secretCharacters + variant.length > MAX_SECRET_CHARACTERS
        ) {
          saturated = true;
          secrets.clear();
          orderedSecrets = [];
          return;
        }
        secrets.add(variant);
        dirty = true;
        secretCharacters += variant.length;
      }
    },
    text(value, limit = 8192) {
      if (saturated) return "[OMITTED: credential tracking limit]";
      // Never truncate *before* redaction: that could expose half a token.
      if (value.length > MAX_INPUT_CHARACTERS) return "[OMITTED: input size limit]";
      if (dirty) {
        orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
        dirty = false;
      }
      for (const secret of orderedSecrets) {
        value = value.split(secret).join(REDACTED);
      }
      value = value.replace(SECRET_FIELD, (_match, key: string) => `${key}${REDACTED}`);
      value = value.replace(AUTH, (_match, scheme: string) => `${scheme} ${REDACTED}`);
      value = value.replace(/(https?:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`);
      return value.length > limit ? `${value.slice(0, limit)}\n[TRUNCATED]` : value;
    },
  };
}

export interface RelayErrorDetails {
  name?: string;
  message?: string;
  stack?: string;
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: string | number;
  cause?: RelayErrorDetails;
  errors?: RelayErrorDetails[];
  omitted?: string;
}

/** Read only named fields; never invoke toJSON, custom inspectors or arbitrary iterators. */
function field(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return "[UNAVAILABLE: property getter threw]";
  }
}

export function relayErrorDetails(
  error: unknown,
  redactor: RelayRedactor,
): {
  errorType: string;
  errorCode: string | number;
  error?: RelayErrorDetails;
} {
  let nodes = 0;
  let characters = MAX_ERROR_CHARACTERS;
  const seen = new Set<object>();
  let errorCode: string | number = "unknown";
  const text = (value: string, limit = 8192) => {
    const result = redactor.text(value, Math.max(0, Math.min(limit, characters)));
    characters = Math.max(0, characters - result.length);
    return result;
  };
  const visit = (value: unknown, depth: number): RelayErrorDetails => {
    if (depth >= MAX_ERROR_DEPTH || nodes++ >= MAX_ERROR_NODES || characters <= 0) {
      return { omitted: "error detail limit" };
    }
    if (value === null || typeof value !== "object") {
      return {
        message:
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? text(String(value))
            : `[${typeof value}]`,
      };
    }
    if (seen.has(value)) return { omitted: "circular or repeated error" };
    seen.add(value);
    const result: RelayErrorDetails = {};
    for (const key of [
      "name",
      "message",
      "stack",
      "code",
      "errno",
      "syscall",
      "hostname",
      "address",
      "port",
    ] as const) {
      const entry = field(value, key);
      if (typeof entry === "string") {
        Object.assign(result, {
          [key]: text(entry, key === "stack" ? MAX_ERROR_CHARACTERS : 8192),
        });
      } else if (
        (key === "code" || key === "errno" || key === "port") &&
        typeof entry === "number" &&
        Number.isFinite(entry)
      ) {
        const safe = text(String(entry));
        Object.assign(result, { [key]: safe === String(entry) ? entry : safe });
      }
    }
    if (errorCode === "unknown" && result.code !== undefined) errorCode = result.code;
    const cause = field(value, "cause");
    if (cause !== undefined) result.cause = visit(cause, depth + 1);
    const errors = field(value, "errors");
    // Array.isArray can itself throw for a revoked Proxy.
    try {
      if (Array.isArray(errors)) {
        result.errors = [];
        const length = field(errors, "length");
        if (typeof length === "number") {
          for (let index = 0; index < Math.min(length, MAX_ERROR_NODES); index++) {
            result.errors.push(visit(field(errors, String(index)), depth + 1));
            if (nodes >= MAX_ERROR_NODES) break;
          }
          if (length > result.errors.length)
            result.errors.push({ omitted: "aggregate error limit" });
        }
      }
    } catch {
      result.omitted = "unreadable aggregate errors";
    }
    return result;
  };
  if (error === undefined) return { errorType: "unknown", errorCode };
  const details = visit(error, 0);
  return { errorType: details.name ?? "unknown", errorCode, error: details };
}
