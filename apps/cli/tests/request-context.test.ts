import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";

import requestContext, {
  buildRequestContext,
  REQUEST_CONTEXT_CHANNEL,
  type RequestContext,
  repoFromRemote,
  ticketFromBranch,
} from "../src/harnesses/pi/resources/extensions/request-context.ts";
import { normalizeWorkflowName } from "../src/harnesses/pi/telemetry/src/environment.ts";

const environmentKeys = ["AXON_WORKFLOW", "PI_AXON_CLI_VERSION"] as const;
let savedEnvironment: Record<string, string | undefined>;
const directories: string[] = [];

beforeEach(() => {
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env["AXON_WORKFLOW"] = " PR-Review ";
  process.env["PI_AXON_CLI_VERSION"] = "1.0.4";
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Repository {
  inRepo: boolean;
  branch: string | undefined;
  commit: string;
  remote: string;
}

function setup(repository: Partial<Repository> = {}, execute?: ExtensionAPI["exec"]) {
  const repo: Repository = {
    inRepo: true,
    branch: "feat/DD-520-price-sync",
    commit: "a1b2c3d",
    remote: "git@ssh.bitbucket.org:tata1mg/Catalog-Autopilot-Backend.git",
    ...repository,
  };
  const cwd = mkdtempSync(join(tmpdir(), "axon-request-context-"));
  directories.push(cwd);
  if (repo.inRepo) mkdirSync(join(cwd, ".git"));
  const handlers = new Map<string, Handler[]>();
  const gitCalls: string[] = [];
  const published: unknown[] = [];
  let onPublished: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const failures = new Map<string, Error | Partial<Awaited<ReturnType<ExtensionAPI["exec"]>>>>();
  const answer = (args: readonly string[]): string | undefined => {
    if (!repo.inRepo) return undefined;
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --show-prefix") return "services/pricing/\n";
    if (command === "remote get-url origin") return `${repo.remote}\n`;
    if (command === "symbolic-ref --quiet --short HEAD") return repo.branch && `${repo.branch}\n`;
    if (command === "rev-parse --verify --quiet --short HEAD")
      return repo.commit && `${repo.commit}\n`;
    return undefined;
  };
  requestContext({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    async exec(_command: string, args: string[]) {
      gitCalls.push(args.slice(2).join(" "));
      const command = args.slice(2).join(" ");
      const stdout = answer(args);
      const failure = failures.get(command);
      const heldBy = gate;
      if (heldBy) await heldBy;
      if (failure instanceof Error) throw failure;
      return {
        stdout: stdout ?? "",
        stderr: "",
        code: stdout ? 0 : command === "remote get-url origin" ? 2 : 1,
        killed: false,
        truncated: false,
        ...failure,
      };
    },
    ...(execute === undefined ? {} : { exec: execute }),
    events: {
      emit(channel: string, data: unknown) {
        if (channel === REQUEST_CONTEXT_CHANNEL) {
          published.push(data);
          onPublished?.();
          onPublished = undefined;
        }
      },
      on: () => () => {},
    },
  } as unknown as ExtensionAPI);

  const context = (provider: string) =>
    ({
      cwd,
      mode: "print",
      model: { provider },
    }) as unknown as ExtensionContext;
  const fire = async (name: string, event: unknown = {}, provider = "litellm") => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context(provider));
  };
  const request = async (provider = "litellm", headers: Record<string, string> = {}) => {
    const event = { type: "before_provider_headers", headers: { ...headers } };
    await fire("before_provider_headers", event, provider);
    return event.headers;
  };
  const metadata = (headers: Record<string, string>) =>
    JSON.parse(headers["x-litellm-spend-logs-metadata"] as string) as Record<string, string>;
  /** Git calls started from now on answer with the repository as it is now, but only once resumed. */
  const holdGit = (): (() => void) => {
    const held = Promise.withResolvers<void>();
    gate = held.promise;
    return held.resolve;
  };
  const branchSent = async () => metadata(await request())?.["branch"];
  return {
    cwd,
    repo,
    gitCalls,
    published,
    failures,
    fire,
    request,
    metadata,
    holdGit,
    branchSent,
    nextPublished: () =>
      new Promise<void>((resolve) => {
        onPublished = resolve;
      }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test.each([
  undefined,
  "",
  " PR-Review ",
  "nightly.dependency_bump-v2",
  "a".repeat(64),
  "a".repeat(65),
  "pr review",
  "team/pr-review",
  "-leading-dash",
  ".hidden",
  "pr\nreview",
  "émoji",
])("request workflow %j uses the same normalizer as Grafana telemetry", (workflow) => {
  const context = buildRequestContext({}, {}, { AXON_WORKFLOW: workflow });
  expect(context.metadata("main")["axon_workflow"]).toBe(normalizeWorkflowName(workflow));
});

test("tags and spend-log metadata describe the session on LiteLLM requests", async () => {
  const fixture = setup();
  await fixture.fire("session_start", { reason: "startup" });
  const headers = await fixture.request();

  expect(headers["x-litellm-tags"]).toBe(
    "axon_workflow:pr-review,axon_version:1.0.4,repo:tata1mg/catalog-autopilot-backend,pi_mode:print,call_kind:main",
  );
  expect(fixture.metadata(headers)).toEqual({
    axon_version: "1.0.4",
    pi_version: VERSION,
    axon_workflow: "pr-review",
    repo: "tata1mg/catalog-autopilot-backend",
    repo_dir: "services/pricing",
    branch: "feat/DD-520-price-sync",
    commit: "a1b2c3d",
    ticket: "DD-520",
    pi_mode: "print",
    call_kind: "main",
  });
});

test("requests to other providers never receive repository context", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  expect(await fixture.request("anthropic")).toEqual({});
});

test("requests never run git, and a prompt's read is used once it finishes", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  await fixture.request();
  const callsAfterStartup = fixture.gitCalls.length;

  fixture.repo.branch = "feat/DD-777-next";
  fixture.repo.commit = "e5f6a7b";
  await fixture.request();
  expect(await fixture.branchSent()).toBe("feat/DD-520-price-sync");
  expect(fixture.gitCalls).toHaveLength(callsAfterStartup);

  await fixture.fire("before_agent_start");
  await settle();
  const nextPrompt = fixture.metadata(await fixture.request());
  expect(nextPrompt?.["branch"]).toBe("feat/DD-777-next");
  expect(nextPrompt?.["commit"]).toBe("e5f6a7b");
  expect(nextPrompt?.["ticket"]).toBe("DD-777");
});

test("a slow git read never delays a request, and a late older read never wins", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  await fixture.request();

  fixture.repo.branch = "feat/older";
  const resumeOlder = fixture.holdGit();
  await fixture.fire("before_agent_start");
  expect(await fixture.branchSent()).toBe("feat/DD-520-price-sync");

  fixture.repo.branch = "feat/newer";
  const resumeNewer = fixture.holdGit();
  await fixture.fire("agent_end");
  resumeNewer();
  await settle();
  resumeOlder();
  await settle();
  expect(await fixture.branchSent()).toBe("feat/newer");
});

test("a branch the agent switches to during a prompt is sent from the next prompt", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  await fixture.request();

  fixture.repo.branch = "feat/agent-made";
  await fixture.fire("agent_end");
  await settle();
  expect(await fixture.branchSent()).toBe("feat/agent-made");
});

test("outside a repository only the launch context is sent and prompts run no git", async () => {
  const fixture = setup({ inRepo: false });
  await fixture.fire("session_start");
  await fixture.request();
  const callsAfterStartup = fixture.gitCalls.length;
  expect(callsAfterStartup).toBe(0);
  await fixture.fire("before_agent_start");
  await fixture.fire("agent_end");
  await settle();
  const headers = await fixture.request();

  expect(headers["x-litellm-tags"]).toBe(
    "axon_workflow:pr-review,axon_version:1.0.4,pi_mode:print,call_kind:main",
  );
  expect(fixture.metadata(headers)).toEqual({
    axon_version: "1.0.4",
    pi_version: VERSION,
    axon_workflow: "pr-review",
    pi_mode: "print",
    call_kind: "main",
  });
  expect(fixture.gitCalls).toHaveLength(callsAfterStartup);
});

test.each([
  new Error("git execution failed"),
  { code: 128 },
  { code: 1 },
  { code: 0, killed: true },
  { code: 0, truncated: true },
])(
  "unexpected initial Git failure is surfaced and a later prompt can recover: %j",
  async (failure) => {
    const fixture = setup();
    fixture.failures.set("rev-parse --show-prefix", failure);
    await fixture.fire("session_start");
    await expect(fixture.request()).rejects.toThrow("Could not read Git request context");
    expect(fixture.published).toHaveLength(0);
    const callsAfterFailure = fixture.gitCalls.length;

    fixture.failures.clear();
    const recovered = fixture.nextPublished();
    await fixture.fire("before_agent_start");
    await recovered;
    expect(fixture.gitCalls.length).toBeGreaterThan(callsAfterFailure);
    expect(await fixture.branchSent()).toBe("feat/DD-520-price-sync");
  },
);

test("background Git failures are surfaced instead of sending stale context, then recover", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  await fixture.request();
  fixture.failures.set("symbolic-ref --quiet --short HEAD", { code: 128 });
  await fixture.fire("agent_end");
  await settle();
  await expect(fixture.request()).rejects.toThrow("Could not read Git request context");

  fixture.failures.clear();
  fixture.repo.branch = "feat/recovered";
  const recovered = fixture.nextPublished();
  await fixture.fire("before_agent_start");
  await recovered;
  expect(await fixture.branchSent()).toBe("feat/recovered");
});

test.each([
  ["remote get-url origin", 128],
  ["symbolic-ref --quiet --short HEAD", 2],
  ["rev-parse --verify --quiet --short HEAD", 128],
])("unexpected exit from %s is not absence", async (command, code) => {
  const fixture = setup();
  fixture.failures.set(command, { code });
  await fixture.fire("session_start");
  await expect(fixture.request()).rejects.toThrow("Could not read Git request context");
});

test("missing origin and unborn HEAD omit only unavailable metadata", async () => {
  const fixture = setup({ remote: "", commit: "", branch: "main" });
  await fixture.fire("session_start");
  const metadata = fixture.metadata(await fixture.request());
  expect(metadata?.["repo_dir"]).toBe("services/pricing");
  expect(metadata?.["branch"]).toBe("main");
  expect(metadata?.["repo"]).toBeUndefined();
  expect(metadata?.["commit"]).toBeUndefined();
});

test("detached HEAD omits the branch, not the commit", async () => {
  const fixture = setup({ branch: undefined });
  await fixture.fire("session_start");
  const metadata = fixture.metadata(await fixture.request());
  expect(metadata?.["branch"]).toBeUndefined();
  expect(metadata?.["commit"]).toBe("a1b2c3d");
});

test("real Git distinguishes unborn/detached HEAD and a missing origin from corrupt repository state", async () => {
  const execute: ExtensionAPI["exec"] = async (command, args) => {
    const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, killed: false, truncated: false };
  };
  const fixture = setup({}, execute);
  const git = async (...args: string[]) => {
    const result = await execute("git", ["-C", fixture.cwd, ...args]);
    expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
  };
  await git("init", "--initial-branch=main");
  await fixture.fire("session_start");
  const unborn = fixture.metadata(await fixture.request());
  expect(unborn).toMatchObject({ repo_dir: ".", branch: "main" });
  expect(unborn?.["commit"]).toBeUndefined();
  expect(unborn?.["repo"]).toBeUndefined();

  await git(
    "-c",
    "user.name=Axon",
    "-c",
    "user.email=axon@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  await git("checkout", "--detach", "--quiet", "HEAD");
  await fixture.fire("session_start");
  const detached = fixture.metadata(await fixture.request());
  expect(detached?.["branch"]).toBeUndefined();
  expect(detached?.["commit"]).toMatch(/^[0-9a-f]{4,64}$/);

  await writeFile(join(fixture.cwd, ".git/config"), "[broken");
  await fixture.fire("session_start");
  await expect(fixture.request()).rejects.toThrow("Could not read Git request context");
});

test("filesystem discovery failures are not treated as absence", async () => {
  const fixture = setup();
  await rm(fixture.cwd, { recursive: true, force: true });
  await fixture.fire("session_start");
  await expect(fixture.request()).rejects.toThrow("Could not read Git request context");
});

test("native compaction requests are tagged until the compaction ends", async () => {
  const fixture = setup();
  await fixture.fire("session_start");

  await fixture.fire("session_before_compact");
  const during = await fixture.request();
  expect(during["x-litellm-tags"]).toEndWith(",call_kind:compaction");
  expect(fixture.metadata(during)?.["call_kind"]).toBe("compaction");

  for (const end of ["session_compact", "session_compact_failed", "turn_start"]) {
    await fixture.fire("session_before_compact");
    await fixture.fire(end);
    expect(fixture.metadata(await fixture.request())?.["call_kind"]).toBe("main");
  }
});

test("headers configured elsewhere are kept", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  const headers = await fixture.request("litellm", {
    "x-litellm-tags": "team:search",
    "x-litellm-spend-logs-metadata": '{"owner":"search"}',
  });
  expect(headers["x-litellm-tags"]).toStartWith("team:search,axon_workflow:pr-review,");
  expect(headers["x-litellm-spend-logs-metadata"]).toBe('{"owner":"search"}');
});

test("invalid launch values are dropped and branch names stay printable ASCII", async () => {
  process.env["AXON_WORKFLOW"] = "nightly run, prod";
  process.env["PI_AXON_CLI_VERSION"] = "1.0.4\nInjected: yes";
  const fixture = setup({ branch: "feat/café,ünïcode" });
  await fixture.fire("session_start");
  const headers = await fixture.request();

  expect(headers["x-litellm-tags"]).toBe(
    "repo:tata1mg/catalog-autopilot-backend,pi_mode:print,call_kind:main",
  );
  const sent = fixture.metadata(headers);
  expect(sent?.["axon_workflow"]).toBeUndefined();
  expect(sent?.["axon_version"]).toBeUndefined();
  expect(sent?.["branch"]).toBe("feat/caf_,_n_code");
  expect(headers["x-litellm-spend-logs-metadata"]).toMatch(/^[\x20-\x7e]+$/);
});

test("publishes the context for requests that bypass Pi's header hook", async () => {
  const fixture = setup();
  await fixture.fire("session_start");
  await fixture.request();
  const context = fixture.published.at(-1) as RequestContext;

  expect(context.tags("web_search")).toEndWith(",call_kind:web_search");
  expect(context.metadata("compaction")).toMatchObject({
    repo: "tata1mg/catalog-autopilot-backend",
    call_kind: "compaction",
  });
});

test.each([
  "file:///Users/alice/work/private-repo.git",
  "file:/Users/alice/work/private-repo.git",
  "FILE://localhost/Users/alice/work/private-repo.git",
  "/Users/alice/work/private-repo.git",
  "../alice/work/private-repo.git",
  "C:/Users/alice/work/private-repo.git",
])("local remote %s never enters exported tags or metadata", async (remote) => {
  const fixture = setup({ remote });
  await fixture.fire("session_start");
  const headers = await fixture.request();
  expect(headers["x-litellm-tags"]).not.toContain("repo:");
  expect(fixture.metadata(headers)?.["repo"]).toBeUndefined();
  expect(JSON.stringify(headers)).not.toContain("alice");
});

test.each([
  ["git@ssh.bitbucket.org:tata1mg/axon_harness.git", "tata1mg/axon_harness"],
  ["https://user:secret-token@github.com/Org/Repo.git", "org/repo"],
  ["ssh://git@gitlab.example.com:2222/group/sub/repo.git/", "group/sub/repo"],
  ["/srv/git/repo.git", undefined],
  ["file:///home/alice/projects/app.git", undefined],
  ["not a remote", undefined],
])("repo name from remote %s", (remote, expected) => {
  expect(repoFromRemote(remote)).toBe(expected);
});

test.each([
  ["feat/DD-520-price-sync", "DD-520"],
  ["LIT-1234", "LIT-1234"],
  ["feat/cli-1.0.4-pi-1.5.2-workflow-tagging", undefined],
  ["fix/dd-520-lowercase", undefined],
])("ticket from branch %s", (branch, expected) => {
  expect(ticketFromBranch(branch)).toBe(expected);
});
