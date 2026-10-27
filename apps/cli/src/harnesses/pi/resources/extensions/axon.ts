import { homedir } from "node:os";
import {
  type AppKeybinding,
  type ExtensionAPI,
  type ExtensionContext,
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
    const title = theme.bold(theme.fg("accent", "Axon")) + theme.fg("dim", version);
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
const AUTH_POLL_INTERVAL_MS = 1_000;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;

const LOGIN_CHOICE = "Login from browser";

interface RecoveryStatus {
  readonly id: string;
  readonly state: "required" | "logging-in";
  readonly expiresAt: number;
}

function isRequiredRecovery(
  recovery: Partial<RecoveryStatus> | null | undefined,
): recovery is RecoveryStatus {
  return (
    recovery?.state === "required" &&
    typeof recovery.id === "string" &&
    typeof recovery.expiresAt === "number"
  );
}

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

/** Polling runs independently of Pi's model request, which the relay can pause for login. */
function watchSessionRecovery(ctx: ExtensionContext): () => void {
  const config = authRelayConfiguration();
  if (!ctx.hasUI || config === undefined) return () => {};

  // Pi's RPC protocol cannot retract a dialog: an aborted or timed-out select leaves a dead
  // card in the client (Paseo ignores the timeout). RPC therefore keeps one card per session
  // and applies the answer to whichever recovery is pending when it arrives.
  const rpc = ctx.mode === "rpc";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handledRecovery: string | undefined;
  let activePrompt: { id: string; controller: AbortController } | undefined;
  let busy = false;

  const authRequest = (action: string, method = "GET", id?: string): Promise<Response> => {
    const url = new URL(`/_axon/auth/${action}`, config.origin);
    if (id !== undefined) url.searchParams.set("id", id);
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.capability}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(action === "login" ? 5 * 60_000 : AUTH_REQUEST_TIMEOUT_MS),
      ]),
    });
  };

  /** Undefined means the status could not be read; null means no login is pending. */
  const readRecovery = async (): Promise<Partial<RecoveryStatus> | null | undefined> => {
    const response = await authRequest("status");
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    return (payload as { recovery?: Partial<RecoveryStatus> | null } | null)?.recovery ?? null;
  };

  const offerLogin = async (offered: RecoveryStatus): Promise<void> => {
    const promptController = new AbortController();
    activePrompt = { id: offered.id, controller: promptController };
    const signal = rpc
      ? controller.signal
      : AbortSignal.any([
          controller.signal,
          promptController.signal,
          ...(ctx.signal === undefined ? [] : [ctx.signal]),
        ]);
    let recovery: RecoveryStatus | undefined = offered;
    ctx.ui.setStatus("axon-auth", "Session expired — login required");
    try {
      const choice = await ctx.ui.select(
        "Your Axon session expired. Sign in to continue this chat.",
        [LOGIN_CHOICE, "Not now (keep chat open)"],
        rpc ? { signal } : { signal, timeout: Math.max(1, offered.expiresAt - Date.now()) },
      );
      activePrompt = undefined;
      if (rpc && !signal.aborted) {
        const current = await readRecovery();
        recovery = isRequiredRecovery(current) ? current : undefined;
        if (recovery !== undefined) handledRecovery = recovery.id;
      }
      if (recovery === undefined) {
        if (choice === LOGIN_CHOICE) {
          ctx.ui.notify(
            "That sign-in request is no longer active. Send your message again to retry.",
            "info",
          );
        }
        return;
      }
      if (choice !== LOGIN_CHOICE || signal.aborted) {
        await authRequest("cancel", "POST", recovery.id);
        if (!controller.signal.aborted) {
          ctx.ui.notify(
            "Login cancelled. Your chat is still open; sign in and retry when ready.",
            "warning",
          );
        }
        return;
      }
      ctx.ui.setStatus("axon-auth", "Waiting for browser login…");
      ctx.ui.notify(
        "Complete login in your browser. This chat will continue after approval.",
        "info",
      );
      const response = await authRequest("login", "POST", recovery.id);
      const payload: unknown = await response.json();
      const authenticated =
        response.ok &&
        payload !== null &&
        typeof payload === "object" &&
        "authenticated" in payload &&
        payload.authenticated === true;
      if (!controller.signal.aborted) {
        ctx.ui.notify(
          authenticated
            ? "Signed in. Continuing your chat…"
            : "Login failed or timed out. Your chat is still open; retry to sign in again.",
          authenticated ? "info" : "warning",
        );
      }
    } catch {
      if (!controller.signal.aborted) {
        if (recovery !== undefined) {
          await authRequest("cancel", "POST", recovery.id).catch(() => {});
        }
        ctx.ui.notify(
          "Login could not complete. Your chat is still open; retry when ready.",
          "warning",
        );
      }
    } finally {
      activePrompt = undefined;
      ctx.ui.setStatus("axon-auth", undefined);
    }
  };

  const poll = async (): Promise<void> => {
    try {
      const recovery = await readRecovery();
      if (recovery === undefined) return;
      // Dismiss a stale dialog if Pi cancelled the waiting request or its deadline elapsed.
      if (!rpc && activePrompt !== undefined && activePrompt.id !== recovery?.id) {
        activePrompt.controller.abort();
      }
      if (!busy && isRequiredRecovery(recovery) && recovery.id !== handledRecovery) {
        handledRecovery = recovery.id;
        busy = true;
        void offerLogin(recovery).finally(() => {
          busy = false;
        });
      }
    } catch {
      // A transient loopback failure must not interrupt the chat or spam notifications.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), AUTH_POLL_INTERVAL_MS);
    }
  };
  void poll();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    ctx.ui.setStatus("axon-auth", undefined);
  };
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

  let stopRecovery: (() => void) | undefined;
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
    stopRecovery?.();
    stopRecovery = watchSessionRecovery(ctx);
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
  pi.on("session_shutdown", () => {
    refreshHeader = undefined;
    backupState = undefined;
    terminalState = undefined;
    stopRecovery?.();
    stopRecovery = undefined;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "Axon is active";
    return new Text(theme.fg("accent", message), 1, 0);
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
