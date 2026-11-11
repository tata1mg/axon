import * as prompts from "@clack/prompts";
import colors from "picocolors";
import {
  editFilesystemPreferences,
  type FilesystemOperation,
  type FilesystemPreferences,
  readFilesystemPreferences,
  saveFilesystemPreferences,
  validateFilesystemProject,
} from "../../axon-safehouse/filesystem.ts";
import { blockedHostsSchema } from "../../axon-safehouse/network.ts";
import { type AxonSafehousePolicy, authorizeAxonSafehouse } from "../../axon-safehouse/policy.ts";
import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { formatHomePath } from "../../sessions/display.ts";

export type AxonSafehouseMenuUI = Pick<
  typeof prompts,
  "select" | "autocomplete" | "text" | "intro" | "outro" | "cancel" | "note"
>;
type MenuAction =
  | "mode"
  | "allow-read"
  | "allow-write"
  | "deny"
  | "manage"
  | "blocked-hosts"
  | "save"
  | "discard";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update Safehouse settings";
}

function formatFilesystemAccess(access: string | undefined): string {
  switch (access) {
    case "read-only":
      return colors.green(access);
    case "read-write":
    case "read/write":
      return colors.yellow("read/write");
    case "blocked":
      return colors.red(access);
    default:
      return colors.dim(access ?? "no explicit rule");
  }
}

export function formatFilesystemPermissions(
  project: string,
  preferences: FilesystemPreferences,
): string {
  const lines = [
    `${colors.bold("Project")}      ${colors.cyan(formatHomePath(project))} (${formatFilesystemAccess(preferences.projectMode)})`,
    colors.dim("Required runtime access is not listed."),
    "",
  ];
  for (const [label, entries, color] of [
    ["Additional read-only directories/files", preferences.readPaths, colors.green],
    ["Additional read/write directories/files", preferences.writePaths, colors.yellow],
    ["Blocked directories/files", preferences.denyPaths, colors.red],
  ] as const) {
    lines.push(
      colors.bold(color(label)),
      ...(entries.length
        ? entries.map((path) => `  ${color(formatHomePath(path))}`)
        : [colors.dim("  (none)")]),
      "",
    );
  }
  lines.push(
    colors.bold(colors.cyan("Network host blocklist (HTTP/HTTPS, best-effort)")),
    ...(preferences.blockedHosts.length
      ? preferences.blockedHosts.map((host) => `  ${colors.red(host)}`)
      : [colors.dim("  (none — all networking allowed)")]),
    colors.dim("Domains include subdomains. Only clients using the HTTP/HTTPS proxy are filtered."),
    colors.dim(
      "Direct sockets, SSH, UDP and clients ignoring proxy settings can bypass this list.",
    ),
    colors.dim("Local and remote Git have no separate restrictions; filesystem rules still apply."),
    "",
    colors.bold(colors.cyan("Rules and safeguards")),
    colors.dim("Read-only: The agent can read files, but cannot change them."),
    colors.dim("Read/write: The agent can read, edit, create and delete files."),
    colors.dim("Blocked: The agent cannot read or change these files or folders."),
    colors.dim(
      "Read-only rules override write grants; blocked/protected directories/files are excluded.",
    ),
    colors.dim("DeputyDev data, cloud credentials and Keychain are protected."),
    colors.dim("Git uses your normal configuration, credential helpers, SSH keys and SSH agent."),
    "",
    colors.bold(colors.cyan("Notes")),
    colors.dim(
      'After making any change in Axon Safehouse settings, select "Review changes and save".',
    ),
  );
  return lines.join("\n");
}

function formatFilesystemChanges(
  original: FilesystemPreferences,
  draft: FilesystemPreferences,
): string {
  const lines: string[] = [];
  if (original.projectMode !== draft.projectMode) {
    lines.push(
      `Project access: ${formatFilesystemAccess(original.projectMode)} → ${formatFilesystemAccess(draft.projectMode)}`,
    );
  }
  const pathRules = (preferences: FilesystemPreferences): Map<string, string> =>
    new Map([
      ...preferences.readPaths.map((path): [string, string] => [path, "read-only"]),
      ...preferences.writePaths.map((path): [string, string] => [path, "read/write"]),
      ...preferences.denyPaths.map((path): [string, string] => [path, "blocked"]),
    ]);
  const originalRules = pathRules(original);
  const draftRules = pathRules(draft);
  for (const path of new Set([...originalRules.keys(), ...draftRules.keys()])) {
    const previous = originalRules.get(path);
    const next = draftRules.get(path);
    if (previous !== next) {
      lines.push(
        `${formatHomePath(path)}: ${formatFilesystemAccess(previous)} → ${formatFilesystemAccess(next)}`,
      );
    }
  }
  for (const host of draft.blockedHosts) {
    if (!original.blockedHosts.includes(host))
      lines.push(`Block HTTP/HTTPS host: ${host} (including subdomains)`);
  }
  for (const host of original.blockedHosts) {
    if (!draft.blockedHosts.includes(host)) lines.push(`Remove HTTP/HTTPS host block: ${host}`);
  }
  if (lines.length === 0) return "No access changes; only rule ordering changed.";
  lines.push("", "Removing an explicit rule leaves parent grants and baseline access in effect.");
  return lines.join("\n");
}

export async function runAxonSafehouseMenu(
  paths: AxonPaths,
  cwd: string,
  ui: AxonSafehouseMenuUI = prompts,
  options: {
    readonly signal?: AbortSignal;
    /** Only the parent-owned RPC transport may provide a nonterminal UI. */
    readonly requireTerminal?: boolean;
    readonly authorize?: () => Promise<AxonSafehousePolicy>;
    readonly beforeSave?: () => Promise<void>;
  } = {},
): Promise<boolean> {
  const { signal } = options;
  signal?.throwIfAborted();
  const cancellation = signal ? { signal } : {};
  const invocation = currentPiInvocationEnvironment();
  if (
    options.requireTerminal !== false &&
    (invocation.ci || !invocation.stdinIsTty || !invocation.stdoutIsTty)
  ) {
    throw new LauncherError(
      "Interactive Safehouse configuration requires a terminal",
      LAUNCHER_EXIT_STATUS.usage,
      {
        remediation:
          "Start an interactive axon pi session and use /safehouse to save project permissions.",
      },
    );
  }
  const project = await validateFilesystemProject(paths, cwd);
  const original = await readFilesystemPreferences(paths, project);
  let draft = structuredClone(original);
  const changed = () => JSON.stringify(draft) !== JSON.stringify(original);
  function cancelled(value: unknown): value is symbol {
    if (!prompts.isCancel(value)) return false;
    ui.cancel("Safehouse editor cancelled. No changes saved.");
    return true;
  }
  ui.intro("Axon Safehouse · settings");
  ui.note(formatFilesystemPermissions(project, original), "Current Safehouse settings");
  while (!signal?.aborted) {
    const action = await ui.select<MenuAction>({
      ...cancellation,
      message: `Edit Safehouse settings${changed() ? colors.yellow(" · unsaved changes") : ""}`,
      options: [
        {
          value: "mode",
          label: "Set project access",
          hint: formatFilesystemAccess(draft.projectMode),
        },
        {
          value: "allow-read",
          label: colors.green("Add read-only directories/files"),
          hint: "allow the agent to inspect directories/files without changing them",
        },
        {
          value: "allow-write",
          label: colors.yellow("Add read/write directories/files"),
          hint: "allow the agent to edit, create and remove files",
        },
        {
          value: "deny",
          label: colors.red("Block directories/files"),
          hint: "exclude sensitive files or subdirectories",
        },
        { value: "manage", label: "Change or remove a directory/file rule" },
        {
          value: "blocked-hosts",
          label: "Edit network host blocklist",
          hint: `${draft.blockedHosts.length} blocked · HTTP/HTTPS proxy-aware clients only`,
        },
        {
          value: "save",
          label: "Review changes and save",
        },
        { value: "discard", label: changed() ? "← Back (discard changes)" : "← Back" },
      ],
    });
    if (cancelled(action)) return false;
    try {
      if (action === "mode") {
        const mode = await ui.select<FilesystemPreferences["projectMode"] | "back">({
          ...cancellation,
          message: "How may Pi access the project directory?",
          initialValue: draft.projectMode,
          options: [
            {
              value: "read-only",
              label: colors.green("Read-only"),
              hint: "inspect files without changing them",
            },
            {
              value: "read-write",
              label: colors.yellow("Read/write"),
              hint: "edit, create and remove project files",
            },
            { value: "back", label: "← Back" },
          ],
        });
        if (cancelled(mode)) return false;
        if (mode === "back") continue;
        draft = await editFilesystemPreferences(paths, project, draft, "mode", mode);
      } else if (action === "allow-read" || action === "allow-write" || action === "deny") {
        while (!signal?.aborted) {
          const entry = await ui.select<"enter" | "back">({
            ...cancellation,
            message:
              action === "deny"
                ? "Block directories/files"
                : action === "allow-read"
                  ? "Add read-only directories/files"
                  : "Add read/write directories/files",
            options: [
              { value: "enter", label: "Enter a directory/file" },
              { value: "back", label: "← Back" },
            ],
          });
          if (cancelled(entry)) return false;
          if (entry === "back") break;
          const selected = await ui.text({
            ...cancellation,
            message: "Enter a directory/file (leave empty to go back)",
            placeholder: "~/projects/another-repository",
          });
          if (cancelled(selected)) return false;
          if (!selected.trim()) continue;
          draft = await editFilesystemPreferences(paths, project, draft, action, selected);
        }
      } else if (action === "manage") {
        const entries = [
          ...draft.readPaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: formatFilesystemAccess("read-only"),
          })),
          ...draft.writePaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: formatFilesystemAccess("read/write"),
          })),
          ...draft.denyPaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: formatFilesystemAccess("blocked"),
          })),
        ];
        if (!entries.length) {
          ui.note(
            "No directory/file rules configured. Add read-only, read/write or blocked directories/files first.",
            "Directories/files",
          );
          continue;
        }
        while (!signal?.aborted) {
          const selected = await ui.autocomplete<string>({
            ...cancellation,
            message: "Which directory/file?",
            placeholder: "Search configured directories/files",
            maxItems: 8,
            options: [...entries, { value: "back", label: "← Back", hint: "" }],
          });
          if (cancelled(selected)) return false;
          if (selected === "back") break;
          const operation = await ui.select<Exclude<FilesystemOperation, "mode"> | "back">({
            ...cancellation,
            message: formatHomePath(selected),
            options: [
              { value: "allow-read", label: colors.green("Read-only") },
              { value: "allow-write", label: colors.yellow("Read/write") },
              { value: "deny", label: colors.red("Blocked") },
              {
                value: "revoke",
                label: "Remove explicit rule",
                hint: "parent grants and baseline access still apply",
              },
              { value: "back", label: "← Back" },
            ],
          });
          if (cancelled(operation)) return false;
          if (operation === "back") continue;
          // Drafts may temporarily conflict with backend policy while removing old grants.
          // The complete draft is validated against fresh backend limits before saving.
          draft = await editFilesystemPreferences(paths, project, draft, operation, selected);
          break;
        }
      } else if (action === "blocked-hosts") {
        ui.note(
          "Networking is allowed by default. Enter hostnames or IPs, separated by commas. Domains also block their subdomains. Leave empty to clear the list. This best-effort HTTP/HTTPS filter does not block direct sockets, SSH, UDP, or clients that ignore proxy settings.",
          "Optional network host blocklist",
        );
        const selected = await ui.text({
          ...cancellation,
          message: "Blocked hosts (empty = no restrictions)",
          initialValue: draft.blockedHosts.join(", "),
          placeholder: "example.com, telemetry.example.org",
          validate(value) {
            const entries = value?.trim() ? value.split(",").map((host) => host.trim()) : [];
            const parsed = blockedHostsSchema.safeParse(entries);
            return parsed.success ? undefined : parsed.error.issues[0]?.message;
          },
        });
        if (cancelled(selected)) return false;
        draft = {
          ...draft,
          blockedHosts: blockedHostsSchema.parse(
            selected.trim() ? selected.split(",").map((host) => host.trim()) : [],
          ),
        };
      } else if (action === "discard") {
        if (changed()) {
          const discard = await ui.select<"discard" | "back">({
            ...cancellation,
            message: "Discard all unsaved changes?",
            initialValue: "back",
            options: [
              { value: "discard", label: "Discard changes and return to chat" },
              { value: "back", label: "← Back", hint: "keep editing" },
            ],
          });
          if (cancelled(discard)) return false;
          if (discard === "back") continue;
        }
        ui.outro("No changes saved.");
        return false;
      } else if (action === "save") {
        if (!changed()) {
          ui.outro("No changes to save.");
          return false;
        }
        ui.note(formatFilesystemChanges(original, draft), "Review changes before saving");
        const save = await ui.select<"save" | "back">({
          ...cancellation,
          message: "Save these permissions for this project and apply them now?",
          initialValue: "back",
          options: [
            { value: "save", label: "Apply permissions" },
            { value: "back", label: "← Back", hint: "keep editing" },
          ],
        });
        if (cancelled(save)) return false;
        if (save === "back") continue;
        signal?.throwIfAborted();
        // Fetch current backend restrictions before committing any permissions.
        const currentPolicy = options.authorize
          ? await options.authorize()
          : (await authorizeAxonSafehouse(paths)).policy;
        signal?.throwIfAborted();
        await options.beforeSave?.();
        signal?.throwIfAborted();
        await saveFilesystemPreferences(paths, project, draft, original, currentPolicy);
        ui.outro(
          "Axon Safehouse permissions saved locally for this project. Restarting Pi to resume your chat safely.",
        );
        return true;
      }
    } catch (error) {
      ui.note(errorMessage(error), "No changes saved");
    }
  }
  return false;
}
