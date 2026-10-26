import * as prompts from "@clack/prompts";
import colors from "picocolors";

import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { AxonPaths } from "../../product/paths.ts";
import {
  editFilesystemPreferences,
  type FilesystemOperation,
  type FilesystemPreferences,
  readFilesystemPreferences,
  saveFilesystemPreferences,
  validateFilesystemProject,
} from "../../sandbox/filesystem.ts";
import { authorizeSandbox } from "../../sandbox/policy.ts";
import { formatHomePath } from "../../sessions/display.ts";

type SandboxMenuUI = Pick<
  typeof prompts,
  "select" | "autocomplete" | "text" | "confirm" | "intro" | "outro" | "cancel" | "note"
>;
type MenuAction = "mode" | "allow-read" | "allow-write" | "deny" | "manage" | "save" | "discard";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update filesystem permissions";
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
    colors.dim("Project/path rules only; required runtime access is not listed."),
    "",
  ];
  for (const [label, entries, color] of [
    ["Additional read-only paths", preferences.readPaths, colors.green],
    ["Additional read/write paths", preferences.writePaths, colors.yellow],
    ["Blocked paths", preferences.denyPaths, colors.red],
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
    colors.bold(colors.cyan("Rules and safeguards")),
    colors.dim("Read-only path rules override write grants; blocked/protected paths are excluded."),
    colors.dim("Built-in protected locations include DeputyDev, SSH, cloud and Keychain storage."),
    colors.dim("Managed packages and runtime code remain read-only during your chat."),
    colors.dim("Git and network restrictions are backend-managed and unchanged by this editor."),
    colors.yellow(
      "Saving requires fresh backend authorization and validation of filesystem rules.",
    ),
    colors.yellow(
      "Saving stops running file/shell operations; new operations use the saved rules.",
    ),
    colors.dim("Your chat continues without restarting. Settings reset when Axon exits."),
    colors.dim(
      "Settings stay in this process; they are not saved with chats or shared with other runs.",
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
  if (lines.length === 0) return "No access changes; only path rule ordering changed.";
  lines.push("", "Removing an explicit rule leaves parent grants and baseline access in effect.");
  return lines.join("\n");
}

export async function runSandboxMenu(
  paths: AxonPaths,
  cwd: string,
  ui: SandboxMenuUI = prompts,
  options: { readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  const { signal } = options;
  signal?.throwIfAborted();
  const cancellation = signal ? { signal } : {};
  const invocation = currentPiInvocationEnvironment();
  if (invocation.ci || !invocation.stdinIsTty || !invocation.stdoutIsTty) {
    throw new LauncherError(
      "Interactive filesystem configuration requires a terminal",
      LAUNCHER_EXIT_STATUS.usage,
      {
        remediation:
          "Start an interactive axon pi session and use /sandbox to edit temporary permissions.",
      },
    );
  }
  const project = await validateFilesystemProject(paths, cwd);
  const original = await readFilesystemPreferences(paths, project);
  let draft = structuredClone(original);
  const changed = () => JSON.stringify(draft) !== JSON.stringify(original);
  function cancelled(value: unknown): value is symbol {
    if (!prompts.isCancel(value)) return false;
    ui.cancel("Filesystem editor cancelled. No changes saved.");
    return true;
  }
  ui.intro("Axon · sandbox settings");
  ui.note(formatFilesystemPermissions(project, original), "Current filesystem permissions");
  while (!signal?.aborted) {
    const action = await ui.select<MenuAction>({
      ...cancellation,
      message: `Edit filesystem rules${changed() ? colors.yellow(" · unsaved changes") : ""}`,
      options: [
        {
          value: "mode",
          label: "Set project access",
          hint: formatFilesystemAccess(draft.projectMode),
        },
        {
          value: "allow-read",
          label: colors.green("Add read-only paths"),
          hint: "enter a file or directory path",
        },
        {
          value: "allow-write",
          label: colors.yellow("Add read/write paths"),
          hint: "allow the agent to edit, create and remove files",
        },
        {
          value: "deny",
          label: colors.red("Block paths"),
          hint: "exclude sensitive files or subdirectories",
        },
        { value: "manage", label: "Change or remove a path rule" },
        {
          value: "save",
          label: "Review changes and save",
        },
        { value: "discard", label: changed() ? "Discard changes and exit" : "Exit" },
      ],
    });
    if (cancelled(action)) return false;
    try {
      if (action === "mode") {
        const mode = await ui.select<FilesystemPreferences["projectMode"]>({
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
          ],
        });
        if (cancelled(mode)) return false;
        draft = await editFilesystemPreferences(paths, project, draft, "mode", mode);
      } else if (action === "allow-read" || action === "allow-write" || action === "deny") {
        const selected = await ui.text({
          ...cancellation,
          message: "Enter a file or directory path",
          placeholder: "~/projects/another-repository",
          validate: (value) => (value?.trim() ? undefined : "Enter a path."),
        });
        if (cancelled(selected)) return false;
        draft = await editFilesystemPreferences(paths, project, draft, action, selected);
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
            "No path rules configured. Add read-only, read/write or blocked paths first.",
            "Paths",
          );
          continue;
        }
        const selected = await ui.autocomplete<string>({
          ...cancellation,
          message: "Which path?",
          placeholder: "Search configured paths",
          maxItems: 8,
          options: [...entries, { value: "back", label: "← Back", hint: "" }],
        });
        if (cancelled(selected)) return false;
        if (selected === "back") continue;
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
        // Drafts may temporarily conflict with backend policy while removing old grants.
        // The complete draft is validated against fresh backend limits before saving.
        if (operation !== "back")
          draft = await editFilesystemPreferences(paths, project, draft, operation, selected);
      } else if (action === "discard") {
        if (changed()) {
          const discard = await ui.confirm({
            ...cancellation,
            message: "Discard all unsaved changes?",
            initialValue: false,
          });
          if (cancelled(discard)) return false;
          if (!discard) continue;
        }
        ui.outro("No changes saved.");
        return false;
      } else if (action === "save") {
        if (!changed()) {
          ui.outro("No changes to save.");
          return false;
        }
        ui.note(formatFilesystemChanges(original, draft), "Review changes before saving");
        const save = await ui.confirm({
          ...cancellation,
          message: "Apply these permissions now, until Axon exits?",
          initialValue: false,
        });
        if (cancelled(save)) return false;
        if (!save) continue;
        signal?.throwIfAborted();
        // Fetch current backend restrictions before committing any permissions.
        const currentPolicy = (await authorizeSandbox(paths)).policy;
        signal?.throwIfAborted();
        await saveFilesystemPreferences(paths, project, draft, original, currentPolicy);
        ui.outro(
          "Sandbox permissions applied for this Axon run. Your chat continues without restarting.",
        );
        return true;
      }
    } catch (error) {
      ui.note(errorMessage(error), "No changes saved");
    }
  }
  return false;
}
