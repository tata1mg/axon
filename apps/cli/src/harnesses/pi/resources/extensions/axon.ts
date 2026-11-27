import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type AppKeybinding,
  type ExtensionAPI,
  keyText,
  type Theme,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "axon-status";
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

  /** Share the title row when possible; stack terminal status on smaller screens. */
  const heading = (width: number): { title: string; overflow: string[] } => {
    const title =
      theme.bold(theme.fg("accent", "Axon")) + theme.fg("dim", ` by DeputyDev${version}`);
    const backup = backupBadge();
    const terminal = terminalBadge();
    const badges = [backup, terminal].filter((badge): badge is string => badge !== undefined);
    const combined = badges.join(separator);
    if (width - visibleWidth(combined) - 2 >= 4) {
      return { title: withBadge(title, width, 4, combined || undefined), overflow: [] };
    }
    const overflow =
      terminal === undefined
        ? []
        : wrapTextWithAnsi(terminal, width).map(
            (line) => " ".repeat(Math.max(0, width - visibleWidth(line))) + line,
          );
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
      const tipPadding = brandWidth > 2 ? 2 : 0;
      const tips = tip
        ? [
            "",
            theme.fg("accent", "[Tips]"),
            ...wrapTextWithAnsi(tip, brandWidth - tipPadding).map(
              (line) => " ".repeat(tipPadding) + theme.fg("muted", line),
            ),
          ]
        : [];
      return [...brand, "", ...help, ...tips].map((line) =>
        line ? " ".repeat(padding) + truncateToWidth(line, contentWidth) : "",
      );
    },
  };
}
/**
 * Mirrors Pi's own resume-command quoting. A value with control characters is written as ANSI-C
 * `$'…'` with escapes instead, so the command still names the real path and no raw control
 * character reaches the terminal.
 */
function shellArgument(value: string): string {
  if (/\p{Cc}/u.test(value)) {
    const escaped = value.replace(/[\\']|\p{Cc}/gu, (char) =>
      char === "\\" || char === "'"
        ? `\\${char}`
        : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
    return `$'${escaped}'`;
  }
  return value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ResumeSession {
  getSessionId(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
}

/**
 * Replace Pi's `pi --session <id>` quit hint with the command that resumes through Axon.
 *
 * Pi stops the TUI, awaits `session_shutdown` handlers, then prints its hint only while
 * `process.stdout.isTTY` is true (interactive-mode.js formatResumeCommand, Pi 1.6). Hiding
 * isTTY here suppresses that line; the exit listener prints the Axon one after Pi has
 * restored the terminal, which also holds for signal shutdowns that dispose before stopping.
 * Revisit if Pi gains a supported override for the resume command.
 */
function replaceResumeHint(session: ResumeSession): void {
  if (!process.stdout.isTTY) return;
  const sessionFile = session.getSessionFile();
  if (!sessionFile) return;
  const args = ["axon", "pi"];
  // Axon exports its session directory to Pi, so only a non-default one needs repeating.
  const launcherSessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"];
  const sessionDir = session.getSessionDir();
  if (!launcherSessionDir || resolve(launcherSessionDir) !== resolve(sessionDir)) {
    args.push("--session-dir", shellArgument(sessionDir));
  }
  args.push("--session", shellArgument(session.getSessionId()));
  const command = args.join(" ");
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
    writable: true,
  });
  process.once("exit", () => {
    // Pi writes sessions lazily; like Pi, say nothing for a session that never reached disk.
    if (!existsSync(sessionFile)) return;
    try {
      process.stdout.write(`\u001b[2mTo resume this session:\u001b[22m\n${command}\n`);
    } catch {
      // The terminal may already be gone after SIGHUP.
    }
  });
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
        return {
          ...component,
          dispose() {
            if (refreshHeader === refresh) refreshHeader = undefined;
          },
        };
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
  pi.on("session_shutdown", (event, ctx) => {
    refreshHeader = undefined;
    backupState = undefined;
    terminalState = undefined;
    if (event?.reason === "quit" && ctx?.mode === "tui") replaceResumeHint(ctx.sessionManager);
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "Axon is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  pi.registerCommand("axon-hub", {
    description: "Open Axon Hub in your browser to manage MCP servers",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim()) {
        ctx.ui.notify("Usage: /axon-hub", "warning");
        return;
      }
      const relay = authRelayConfiguration();
      // The launcher serves the Hub only to the TUI and local RPC clients.
      if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || relay === undefined) {
        ctx.ui.notify("Run axon hub from a terminal to open Axon Hub.", "warning");
        return;
      }
      try {
        const response = await fetch(new URL("/_axon/hub/open", relay.origin), {
          method: "POST",
          headers: { Authorization: `Bearer ${relay.capability}` },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 204) {
          ctx.ui.notify("Axon Hub opened. Run /reload after saving MCP changes.", "info");
          return;
        }
        if (response.ok) {
          const { launchUrl } = (await response.json()) as { launchUrl?: unknown };
          if (
            typeof launchUrl === "string" &&
            /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/_axon\/hub\/#token=[a-f0-9]{64}$/.test(launchUrl)
          ) {
            ctx.ui.notify(
              `Could not open the browser. Open this private link manually: ${launchUrl}`,
              "warning",
            );
            return;
          }
        } else {
          await response.body?.cancel();
        }
      } catch {
        // Do not surface raw fetch errors or relay credentials in the TUI.
      }
      ctx.ui.notify("Could not open Axon Hub. Try axon hub from a terminal.", "warning");
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
