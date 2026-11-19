import { readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { normalizeWorkflowName, WORKFLOW_ENV } from "../../workflow.ts";

/**
 * Tags and spend-log metadata on every LiteLLM request, so LiteLLM request logs and Langfuse
 * traces can be split by workflow, repo, and Axon version. Every request a prompt causes shares
 * one Langfuse trace id; without it LiteLLM logs each request as its own trace. Git is read once
 * per session (repo, directory) and in the background when a prompt starts and ends (branch,
 * commit). Git wrappers can add latency, so only a session's first request waits for Git;
 * later requests use the newest finished read.
 *
 * Requests that bypass Pi's header hook (web search, Axon compaction) read the context from
 * REQUEST_CONTEXT_CHANNEL. Keep that contract in sync with web-search.ts and compaction.ts.
 */
export const REQUEST_CONTEXT_CHANNEL = "axon:request-context";
/** Synchronously publishes an async context accessor at session_start, before Git completes. */
export const REQUEST_CONTEXT_READY_CHANNEL = "axon:request-context-ready";

export type CallKind = "main" | "compaction" | "web_search";

export interface RequestContext {
  tags(callKind: CallKind): string;
  metadata(callKind: CallKind): Readonly<Record<string, string>>;
  traceHeaders(): Readonly<Record<string, string>>;
}

interface Session {
  readonly repo?: string | undefined;
  readonly repoDir?: string | undefined;
  readonly piMode?: string | undefined;
}

interface Revision {
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
}

const LITELLM_PROVIDER = "litellm";
const TAGS_HEADER = "x-litellm-tags";
const METADATA_HEADER = "x-litellm-spend-logs-metadata";
const LANGFUSE_TRACE_ID_HEADER = "langfuse_trace_id";
const LANGFUSE_TRACE_NAME_HEADER = "langfuse_trace_name";
const LANGFUSE_TRACE_NAME = "axon-prompt";
const GIT_TIMEOUT_MS = 1000;
const MAX_VALUE_LENGTH = 200;
const CLI_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}$/;
const REPO_PATH = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/;
const SCP_REMOTE = /^(?:[^/@:]+@)?[^/:]+:(?!\/\/)(.+)$/;
const COMMIT = /^[0-9a-f]{4,64}$/;
const TICKET = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![A-Za-z0-9])/;

/** Header values must stay printable ASCII; anything else becomes "_". */
function printable(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/[^\x20-\x7e]/g, "_")
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
  return cleaned || undefined;
}

function urlPath(remote: string): string | undefined {
  try {
    const url = new URL(remote);
    return url.protocol === "file:" ? undefined : url.pathname;
  } catch (error) {
    // A malformed remote URL has no exportable identity; other parsing failures must propagate.
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}

/** `org/repo` from an SSH or HTTPS remote; host and credentials are never kept. */
export function repoFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  // A file: URL also matches SCP syntax; reject it before either parser can export local paths.
  if (/^file:/i.test(trimmed) || /^(?:[A-Za-z]:[\\/]|[/~]|\.\.?[\\/])/.test(trimmed)) {
    return undefined;
  }
  const path = SCP_REMOTE.exec(trimmed)?.[1] ?? urlPath(trimmed);
  const slug = path
    ?.replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  return slug && slug.length <= MAX_VALUE_LENGTH && REPO_PATH.test(slug) ? slug : undefined;
}

/** Only upper-case keys such as `DD-520`, so version-like branch parts (`cli-1`) never match. */
export function ticketFromBranch(branch: string | undefined): string | undefined {
  return branch === undefined ? undefined : TICKET.exec(branch)?.[1];
}

/** Git uses exit 128 for both absence and fatal errors, so establish absence without executing it. */
async function hasRepository(cwd: string): Promise<boolean> {
  if (process.env["GIT_DIR"]) return true;
  let directory = await realpath(cwd);
  for (;;) {
    const entries = await readdir(directory);
    // .git may be a worktree/submodule gitfile. A bare repo has HEAD and objects instead.
    if (entries.includes(".git") || (entries.includes("HEAD") && entries.includes("objects"))) {
      return true;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: readonly string[],
  absentCode?: number,
): Promise<string> {
  const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  if (result.killed || result.truncated || (result.code !== 0 && result.code !== absentCode)) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.code}, killed=${result.killed}, truncated=${result.truncated})`,
    );
  }
  return result.code === 0 ? result.stdout.trim() : "";
}

async function readSession(pi: ExtensionAPI, cwd: string, piMode: string): Promise<Session> {
  if (!(await hasRepository(cwd))) return { piMode };
  const [prefix, remote] = await Promise.all([
    git(pi, cwd, ["rev-parse", "--show-prefix"]),
    // get-url documents exit 2 for a missing remote.
    git(pi, cwd, ["remote", "get-url", "origin"], 2),
  ]);
  return {
    piMode,
    repo: remote ? repoFromRemote(remote) : undefined,
    repoDir: printable(prefix.replace(/\/$/, "") || "."),
  };
}

async function readRevision(pi: ExtensionAPI, cwd: string): Promise<Revision> {
  const [branch, commit] = await Promise.all([
    // Detached HEAD and an unborn HEAD are expected absence, not Git execution failures.
    git(pi, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], 1),
    git(pi, cwd, ["rev-parse", "--verify", "--quiet", "--short", "HEAD"], 1),
  ]);
  return {
    branch: printable(branch),
    commit: commit && COMMIT.test(commit) ? commit : undefined,
  };
}

function definedEntries(fields: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Langfuse requires 32 lowercase hex characters, which a UUID without dashes is. */
function newPromptTraceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function buildRequestContext(
  session: Session,
  revision: Revision,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  promptTraceId: () => string | undefined = () => undefined,
): RequestContext {
  const workflow = normalizeWorkflowName(environment[WORKFLOW_ENV]);
  const rawVersion = environment["PI_AXON_CLI_VERSION"];
  const axonVersion = rawVersion && CLI_VERSION.test(rawVersion) ? rawVersion : undefined;
  const base = definedEntries({
    axon_version: axonVersion,
    pi_version: printable(VERSION),
    axon_workflow: workflow,
    repo: session.repo,
    repo_dir: session.repoDir,
    branch: revision.branch,
    commit: revision.commit,
    ticket: ticketFromBranch(revision.branch),
    pi_mode: session.piMode,
  });
  const baseTags = Object.entries(
    definedEntries({
      axon_workflow: workflow,
      axon_version: axonVersion,
      repo: session.repo,
      pi_mode: session.piMode,
    }),
  ).map(([name, value]) => `${name}:${value}`);
  return Object.freeze({
    tags: (callKind: CallKind) => [...baseTags, `call_kind:${callKind}`].join(","),
    metadata: (callKind: CallKind) => Object.freeze({ ...base, call_kind: callKind }),
    traceHeaders: () => {
      const traceId = promptTraceId();
      return Object.freeze(
        traceId === undefined
          ? {}
          : {
              [LANGFUSE_TRACE_ID_HEADER]: traceId,
              [LANGFUSE_TRACE_NAME_HEADER]: LANGFUSE_TRACE_NAME,
            },
      );
    },
  });
}

export default function requestContext(pi: ExtensionAPI): void {
  let session: Promise<Session> | undefined;
  let piMode = "print";
  let sessionContext: Promise<PromiseSettledResult<RequestContext>> | undefined;
  let latest: PromiseSettledResult<RequestContext> | undefined;
  let started = 0;
  let published = 0;
  let callKind: CallKind = "main";
  let promptTraceId: string | undefined;

  /** Reads can finish out of order; an older read never replaces a newer one. */
  const refresh = (cwd: string): Promise<PromiseSettledResult<RequestContext>> => {
    const generation = ++started;
    session ??= readSession(pi, cwd, piMode);
    const sessionRead = session;
    const read = sessionRead.then(async (resolved) =>
      buildRequestContext(
        resolved,
        resolved.repoDir === undefined ? {} : await readRevision(pi, cwd),
        process.env,
        () => promptTraceId,
      ),
    );
    // This is the background-I/O boundary: retain failures as explicit results, then rethrow
    // at the request boundary below. Never turn an unexpected failure into missing/stale tags.
    return read.then(
      (context) => {
        const result = { status: "fulfilled", value: context } as const;
        if (generation > published) {
          published = generation;
          latest = result;
          pi.events.emit(REQUEST_CONTEXT_CHANNEL, context);
        }
        return result;
      },
      (reason: unknown) => {
        if (session === sessionRead) session = undefined;
        const result = { status: "rejected", reason } as const;
        if (generation > published) {
          published = generation;
          latest = result;
        }
        return result;
      },
    );
  };
  const getContext = async (): Promise<RequestContext> => {
    if (latest === undefined) await sessionContext;
    const result = latest;
    if (result === undefined) throw new Error("Request context has not been initialized");
    if (result.status === "rejected") {
      throw new Error("Could not read Git request context", { cause: result.reason });
    }
    return result.value;
  };
  const resetCallKind = (): void => {
    callKind = "main";
  };

  pi.on("session_start", (_event, ctx) => {
    resetCallKind();
    promptTraceId = undefined;
    latest = undefined;
    published = started;
    session = undefined;
    piMode = ctx.mode;
    sessionContext = refresh(ctx.cwd);
    pi.events.emit(REQUEST_CONTEXT_READY_CHANNEL, getContext);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    resetCallKind();
    promptTraceId = newPromptTraceId();
    void refresh(ctx.cwd);
  });
  pi.on("agent_end", (_event, ctx) => {
    void refresh(ctx.cwd);
  });
  // Pi's own compaction runs through the agent stream, so its requests reach the header hook.
  pi.on("session_before_compact", () => {
    callKind = "compaction";
  });
  pi.on("session_compact", resetCallKind);
  pi.on("session_compact_failed", resetCallKind);
  pi.on("turn_start", resetCallKind);

  pi.on("before_provider_headers", async (event, ctx) => {
    if (ctx.model?.provider !== LITELLM_PROVIDER || sessionContext === undefined) return;
    const context = await getContext();
    const tags = context.tags(callKind);
    const existingTags = event.headers[TAGS_HEADER];
    event.headers[TAGS_HEADER] = existingTags ? `${existingTags},${tags}` : tags;
    event.headers[METADATA_HEADER] ??= JSON.stringify(context.metadata(callKind));
    for (const [name, value] of Object.entries(context.traceHeaders()))
      event.headers[name] ??= value;
  });
}
