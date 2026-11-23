import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CustomEditor,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const ENTRY_TYPE = "axon-changelog";
const STATE_FILE = "axon-changelog.json";

/** Axon's release notes, newest first. Keep these independent of Pi's releases. */
export const AXON_RELEASES = [
  {
    version: "1.1.0",
    markdown: `## 1.1.0

### New Features
- Open the local Axon Hub with \`axon hub\` or \`/axon-hub\` in Pi to manage MCP servers and see which user-level skills Pi loads.
- Discover and install organization-published MCP servers with guided setup.
- Add Axon as a T3 Code provider with \`axon setup t3code\`.
- Apps that run a Pi binary directly can use the \`axon-pi\` wrapper; \`axon paths\` shows where it is.

### Changed
- Set \`AXON_IGNORE_OFFLINE=1\` to run \`--offline\` or \`PI_OFFLINE\` Pi launches online, for apps that request offline launches on their own.
- Updated Pi to 1.6.0 and the managed LiteLLM provider to 4.9.0.
- LiteLLM MCP, Skill Hub, and budget footer are configured by your organization; \`LITELLM_ENABLE_MCP\`, \`LITELLM_ENABLE_SKILLS\`, and \`LITELLM_ENABLE_BUDGET\` override them for automation.
- New sessions start on your organization's recommended model and thinking level until you pick a default with \`/model\`. Export \`PI_AXON_TUI_MODEL_PROVIDER\` with \`PI_AXON_TUI_MODEL\`, or \`PI_AXON_TUI_THINKING_LEVEL\`, to choose your own.
- Organization MCP servers are now opt-in through the Hub instead of being added as disabled defaults at launch.
- Each prompt's LLM calls, compaction, and web searches are grouped into one Langfuse trace, with web searches and subagents nested under the LLM call that started them.

### Fixed
- Configured compaction summaries now appear in the corresponding Langfuse session.`,
  },
  {
    version: "1.0.4",
    markdown: `## 1.0.4

### Changed
- Updated Pi to 1.5.2 and LiteLLM provider to 4.7.3.
- Non-interactive sessions check for updates in the background, ready for the next launch.
- Tag workflow telemetry with AXON_WORKFLOW and filter usage in Grafana.
- LiteLLM request logs and Langfuse traces show the workflow, repo, branch, and Axon version of each request.

### Fixed
- Safer recovery from abandoned locks and clearer startup errors.`,
  },
  {
    version: "1.0.3",
    markdown: `## 1.0.3

### Changed
- Updated Pi to 1.5.0 and LiteLLM provider to 4.7.2.
- /yolo now saves your preference across local sessions, subject to backend policy.
- Refined telemetry dashboards and model recommendations.

### Fixed
- More reliable telemetry session refresh and rejected-session handling.
- Prevented child processes from sending unauthenticated telemetry.
- Switched npm registry fallback to Yarn.`,
  },
  {
    version: "1.0.2",
    markdown: `## 1.0.2

### Changed
- Axon-specific /changelog and What's New, tracked independently of Pi.

### Fixed
- Registry fallback for Pi and npm extension installs, preserving pinned versions and integrity checks.
- Clearer API errors and relay diagnostics, including Cloudflare request IDs and retry details, without unnecessary sign-in recovery.`,
  },
  {
    version: "1.0.1",
    markdown: `## 1.0.1

### New Features
- Axon-branded workspace, themes, and startup tips.
- Organization-managed AI Gateway, tools, and terminal permissions.
- Session backups and recovery.`,
  },
  {
    version: "1.0.0",
    markdown: `## 1.0.0

### New Features
- Initial release of Axon.`,
  },
] as const;

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function isVersion(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 160 && VERSION_PATTERN.exec(value)?.[0] === value
  );
}

/** Node-compatible SemVer ordering: Pi extensions cannot depend on Bun.semver. */
export function compareVersions(left: string, right: string): number {
  const a = VERSION_PATTERN.exec(left);
  const b = VERSION_PATTERN.exec(right);
  if (!a || !b) throw new Error("Invalid Axon changelog version");
  const numeric = (x: string, y: string) => x.length - y.length || x.localeCompare(y);
  for (let index = 1; index <= 3; index++) {
    const result = numeric(a[index] ?? "0", b[index] ?? "0");
    if (result) return result;
  }
  if (a[4] === undefined || b[4] === undefined) {
    return a[4] === b[4] ? 0 : a[4] === undefined ? 1 : -1;
  }
  const ap = a[4].split(".");
  const bp = b[4].split(".");
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    const x = ap[index];
    const y = bp[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return numeric(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function newReleaseNotes(lastSeen: string, current: string): string {
  return AXON_RELEASES.filter(
    ({ version }) =>
      compareVersions(version, lastSeen) > 0 && compareVersions(version, current) <= 0,
  )
    .map(({ markdown }) => markdown)
    .join("\n\n");
}

async function readLastSeen(path: string): Promise<string | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("Unsafe changelog state");
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      state === null ||
      typeof state !== "object" ||
      !("schemaVersion" in state) ||
      state.schemaVersion !== 1 ||
      !("lastSeenAxonVersion" in state) ||
      !isVersion(state.lastSeenAxonVersion)
    ) {
      throw new Error("Invalid changelog state");
    }
    return state.lastSeenAxonVersion;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveLastSeen(directory: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, STATE_FILE);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, lastSeenAxonVersion: version }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export default function axonChangelog(pi: ExtensionAPI): void {
  const showChangelog = () => {
    pi.appendEntry(ENTRY_TYPE, {
      markdown: AXON_RELEASES.map(({ markdown }) => markdown).join("\n\n"),
    });
  };

  // Custom entries render in the transcript but never enter the model's context.
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { markdown?: unknown } | undefined;
    const markdown =
      typeof data?.markdown === "string" ? data.markdown : "No Axon release notes yet.";
    const container = new Container();
    container.addChild(new DynamicBorder());
    container.addChild(new Text(theme.bold(theme.fg("accent", "What's New in Axon")), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(markdown, 1, 0, getMarkdownTheme()));
    container.addChild(new DynamicBorder());
    return container;
  });

  // Also offer an ordinary extension command for clients without a terminal editor.
  pi.registerCommand("axon-changelog", {
    description: "Show Axon's release notes",
    handler: async () => showChangelog(),
  });

  let restoreEditor: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    restoreEditor?.();
    restoreEditor = undefined;
    if (ctx.mode !== "tui") return;

    // Pi handles /changelog before extension commands and input events. Wrap the
    // public editor callback instead of patching Pi or intercepting raw keys.
    // This receives expanded pastes and honors submit-key remapping/autocomplete.
    const previous = ctx.ui.getEditorComponent();
    const factory: EditorFactory = (tui, theme, keybindings) => {
      const editor =
        previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      let submit = editor.onSubmit;
      const onSubmit = (text: string) => {
        if (text.trim() !== "/changelog") return submit?.(text);
        editor.addToHistory?.("/changelog");
        editor.setText("");
        showChangelog();
      };
      // Pi assigns onSubmit after calling the factory, and again when rebinding.
      Object.defineProperty(editor, "onSubmit", {
        configurable: true,
        get: () => onSubmit,
        set: (callback: typeof submit) => {
          submit = callback;
        },
      });
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    restoreEditor = () => {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
    };

    const current = process.env["PI_AXON_CLI_VERSION"];
    if (!isVersion(current)) return;
    // Defer an upgrade notice until a new conversation; /resume must not mark it seen.
    if (
      ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "message" || entry.type === "custom_message")
    ) {
      return;
    }
    try {
      const directory = getAgentDir();
      const lastSeen = await readLastSeen(join(directory, STATE_FILE));
      // Do not regress the marker when temporarily launching an older Axon build.
      if (lastSeen !== undefined && compareVersions(current, lastSeen) <= 0) return;
      // As in Pi, a first launch establishes a baseline without an upgrade notice.
      if (lastSeen !== undefined) {
        const markdown = newReleaseNotes(lastSeen, current);
        if (markdown) pi.appendEntry(ENTRY_TYPE, { markdown });
      }
      await saveLastSeen(directory, current);
    } catch {
      // Release notes are optional. Never print outside the TUI or block normal use.
      ctx.ui.notify(
        "Could not update Axon's changelog state. Use /changelog for release notes.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    restoreEditor?.();
    restoreEditor = undefined;
  });
}
