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
const AXON_SAFEHOUSE_REQUEST_TIMEOUT_MS = 5_000;
// Keep this bus contract in sync with axon-auth.ts; both extensions ship standalone.
const AXON_SAFEHOUSE_EDITOR_CHANNEL = "axon:axon-safehouse-editor";
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
  // The launcher selects from src/product/tips.ts; keep this extension standalone.
  const tip = process.env["PI_AXON_STARTUP_TIP"]
    ?.replace(/\p{Cc}/gu, (character) => (character === "\n" ? "\n" : "?"))
    .trim();
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

  const axonSafehouseBadge = (): string | undefined => {
    if (process.env["PI_AXON_SAFEHOUSE"] !== "safehouse") return undefined;
    return (
      theme.fg("success", "●") +
      theme.fg("dim", " Axon Safehouse: ") +
      theme.fg("success", "enabled")
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
    const title =
      theme.bold(theme.fg("accent", "Axon")) + theme.fg("dim", ` by DeputyDev${version}`);
    const backup = backupBadge();
    const terminal = terminalBadge();
    const axonSafehouse = axonSafehouseBadge();
    const badges = [backup, terminal, axonSafehouse].filter(
      (badge): badge is string => badge !== undefined,
    );
    const combined = badges.join(separator);
    if (width - visibleWidth(combined) - 2 >= 4) {
      return { title: withBadge(title, width, 4, combined || undefined), overflow: [] };
    }
    const runtimeBadges = [terminal, axonSafehouse]
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
    const attribution = ` Powered by Pi v${VERSION} `;
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
      theme.fg("dim", truncateToWidth(`Powered by Pi v${VERSION}`, width)),
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
      const tips = tip
        ? [
            "",
            theme.fg("accent", "[Tips]"),
            ...wrapTextWithAnsi(tip, brandWidth).map((line) => theme.fg("muted", line)),
          ]
        : [];
      return [...brand, "", ...help, ...tips].map((line) =>
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

interface AxonSafehouseScope {
  readonly project: string;
  readonly projectMode: "read-only" | "read-write";
  readonly readPaths: string[];
  readonly writePaths: string[];
  readonly denyPaths: string[];
}

function parseAxonSafehouseScope(value: unknown): AxonSafehouseScope {
  const scope = value as Partial<AxonSafehouseScope> | null;
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
    throw new Error("Invalid Axon Safehouse status response");
  }
  return scope as AxonSafehouseScope;
}

/** A live, display-only section below Pi's startup resources; grants stay parent-owned. */
function createAxonSafehouseScopeDisplay(ctx: ExtensionContext) {
  const config = authRelayConfiguration();
  if (ctx.mode !== "tui" || config === undefined) return undefined;
  const controller = new AbortController();
  let scope: AxonSafehouseScope | undefined;
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
        // Match Pi's resource sections: flush-left headings, two-space body indent.
        const lines = [
          theme.fg("mdHeading", "[Axon Safehouse]"),
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
          const projectWidth = Math.max(1, width - visibleWidth(projectLabel));
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
          theme.fg("accent", "  /safehouse") +
            theme.fg("dim", " to review or edit · changes apply after saving"),
        );
        return lines.map((line) => truncateToWidth(line, width));
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
        const response = await fetch(new URL("/_axon/axon-safehouse/status", config.origin), {
          headers: { Authorization: `Bearer ${config.capability}` },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(AXON_SAFEHOUSE_REQUEST_TIMEOUT_MS),
          ]),
        });
        if (!response.ok) throw new Error("Axon Safehouse status unavailable");
        const current = parseAxonSafehouseScope(await response.json());
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

/** Both standalone extension bundles use the same bus to serialize in-chat reviews. */
export function reviewAxonSafehouseAccessRequest(
  pi: ExtensionAPI,
  id: string,
  ctx: ExtensionContext,
  signal = ctx.signal,
): Promise<boolean> {
  if (!ctx.hasUI || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (saved: boolean) => {
      signal?.removeEventListener("abort", cancel);
      resolve(saved);
    };
    const cancel = () => finish(false);
    signal?.addEventListener("abort", cancel, { once: true });
    pi.events.emit("axon:safehouse-access-request", { id, ctx, signal, finish });
  });
}

async function openFilesystemAccessReview(
  id: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<boolean> {
  const config = authRelayConfiguration();
  if (!config || !ctx.hasUI || signal?.aborted) return false;
  const request = () =>
    fetch(new URL("/_axon/axon-safehouse/access", config.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accessRequest: id }),
      ...(signal ? { signal } : {}),
      redirect: "error",
      cache: "no-store",
    });
  if (ctx.mode === "rpc") {
    const response = await request();
    if (!response.ok) return false;
    const result = (await response.json()) as { saved?: unknown };
    return result.saved === true;
  }
  if (ctx.mode !== "tui") return false;
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    const component = new Text(theme.fg("warning", "Reviewing blocked filesystem access…"), 1, 1);
    // Release only terminal input, not the TUI renderer or the active agent turn. The
    // parent reads actual keystrokes and streams display state; the child cannot approve.
    tui.terminal.stop();
    void (async () => {
      let saved = false;
      try {
        const response = await request();
        if (!response.ok || !response.body) return;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += chunk.value;
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              const record = JSON.parse(buffer.slice(0, newline)) as {
                type?: string;
                title?: string;
                choices?: string[];
                selected?: number;
                saved?: boolean;
              };
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
              if (record.type === "complete") saved = record.saved === true;
              if (record.type === "dialog" && record.title && Array.isArray(record.choices)) {
                component.setText(
                  [
                    theme.fg("warning", record.title),
                    "",
                    ...record.choices.map((choice, index) =>
                      index === record.selected ? theme.fg("accent", `› ${choice}`) : `  ${choice}`,
                    ),
                    "",
                    theme.fg("dim", "↑/↓ to choose · Enter to confirm · Esc to deny"),
                  ].join("\n"),
                );
                tui.requestRender();
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        // Dismissal, cancellation and failed reviews never grant access or abort the chat.
      } finally {
        tui.start();
        done(saved);
        tui.requestRender();
      }
    })();
    return component;
  });
}

async function requestAxonSafehouseOperation(
  tool: string,
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
  onAccessRequest?: (id: string) => Promise<boolean>,
): Promise<unknown> {
  const config = authRelayConfiguration();
  if (!config) throw new Error("The parent-owned Axon Safehouse operation relay is unavailable");
  const response = await fetch(new URL("/_axon/axon-safehouse/execute", config.origin), {
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
  const result = (await response.json()) as {
    accessRequest?: unknown;
    error?: unknown;
    stderr?: string;
  } | null;
  let review: string | undefined;
  if (typeof result?.accessRequest === "string" && /^[a-f0-9-]{36}$/.test(result.accessRequest)) {
    const saved = (await onAccessRequest?.(result.accessRequest).catch(() => false)) === true;
    signal?.throwIfAborted();
    // Only idempotent inspection tools can be transparently retried. Shell commands,
    // writes and edits may already have side effects before reporting a denied path.
    if (saved && ["read", "grep", "find", "ls"].includes(tool))
      return requestAxonSafehouseOperation(tool, input, cwd, signal);
    review = saved
      ? "[Safehouse access review: granted for this session. Continue the task. The failed operation was not replayed; inspect any partial effects before retrying a command or edit.]"
      : "[Safehouse access review: not granted. Keep this path blocked and continue with permitted work; do not retry the denied path.]";
    if (tool === "denial") return { ...result, accessGranted: saved };
  }
  if (!response.ok)
    throw new Error(
      [typeof result?.error === "string" ? result.error : "Axon Safehouse operation failed", review]
        .filter(Boolean)
        .join("\n"),
    );
  if (review && tool === "shell")
    return { ...result, stderr: `${result?.stderr ?? ""}\n${review}` };
  return result;
}

/** Shared by the bundled terminal guard; approvals still run before any shell operation. */
export function createAxonSafehouseShellOperations(
  shellPath?: string,
  onAccessRequest?: (id: string) => Promise<boolean>,
): BashOperations | undefined {
  if (process.env["PI_AXON_SAFEHOUSE_OPERATIONS"] !== "1") return undefined;
  return {
    async exec(command, cwd, options) {
      const result = (await requestAxonSafehouseOperation(
        "shell",
        {
          command,
          ...(shellPath ? { shellPath } : {}),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        },
        cwd,
        options.signal,
        onAccessRequest,
      )) as { exitCode: number; stdout: string; stderr: string };
      options.onData(Buffer.from(result.stdout));
      options.onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
  };
}

function registerAxonSafehouseFileTools(pi: ExtensionAPI): void {
  if (process.env["PI_AXON_SAFEHOUSE_OPERATIONS"] !== "1") return;
  function register<TParams extends ToolDefinition["parameters"], TDetails>(
    nativeTool: ToolDefinition<TParams, TDetails>,
  ): void {
    pi.registerTool({
      ...nativeTool,
      defaultActive: false,
      async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
        return (await requestAxonSafehouseOperation(
          nativeTool.name,
          parameters,
          ctx.cwd,
          signal,
          (id) => reviewAxonSafehouseAccessRequest(pi, id, ctx, signal),
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
      "Project-local configuration still uses .pi/. " +
      "When Safehouse blocks filesystem access, the tool waits for the user's in-chat permission review. " +
      "After approval, continue the same task using the granted access. After denial, continue only with permitted work. " +
      "Do not retry the same path through another tool or command to bypass the restriction.";
  });

  registerAxonSafehouseFileTools(pi);
  let axonSafehouseDisplay: ReturnType<typeof createAxonSafehouseScopeDisplay>;
  let axonSafehouseEditorOpen = false;
  let accessReviews = Promise.resolve();
  // Keep this channel in sync with the separately bundled terminal guard. Every tool
  // waits for its review; concurrent tools cannot replace each other's approval UI.
  pi.events.on("axon:safehouse-access-request", (data) => {
    const request = data as {
      id: string;
      ctx: ExtensionContext;
      signal?: AbortSignal;
      finish: (saved: boolean) => void;
    };
    if (!request || typeof request.id !== "string" || typeof request.finish !== "function") return;
    accessReviews = accessReviews.then(async () => {
      let saved = false;
      try {
        if (!axonSafehouseEditorOpen && !request.signal?.aborted) {
          pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, true);
          saved = await openFilesystemAccessReview(request.id, request.ctx, request.signal);
        }
      } catch {
        // A failed review is a denial, not a reason to abort the active task.
      } finally {
        pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, false);
        await axonSafehouseDisplay?.refresh();
        request.finish(saved);
      }
    });
  });
  pi.on("tool_result", async (event, ctx) => {
    if (ctx.hasUI && event.isError && process.env["PI_AXON_SAFEHOUSE_OPERATIONS"] === "1") {
      const diagnostic = event.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n")
        .slice(0, 64 * 1024);
      if (
        !diagnostic.includes("[Safehouse access review:") &&
        /\b(?:EACCES|EPERM|permission denied|operation not permitted)\b/i.test(diagnostic)
      ) {
        // Also cover tools supplied by other extensions, without inspecting successful results.
        const review = (await requestAxonSafehouseOperation(
          "denial",
          {
            tool: event.toolName,
            diagnostic,
            ...(typeof event.input["path"] === "string" ? { path: event.input["path"] } : {}),
          },
          ctx.cwd,
          ctx.signal,
          (id) => reviewAxonSafehouseAccessRequest(pi, id, ctx),
        ).catch(() => undefined)) as { accessGranted?: boolean } | undefined;
        if (typeof review?.accessGranted === "boolean")
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: review.accessGranted
                  ? "[Safehouse access review: granted. Continue the task; use the brokered file or shell tools for the newly allowed path. Check partial effects before retrying commands or edits.]"
                  : "[Safehouse access review: not granted. Continue only with permitted work; do not retry this path.]",
              },
            ],
          };
      }
    }
    return undefined;
  });
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
    axonSafehouseDisplay?.dispose();
    axonSafehouseDisplay = createAxonSafehouseScopeDisplay(ctx);
    void axonSafehouseDisplay?.refresh();
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
        const display = axonSafehouseDisplay;
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
    axonSafehouseDisplay?.dispose();
    axonSafehouseDisplay = undefined;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "Axon is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  const configureAxonSafehouse = async (args: string, ctx: ExtensionContext): Promise<void> => {
    // The parent intercepts the user's RPC command and owns every settings dialog.
    // These child-side checkpoints only suspend competing login cards and save the branch;
    // neither this command nor the HTTP relay can approve RPC permission changes.
    if (ctx.mode === "rpc" && args.trim() === "--rpc-close") {
      pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, false);
      return;
    }
    if (args.trim()) {
      ctx.ui.notify(
        "Use /safehouse without arguments to open the Axon Safehouse filesystem access editor.",
        "warning",
      );
      return;
    }
    const config = authRelayConfiguration();
    if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || config === undefined) {
      ctx.ui.notify(
        "Open an interactive Axon session to edit temporary Axon Safehouse permissions.",
        "warning",
      );
      return;
    }
    if (axonSafehouseEditorOpen) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("Wait for the current turn to finish, then run /safehouse.", "warning");
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
        "Save or resume a persisted session before changing Axon Safehouse permissions; an in-memory chat cannot survive Pi's required restart.",
        "warning",
      );
      return;
    }
    if (hasConversation) {
      // Native resume chooses the last entry. This harmless checkpoint preserves
      // the selected branch, including a tree navigation without a subsequent turn.
      pi.appendEntry("axon-safehouse-restart", {});
    }
    if (ctx.mode === "rpc") {
      pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, true);
      return;
    }
    const resume = {
      sessionId,
      ...(hasConversation && sessionFile ? { sessionFile } : {}),
    };
    axonSafehouseEditorOpen = true;
    // Suspend login dialogs while the parent owns the terminal.
    pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, true);
    try {
      const outcome = await ctx.ui.custom<{ opened: boolean; saved: boolean }>(
        async (tui, _theme, _keybindings, done) => {
          // Release stdin and terminal protocols before Axon takes over the same terminal.
          tui.stop();
          let outcome = { opened: false, saved: false };
          try {
            process.stdout.write("\x1b[2J\x1b[H");
            const response = await fetch(
              new URL("/_axon/axon-safehouse/configure", config.origin),
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${config.capability}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(resume),
                redirect: "error",
                cache: "no-store",
              },
            );
            if (!response.ok) throw new Error("Axon Safehouse editor unavailable");
            const result: unknown = await response.json();
            const payload = result as { opened?: unknown; saved?: unknown } | null;
            if (typeof payload?.opened !== "boolean")
              throw new Error("Invalid Axon Safehouse editor response");
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
          "Axon Safehouse permissions saved. Axon will restart Pi and resume this chat under the new rules.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        outcome.opened
          ? "Axon Safehouse editor closed without saving. Your chat is unchanged."
          : "Axon Safehouse configuration cancelled. Your chat is unchanged.",
        "info",
      );
    } catch {
      ctx.ui.notify(
        "Could not complete Axon Safehouse configuration. Run /safehouse again to review the current permissions.",
        "warning",
      );
    } finally {
      await axonSafehouseDisplay?.refresh();
      axonSafehouseEditorOpen = false;
      pi.events.emit(AXON_SAFEHOUSE_EDITOR_CHANNEL, false);
    }
  };

  pi.registerCommand("safehouse", {
    description: "Edit temporary Axon Safehouse filesystem access in your terminal or RPC client",
    handler: (args, ctx) => configureAxonSafehouse(args, ctx),
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
