import { homedir } from "node:os";
import {
  type AppKeybinding,
  type BashOperations,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  keyText,
  type Theme,
  type ToolDefinition,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const ENTRY_TYPE = "axon-status";
const SANDBOX_REQUEST_TIMEOUT_MS = 5_000;
// Keep this bus contract in sync with axon-auth.ts; both extensions ship standalone.
const SANDBOX_EDITOR_CHANNEL = "axon:sandbox-editor";
// Keep this bus contract in sync with session-backup/index.ts; this extension ships standalone.
const BACKUP_HEADER_CHANNEL = "axon:backup-status";
const BACKUP_LABELS = {
  checking: "checking…",
  syncing: "syncing…",
  saved: "saved",
  pending: "pending",
  paused: "paused",
  off: "off",
  ready: "on",
} as const;
type BackupHeaderState = keyof typeof BACKUP_LABELS;
// Keep this bus contract in sync with terminal-permissions.ts; this extension ships standalone.
const TERMINAL_HEADER_CHANNEL = "axon:terminal-status";
const TERMINAL_LABELS = {
  standard: "standard",
  yolo: "YOLO",
  blocked: "blocked (invalid config)",
} as const;
type TerminalHeaderState = keyof typeof TERMINAL_LABELS;
type ThemeColor = Parameters<Theme["fg"]>[0];

/** Below this width the header drops the card and logo for plain stacked lines. */
const CARD_MIN_WIDTH = 56;
/** Keep the card readable on very wide terminals instead of stretching edge to edge. */
const CARD_MAX_WIDTH = 84;
const LOGO_WIDTH = 5;
const TAGLINE = "TATA 1mg · Your coding workspace";

interface Shortcut {
  readonly key: string;
  readonly description: string;
}

/** Show the working directory home-relative and strip anything that could steer the terminal. */
function displayDirectory(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const home = homedir();
  const relative =
    home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  return relative.replace(/\p{Cc}/gu, "?");
}

/** Keep the most specific end of a path, dropping leading directories first. */
function truncatePathStart(path: string, width: number): string {
  if (visibleWidth(path) <= width) return path;
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index++) {
    const tail = `…/${parts.slice(index).join("/")}`;
    if (visibleWidth(tail) <= width) return tail;
  }
  return truncateToWidth(parts.at(-1) ?? path, width);
}

/** Compact, responsive branding; all colors and shortcuts follow Pi's active settings. */
function createAxonHeader(
  theme: Theme,
  backupState: () => BackupHeaderState | undefined,
  terminalState: () => TerminalHeaderState | undefined,
  cwd?: string,
) {
  const rawVersion = process.env["PI_AXON_CLI_VERSION"];
  const version =
    rawVersion && /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}$/.test(rawVersion) ? ` v${rawVersion}` : "";
  const directory = displayDirectory(cwd);
  let expanded = false;

  const shortcut = (action: AppKeybinding, description: string): Shortcut | undefined => {
    const key = keyText(action);
    return key ? { key, description } : undefined;
  };
  const present = (items: (Shortcut | undefined)[]): Shortcut[] =>
    items.filter((item): item is Shortcut => item !== undefined);
  const separator = theme.fg("dim", " · ");
  const formatShortcut = ({ key, description }: Shortcut): string =>
    theme.fg("muted", key) + theme.fg("dim", ` ${description}`);

  const backupBadge = (): string | undefined => {
    const state = backupState();
    if (state === undefined) return undefined;
    const color: ThemeColor =
      state === "saved" || state === "ready"
        ? "success"
        : state === "paused" || state === "pending"
          ? "warning"
          : state === "checking" || state === "syncing"
            ? "accent"
            : "dim";
    return (
      theme.fg(color, state === "off" ? "○" : "●") +
      theme.fg("dim", " Backup: ") +
      theme.fg(color, BACKUP_LABELS[state])
    );
  };

  const terminalBadge = (): string | undefined => {
    const state = terminalState();
    if (state === undefined) return undefined;
    const color: ThemeColor =
      state === "blocked" ? "error" : state === "yolo" ? "warning" : "success";
    return (
      theme.fg(color, "●") +
      theme.fg("dim", " Terminal: ") +
      theme.fg(color, TERMINAL_LABELS[state])
    );
  };

  const sandboxBadge = (): string | undefined => {
    if (process.env["PI_AXON_SANDBOX"] !== "safehouse") return undefined;
    return (
      theme.fg("success", "●") + theme.fg("dim", " Sandbox: ") + theme.fg("success", "enabled")
    );
  };

  /** Right-align the badge; the wordmark always wins when both cannot fit. */
  const withBadge = (
    left: string,
    width: number,
    minimumLeftWidth: number,
    badge: string | undefined,
  ): string => {
    if (badge === undefined) return truncateToWidth(left, width);
    const available = width - visibleWidth(badge) - 2;
    if (available < minimumLeftWidth) return truncateToWidth(left, width);
    const fitted = truncateToWidth(left, available, available === minimumLeftWidth ? "" : "…");
    return fitted + " ".repeat(width - visibleWidth(fitted) - visibleWidth(badge)) + badge;
  };

  /** Share the title row when possible; stack runtime status on smaller screens. */
  const heading = (width: number): { title: string; overflow: string[] } => {
    const title = theme.bold(theme.fg("accent", "Axon")) + theme.fg("dim", version);
    const backup = backupBadge();
    const terminal = terminalBadge();
    const sandbox = sandboxBadge();
    const badges = [backup, terminal, sandbox].filter(
      (badge): badge is string => badge !== undefined,
    );
    const combined = badges.join(separator);
    if (width - visibleWidth(combined) - 2 >= 4) {
      return { title: withBadge(title, width, 4, combined || undefined), overflow: [] };
    }
    const runtimeBadges = [terminal, sandbox]
      .filter((badge): badge is string => badge !== undefined)
      .join(separator);
    const overflow = runtimeBadges
      ? wrapTextWithAnsi(runtimeBadges, width).map(
          (line) => " ".repeat(Math.max(0, width - visibleWidth(line))) + line,
        )
      : [];
    return { title: withBadge(title, width, 4, backup), overflow };
  };

  /** Join shortcuts with separators, wrapping between items rather than inside them. */
  const wrapShortcuts = (items: Shortcut[], width: number): string[] => {
    const lines: string[] = [];
    let current = "";
    for (const item of items.map(formatShortcut)) {
      if (current && visibleWidth(current + separator + item) <= width) {
        current += separator + item;
      } else {
        if (current) lines.push(current);
        const wrapped = wrapTextWithAnsi(item, width);
        lines.push(...wrapped.slice(0, -1));
        current = wrapped.at(-1) ?? "";
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  /** Two aligned columns for the expanded reference, falling back to wrapping when narrow. */
  const shortcutTable = (items: Shortcut[], width: number): string[] => {
    const keyWidth = Math.max(...items.map(({ key }) => visibleWidth(key)));
    const descriptionWidth = width - keyWidth - 2;
    if (descriptionWidth < 12) {
      return items.flatMap((item) => wrapTextWithAnsi(formatShortcut(item), width));
    }
    return items.flatMap(({ key, description }) =>
      wrapTextWithAnsi(description, descriptionWidth).map(
        (line, index) =>
          (index === 0
            ? theme.fg("muted", key) + " ".repeat(keyWidth - visibleWidth(key) + 2)
            : " ".repeat(keyWidth + 2)) + theme.fg("dim", line),
      ),
    );
  };

  const logo = (): string[] => {
    const wire = (text: string) => theme.fg("borderAccent", text);
    const node = (text: string) => theme.fg("accent", text);
    return [
      `${theme.bold(node("◉"))}${wire("─╮")}  `,
      `  ${wire("├─")}${node("●")}`,
      `  ${wire("╰─")}${node("●")}`,
    ];
  };

  const card = (width: number): string[] => {
    const border = (text: string) => theme.fg("borderMuted", text);
    const inner = width - 6;
    const textWidth = inner - LOGO_WIDTH - 2;
    const { title, overflow } = heading(textWidth);
    const rows = [
      title,
      theme.fg("muted", truncateToWidth(TAGLINE, textWidth)),
      directory === undefined ? "" : theme.fg("dim", truncatePathStart(directory, textWidth)),
      ...overflow,
    ];
    const mark = logo();
    const body = rows.map((row, index) => {
      const content = `${mark[index] ?? " ".repeat(LOGO_WIDTH)}  ${row}`;
      return `${border("│")}  ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}  ${border("│")}`;
    });
    const attribution = ` DeputyDev · Powered by Pi v${VERSION} `;
    const bottomRule = width - 2 - visibleWidth(attribution) - 2;
    const bottom =
      bottomRule >= 2
        ? border(`╰${"─".repeat(bottomRule)}`) + theme.fg("dim", attribution) + border("──╯")
        : border(`╰${"─".repeat(width - 2)}╯`);
    return [border(`╭${"─".repeat(width - 2)}╮`), ...body, bottom];
  };

  const compact = (width: number): string[] => {
    const { title, overflow } = heading(width);
    return [
      title,
      ...overflow,
      theme.fg("muted", truncateToWidth("TATA 1mg", width)),
      theme.fg("dim", truncateToWidth(`DeputyDev · Powered by Pi v${VERSION}`, width)),
    ];
  };

  return {
    setExpanded(value: boolean) {
      expanded = value;
    },
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const padding = width > 2 ? 1 : 0;
      const contentWidth = width - padding * 2;
      // Hints wrap to the card so the whole header shares one left and right edge.
      const brandWidth = Math.min(contentWidth, CARD_MAX_WIDTH);
      const brand = contentWidth >= CARD_MIN_WIDTH ? card(brandWidth) : compact(contentWidth);
      const more = shortcut("app.tools.expand", expanded ? "less" : "more");
      const essentials = present([
        shortcut("app.interrupt", "interrupt"),
        shortcut("app.model.select", "models"),
      ]);
      const prefixes: Shortcut[] = [
        { key: "/", description: "commands" },
        { key: "!", description: "shell" },
      ];
      const help = expanded
        ? [
            ...shortcutTable(
              present([
                ...essentials,
                shortcut("app.clear", "clear / twice to exit"),
                shortcut("app.exit", "exit (empty editor)"),
                shortcut("app.thinking.cycle", "thinking level"),
                shortcut("app.thinking.toggle", "show/hide thinking"),
                shortcut("app.editor.external", "external editor"),
                shortcut("app.message.followUp", "queue follow-up"),
                shortcut("app.clipboard.pasteImage", "attach files/images"),
                ...prefixes,
              ]),
              brandWidth,
            ),
            "",
            ...wrapShortcuts(
              present([more, { key: "/hotkeys", description: "all shortcuts" }]),
              brandWidth,
            ),
          ]
        : wrapShortcuts(
            present([
              ...essentials,
              ...prefixes,
              more,
              { key: "/hotkeys", description: "all shortcuts" },
            ]),
            brandWidth,
          );
      return [...brand, "", ...help].map((line) =>
        line ? " ".repeat(padding) + truncateToWidth(line, contentWidth) : "",
      );
    },
  };
}
// Keep in sync with axon-auth.ts; each extension ships standalone.
function authRelayConfiguration(): { origin: string; capability: string } | undefined {
  const origin = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_URL") as string | undefined;
  const capability = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_KEY") as string | undefined;
  if (!origin || !capability) return undefined;
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return { origin: url.origin, capability };
  } catch {
    return undefined;
  }
}

interface SandboxScope {
  readonly project: string;
  readonly projectMode: "read-only" | "read-write";
  readonly readPaths: string[];
  readonly writePaths: string[];
  readonly denyPaths: string[];
}

function parseSandboxScope(value: unknown): SandboxScope {
  const scope = value as Partial<SandboxScope> | null;
  if (
    !scope ||
    typeof scope.project !== "string" ||
    scope.project.length > 4096 ||
    (scope.projectMode !== "read-only" && scope.projectMode !== "read-write") ||
    ![scope.readPaths, scope.writePaths, scope.denyPaths].every(
      (paths) =>
        Array.isArray(paths) &&
        paths.length <= 64 &&
        paths.every((path) => typeof path === "string" && path.length <= 4096),
    )
  ) {
    throw new Error("Invalid sandbox status response");
  }
  return scope as SandboxScope;
}

/** A live, display-only section below Pi's startup resources; grants stay parent-owned. */
function createSandboxScopeDisplay(ctx: ExtensionContext) {
  const config = authRelayConfiguration();
  if (ctx.mode !== "tui" || config === undefined) return undefined;
  const controller = new AbortController();
  let scope: SandboxScope | undefined;
  let unavailable = false;
  let refreshDisplay: (() => void) | undefined;
  let removeSection: (() => void) | undefined;

  const createComponent = (theme: Theme): Component => {
    const pathsSummary = (paths: readonly string[]): string =>
      paths.length
        ? `${paths.length} · ${paths
            .slice(0, 2)
            .map((path) => displayDirectory(path))
            .join(", ")}${paths.length > 2 ? ` (+${paths.length - 2} more)` : ""}`
        : "(none)";
    const settingLine = (label: string, value: string, color: ThemeColor): string =>
      theme.fg("muted", `  ${label}: `) + theme.fg(color, value);
    return {
      invalidate() {},
      render(width: number): string[] {
        if (width <= 0) return [];
        const padding = width > 2 ? 1 : 0;
        const contentWidth = width - padding * 2;
        const lines = [
          theme.fg("mdHeading", "[Sandbox]"),
          settingLine("Scope", "this Axon session", "accent") +
            theme.fg("dim", " · resets on exit"),
        ];
        if (scope === undefined) {
          lines.push(
            theme.fg(
              unavailable ? "warning" : "accent",
              unavailable ? "  Current permissions unavailable" : "  Loading current permissions…",
            ),
          );
        } else {
          const projectLabel = `  Project (${scope.projectMode}): `;
          const projectWidth = Math.max(1, contentWidth - visibleWidth(projectLabel));
          lines.push(
            theme.fg("muted", "  Project (") +
              theme.fg(
                scope.projectMode === "read-only" ? "success" : "warning",
                scope.projectMode,
              ) +
              theme.fg("muted", "): ") +
              theme.fg(
                "dim",
                truncatePathStart(displayDirectory(scope.project) ?? "", projectWidth),
              ),
            settingLine(
              "Extra read-only",
              pathsSummary(scope.readPaths),
              scope.readPaths.length ? "success" : "dim",
            ),
            settingLine(
              "Extra read/write",
              pathsSummary(scope.writePaths),
              scope.writePaths.length ? "warning" : "dim",
            ),
            settingLine(
              "Blocked",
              pathsSummary(scope.denyPaths),
              scope.denyPaths.length ? "error" : "dim",
            ),
          );
        }
        lines.push(
          theme.fg("accent", "  /sandbox") +
            theme.fg("dim", " to review or edit · changes apply after saving"),
        );
        return lines.map((line) => " ".repeat(padding) + truncateToWidth(line, contentWidth));
      },
    };
  };

  return {
    mount(tui: TUI, theme: Theme, header: Component): void {
      // setHeader installs its component after the factory returns.
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        removeSection?.();
        for (const parent of tui.children) {
          if (!(parent instanceof Container)) continue;
          const headerIndex = parent.children.findIndex(
            (child) => child instanceof Container && child.children.includes(header),
          );
          if (
            headerIndex === -1 ||
            !(parent.children[headerIndex + 1] instanceof Container) ||
            !(parent.children[headerIndex + 2] instanceof Container)
          ) {
            continue;
          }
          // Pi 1.4's document contains header, loaded resources, then chat.
          // Widgets only support editor placement, so insert a separate startup section.
          const section = new Container();
          section.addChild(createComponent(theme));
          section.addChild(new Spacer(1));
          parent.children.splice(headerIndex + 2, 0, section);
          refreshDisplay = () => tui.requestRender();
          removeSection = () => {
            parent.removeChild(section);
            refreshDisplay = undefined;
            removeSection = undefined;
            tui.requestRender();
          };
          tui.requestRender();
          return;
        }
      });
    },
    unmount(): void {
      removeSection?.();
    },
    async refresh(): Promise<void> {
      try {
        const response = await fetch(new URL("/_axon/sandbox/status", config.origin), {
          headers: { Authorization: `Bearer ${config.capability}` },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(SANDBOX_REQUEST_TIMEOUT_MS),
          ]),
        });
        if (!response.ok) throw new Error("Sandbox status unavailable");
        const current = parseSandboxScope(await response.json());
        if (controller.signal.aborted) return;
        scope = current;
        unavailable = false;
      } catch {
        if (controller.signal.aborted) return;
        // Never present an old snapshot as the current permissions after a failed refresh.
        scope = undefined;
        unavailable = true;
      }
      refreshDisplay?.();
    },
    dispose(): void {
      controller.abort();
      removeSection?.();
    },
  };
}

async function requestSandboxOperation(
  tool: string,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const config = authRelayConfiguration();
  if (!config) throw new Error("The parent-owned sandbox operation relay is unavailable");
  const response = await fetch(new URL("/_axon/sandbox/execute", config.origin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.capability}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, input, cwd }),
    ...(signal ? { signal } : {}),
    redirect: "error",
    cache: "no-store",
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = result as { error?: unknown } | null;
    throw new Error(typeof error?.error === "string" ? error.error : "Sandbox operation failed");
  }
  return result;
}

/** Shared by the bundled terminal guard; approvals still run before any shell operation. */
export function createSandboxShellOperations(shellPath?: string): BashOperations | undefined {
  if (process.env["PI_AXON_SANDBOX_OPERATIONS"] !== "1") return undefined;
  return {
    async exec(command, cwd, options) {
      const result = (await requestSandboxOperation(
        "shell",
        {
          command,
          ...(shellPath ? { shellPath } : {}),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        },
        cwd,
        options.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      options.onData(Buffer.from(result.stdout));
      options.onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
  };
}

function registerSandboxFileTools(pi: ExtensionAPI): void {
  if (process.env["PI_AXON_SANDBOX_OPERATIONS"] !== "1") return;
  function register<TParams extends ToolDefinition["parameters"], TDetails>(
    nativeTool: ToolDefinition<TParams, TDetails>,
  ): void {
    pi.registerTool({
      ...nativeTool,
      defaultActive: false,
      async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
        return (await requestSandboxOperation(
          nativeTool.name,
          parameters,
          ctx.cwd,
          signal,
        )) as Awaited<ReturnType<typeof nativeTool.execute>>;
      },
    });
  }
  register(createReadToolDefinition(process.cwd()));
  register(createWriteToolDefinition(process.cwd()));
  register(createEditToolDefinition(process.cwd()));
  register(createGrepToolDefinition(process.cwd()));
  register(createFindToolDefinition(process.cwd()));
  register(createLsToolDefinition(process.cwd()));
}

export default function axonExtension(pi: ExtensionAPI): void {
  // Keep AWS credentials available to tools, but never offer direct Bedrock models.
  // An explicit empty catalog also covers saved /login tokens, models.json, and
  // catalog refreshes. unregisterProvider would restore the built-in catalog.
  pi.registerProvider("amazon-bedrock", { models: [] });

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["axon"] =
      "You are running through Axon Pi, not Pi directly. " +
      "Use PI_CODING_AGENT_DIR (normally ~/.axon/pi), not ~/.pi/agent, for user-level configuration: " +
      "MCP servers in mcp.json, skills in skills/, and extensions in extensions/. " +
      "Project-local configuration still uses .pi/.";
  });

  registerSandboxFileTools(pi);
  let sandboxDisplay: ReturnType<typeof createSandboxScopeDisplay>;
  let sandboxEditorOpen = false;
  let backupState: BackupHeaderState | undefined;
  let terminalState: TerminalHeaderState | undefined;
  let refreshHeader: (() => void) | undefined;
  pi.events.on(BACKUP_HEADER_CHANNEL, (data) => {
    if (typeof data !== "string" || !Object.hasOwn(BACKUP_LABELS, data)) return;
    backupState = data as BackupHeaderState;
    refreshHeader?.();
  });
  pi.events.on(TERMINAL_HEADER_CHANNEL, (data) => {
    if (typeof data !== "string" || !Object.hasOwn(TERMINAL_LABELS, data)) return;
    terminalState = data as TerminalHeaderState;
    refreshHeader?.();
  });
  // Replace opaque transport errors through Pi's normal message pipeline, never
  // console/stderr. Keep stopReason/content/usage intact so retries still work.
  pi.on("message_end", (event) => {
    const message = event.message;
    const logFile = process.env["PI_AXON_RELAY_LOG_FILE"];
    if (
      !logFile ||
      authRelayConfiguration() === undefined ||
      message.role !== "assistant" ||
      message.provider !== "litellm" ||
      message.stopReason !== "error" ||
      !/^(?:terminated|fetch failed|The socket connection was closed unexpectedly[^\n]*)$/i.test(
        message.errorMessage ?? "",
      )
    ) {
      return;
    }
    return {
      message: {
        ...message,
        errorMessage: `Connection error: the connection to Axon AI Gateway was interrupted. Retry if needed. Relay diagnostics: ${logFile.replace(/\p{Cc}/gu, "?")}`,
      },
    };
  });
  pi.on("session_start", (_event, ctx) => {
    sandboxDisplay?.dispose();
    sandboxDisplay = createSandboxScopeDisplay(ctx);
    void sandboxDisplay?.refresh();
    if (ctx.mode === "tui") {
      ctx.ui.setHeader((tui, theme) => {
        const component = createAxonHeader(
          theme,
          () => backupState,
          () => terminalState,
          ctx.cwd,
        );
        const refresh = () => {
          component.invalidate();
          tui.requestRender();
        };
        refreshHeader = refresh;
        const display = sandboxDisplay;
        const header = {
          ...component,
          dispose() {
            display?.unmount();
            if (refreshHeader === refresh) refreshHeader = undefined;
          },
        };
        display?.mount(tui, theme, header);
        return header;
      });
    } else if (ctx.mode === "rpc") {
      // setHeader is a no-op over RPC; Pi's standard status entries carry the
      // same badges to any RPC client that renders them.
      const published = new Map<string, string | undefined>();
      const publish = (key: string, value: string | undefined) => {
        if (published.get(key) === value) return;
        published.set(key, value);
        ctx.ui.setStatus(key, value);
      };
      refreshHeader = () => {
        publish("axon-backup", backupState && `Backup: ${BACKUP_LABELS[backupState]}`);
        publish("axon-terminal", terminalState && `Terminal: ${TERMINAL_LABELS[terminalState]}`);
      };
      refreshHeader();
    }
  });
  pi.on("session_shutdown", () => {
    refreshHeader = undefined;
    backupState = undefined;
    terminalState = undefined;
    sandboxDisplay?.dispose();
    sandboxDisplay = undefined;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "Axon is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  pi.registerCommand("sandbox", {
    description: "Edit temporary filesystem access; restart Pi and resume this chat safely",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify(
          "Use /sandbox without arguments to open the filesystem access editor.",
          "warning",
        );
        return;
      }
      const config = authRelayConfiguration();
      if (ctx.mode !== "tui" || config === undefined) {
        ctx.ui.notify(
          "Open an interactive Axon session to edit temporary sandbox permissions.",
          "warning",
        );
        return;
      }
      if (sandboxEditorOpen) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the current turn to finish, then run /sandbox.", "warning");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const hasConversation = ctx.sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant"),
        );
      if (hasConversation && !sessionFile) {
        ctx.ui.notify(
          "Save or resume a persisted session before changing sandbox permissions; an in-memory chat cannot survive Pi's required restart.",
          "warning",
        );
        return;
      }
      if (hasConversation) {
        // Native resume chooses the last entry. This harmless checkpoint preserves
        // the selected branch, including a tree navigation without a subsequent turn.
        pi.appendEntry("axon-sandbox-restart", {});
      }
      const resume = {
        sessionId,
        ...(hasConversation && sessionFile ? { sessionFile } : {}),
      };
      sandboxEditorOpen = true;
      // Suspend login dialogs while the parent owns the terminal.
      pi.events.emit(SANDBOX_EDITOR_CHANNEL, true);
      try {
        const outcome = await ctx.ui.custom<{ opened: boolean; saved: boolean }>(
          async (tui, _theme, _keybindings, done) => {
            // Release stdin and terminal protocols before Axon takes over the same terminal.
            tui.stop();
            let outcome = { opened: false, saved: false };
            try {
              process.stdout.write("\x1b[2J\x1b[H");
              const response = await fetch(new URL("/_axon/sandbox/configure", config.origin), {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${config.capability}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(resume),
                redirect: "error",
                cache: "no-store",
              });
              if (!response.ok) throw new Error("Sandbox editor unavailable");
              const result: unknown = await response.json();
              const payload = result as { opened?: unknown; saved?: unknown } | null;
              if (typeof payload?.opened !== "boolean")
                throw new Error("Invalid sandbox editor response");
              outcome = { opened: payload.opened, saved: payload.saved === true };
            } finally {
              // Restore the chat even if the relay fails or the user cancels the editor.
              tui.start();
              tui.requestRender(true);
            }
            done(outcome);
            return { render: () => [], invalidate: () => {} };
          },
        );
        if (outcome.saved) {
          ctx.ui.notify(
            "Sandbox permissions saved. Axon will restart Pi and resume this chat under the new rules.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          outcome.opened
            ? "Sandbox editor closed without saving. Your chat is unchanged."
            : "Sandbox configuration cancelled. Your chat is unchanged.",
          "info",
        );
      } catch {
        ctx.ui.notify(
          "Could not complete sandbox configuration. Run /sandbox again to review the current permissions.",
          "warning",
        );
      } finally {
        await sandboxDisplay?.refresh();
        sandboxEditorOpen = false;
        pi.events.emit(SANDBOX_EDITOR_CHANNEL, false);
      }
    },
  });

  pi.registerCommand("axon-status", {
    description: "Show the active Axon integration status",
    handler: async () => {
      pi.appendEntry(ENTRY_TYPE, {
        message: "Axon-managed Pi resources are active",
      });
    },
  });
}
