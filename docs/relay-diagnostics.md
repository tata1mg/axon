# Local relay diagnostics

Axon writes best-effort JSON Lines diagnostics to `${AXON_HOME}/logs/relay.log`
(default `~/.axon/logs/relay.log`). These are local launcher diagnostics, not an
upload or a transcript log. They apply to newly launched relays; older records
cannot be enriched retroactively.

## What's recorded

Schema version 2 records retain the launch and request IDs, endpoint pathname,
method, failure stage, upstream HTTP status, elapsed time and received bytes.
They also include:

- Error name, message, available stack frames, network fields (`code`, `errno`,
  `syscall`, hostname/address/port), nested causes and aggregate errors. Custom
  error types and codes are retained rather than converted to `unknown`.
- CLI version/commit, Bun version, platform, PID and upstream origin.
- Request attempt, milliseconds to upstream headers and first response chunk,
  milliseconds since the last received chunk, content type and selected upstream
  request/call IDs. Timings are `null` when that phase was not reached.
- Allowlisted response headers: `upstreamServer` (`server`), `cfRay` (`cf-ray`),
  `cfMitigated` (`cf-mitigated`) and `retryAfter` (`retry-after`). These are redacted
  and bounded like the other diagnostic fields; absent headers are `null`.
- Exceptions from the relay handler/server and Pi-defaults refresh, including
  transport failures otherwise swallowed by the optional config fetch.

`status: 200` with `stage: "upstream_stream"` means headers succeeded but the
body subsequently failed. MCP GET disconnects can therefore be distinguished
from model POST failures by method and endpoint.

HTTP 4xx/5xx responses produce an `upstream_response` record immediately. A 401
is recorded before session recovery/verification; it can be followed by a
successful retry. For other HTTP errors, a consumed, complete textual/JSON body
of at most **8 KiB** produces a second `upstream_response_body` record sharing
the request ID. JSON escapes are canonicalized before redaction. Oversized
bodies are omitted entirely, not persisted as raw prefixes. Cancelled,
interrupted, binary and SSE bodies are not captured as error-body text.

HTTP failures without an exception use `errorType: "HTTPError"` and an
`errorCode` such as `HTTP_403`, rather than `unknown`. Cloudflare's explicit
`cf-mitigated: challenge` header on an HTTP error uses `CloudflareError` /
`CLOUDFLARE_CHALLENGE`. An HTML 403 with both `server: cloudflare` and a nonempty
`cf-ray` uses `CloudflareError` / `CLOUDFLARE_HTML_DENIAL`: this is a likely edge
page, not proof of which security rule (or origin) generated it. JSON permission
denials passing through Cloudflare remain ordinary HTTP failures. Actual stream
exceptions retain their original names/codes even after HTTP error headers.

For these Cloudflare error pages, the relay cancels the upstream body without
reading it and returns a short JSON error with the request ID and diagnostic log
label. The HTTP status and `Retry-After` header are preserved. There is no error
body capture for these cancelled pages, login verification/recovery or automatic
relay retry. Use `cfRay` and the UTC timestamp to investigate Cloudflare Security
Events. This change does not modify stream timeouts, reconnect policy or edge
security configuration.

Successful request/response payloads and SSE transcripts are not saved. The relay
does not parse application-level errors inside HTTP-200 SSE events. Deliberate
request cancellation does not generate failure records. Client errors remain
short and generic; detailed exceptions are not sent to Pi's terminal/history.

## Credential protection and limits

User-identifying information, internal hostnames, paths and chat-related text
inside exceptions/error bodies are allowed. **DeputyDev access/session tokens
are not.** The opaque `extension_auth_token` / `encryptedSession` is a bearer
credential even though its name says "encrypted".

The logger tracks credentials it encounters on request, rotation and verification
paths, including the local relay capability. Exact-value redaction covers raw,
JSON-escaped, common URL-encoded and fully Unicode-escaped representations.
Credential-field and Bearer/Basic patterns provide additional protection for
unknown values. Redaction happens before text truncation. Authentication-file
JSON parse errors still deliberately discard the original parser exception,
which could contain unregistered file contents.

No whole request, response, environment or authentication-file objects are
serialized. Exception traversal reads only named fields, never custom JSON
serializers or arbitrary iterators. Auth-verification wrappers preserve sanitized
cause snapshots, so their debug output does not introduce a raw-cause leak.
Redaction is not a general-purpose guarantee against arbitrary transformations,
unknown historical credentials or secrets split/truncated by an upstream system.
Do not deliberately paste credentials into conversations or error text.

To bound memory, the launch-local credential registry retains at most 1 MiB of
representations / 4,096 variants. Old credentials are not evicted while a stream
could still reference them. If the registry fills, subsequent diagnostic text is
omitted (fail closed), not logged with incomplete token protection.

Errors are limited to 8 levels / 32 nodes and 24 Ki characters of text. Truncated
or omitted details are marked explicitly. The relay raises the runtime's stack
capture limit to at least 50 frames; native errors may still supply fewer or no
JavaScript frames. Records are bounded to 64 KiB. Runtime stacks reflect the
running build; release builds already produce external source maps for offline
symbolication.

The log rotates at **1 MiB** and retains one backup (`relay.log.1`). Log files
are owner-only (`0600`), newly created log directories are `0700`, and existing
ownership/symlink protections remain in place. Contended/unwritable logs are
best effort: logging must not replace the original failure or print over Pi.
