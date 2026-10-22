import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as prompts from "@clack/prompts";

import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { AxonPaths } from "../../product/paths.ts";
import {
  canonicalPath,
  editFilesystemPreferences,
  type FilesystemOperation,
  type FilesystemPreferences,
  filesystemPreferencesPath,
  PI_STATE_DIRECTORIES,
  PI_STATE_FILES,
  readFilesystemPreferences,
  saveFilesystemPreferences,
  validateFilesystemProject,
} from "../../sandbox/filesystem.ts";
import { authorizeSandbox, type SandboxPolicy } from "../../sandbox/policy.ts";
import { formatHomePath } from "../../sessions/display.ts";

type SandboxMenuUI = Pick<
  typeof prompts,
  | "select"
  | "autocomplete"
  | "multiselect"
  | "text"
  | "confirm"
  | "intro"
  | "outro"
  | "cancel"
  | "note"
  | "spinner"
>;
type MenuAction =
  | "preview"
  | "mode"
  | "allow-read"
  | "allow-write"
  | "deny"
  | "manage"
  | "policy"
  | "save"
  | "discard";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update filesystem permissions";
}

export function formatFilesystemPermissions(
  paths: AxonPaths,
  project: string,
  preferences: FilesystemPreferences,
  policy?: SandboxPolicy,
): string {
  const lines = [
    `Project      ${formatHomePath(project)} (${preferences.projectMode})`,
    "",
    "Essential Pi state · baseline read/write",
    ...PI_STATE_FILES.map((filename) => `  ${formatHomePath(join(paths.pi, filename))} + lock`),
    ...PI_STATE_DIRECTORIES.map((directory) => `  ${formatHomePath(join(paths.pi, directory))}/`),
    "  Session history persists across projects; no temporary auth directory is used.",
    "",
  ];
  for (const [label, entries] of [
    ["Additional read-only paths", preferences.readPaths],
    ["Additional read/write paths", preferences.writePaths],
    ["Blocked paths", preferences.denyPaths],
  ] as const) {
    lines.push(
      label,
      ...(entries.length ? entries.map((path) => `  ${formatHomePath(path)}`) : ["  (none)"]),
      "",
    );
  }
  lines.push(
    "Read-only paths cannot be written through a broader read/write grant.",
    "Blocked and protected paths are excluded from every grant.",
    "Pi provider credentials are accessible to Pi; shared DeputyDev credentials are not.",
    "SSH, cloud and Keychain credentials remain protected.",
    "Managed packages and Axon resources remain read-only.",
    policy
      ? `Backend ${policy.policyId}: extra reads ${policy.allowAdditionalReadPaths ? "allowed" : "blocked"}, extra writes ${policy.allowAdditionalWritePaths ? "allowed" : "blocked"}, Git ${policy.localGit}.`
      : "Backend limits not loaded. Fresh authorization is still required when Pi starts.",
    ...(policy?.protectedPaths.length
      ? [
          "Backend-protected paths:",
          ...policy.protectedPaths.map((path) => `  ${formatHomePath(path)}`),
        ]
      : []),
    "Remote Git, network access and backend capabilities are not changed by this editor.",
    "Changes take effect in a new Pi process; /sandbox restarts automatically after saving.",
  );
  return lines.join("\n");
}

/** Browse without shell expansion; spaces are preserved and symlinks are checked when granting. */
async function browsePaths(
  project: string,
  ui: SandboxMenuUI,
  signal?: AbortSignal,
): Promise<string[] | symbol | undefined> {
  const cancellation = signal ? { signal } : {};
  let location = project;
  while (!signal?.aborted) {
    let directories: string[];
    try {
      directories = (await readdir(location, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      ui.note(errorMessage(error), "Cannot browse this directory");
      if (dirname(location) === location) return undefined;
      location = dirname(location);
      continue;
    }
    const choice = await ui.autocomplete<string>({
      ...cancellation,
      message: `Choose paths · ${formatHomePath(location)}`,
      placeholder: "Search directories, or choose Enter a path",
      maxItems: 9,
      options: [
        { value: "use", label: "Use this directory", hint: formatHomePath(location) },
        {
          value: "multiple",
          label: "Select multiple entries here",
          hint: "space selects; enter confirms",
        },
        { value: "parent", label: "↑ Parent directory" },
        {
          value: "manual",
          label: "Enter a file or directory path",
          hint: "absolute, relative to this directory, or ~/path",
        },
        { value: "back", label: "← Back" },
        ...directories
          .slice(0, 250)
          .map((name) => ({ value: join(location, name), label: `${name}/` })),
      ],
    });
    if (prompts.isCancel(choice)) return choice;
    if (choice === "back") return undefined;
    if (choice === "use") return [location];
    if (choice === "parent") {
      location = dirname(location);
      continue;
    }
    if (choice === "manual") {
      const path = await ui.text({
        ...cancellation,
        message: "File or directory path",
        placeholder: "~/projects/another-repository",
        validate: (value) => (value?.trim() ? undefined : "Enter a path."),
      });
      if (prompts.isCancel(path)) return path;
      return [await canonicalPath(path, location)];
    }
    if (choice === "multiple") {
      const entries = (await readdir(location, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
      if (!entries.length) {
        ui.note("This directory is empty.", "Choose paths");
        continue;
      }
      const selected = await ui.multiselect<string>({
        ...cancellation,
        message: `Select files/directories in ${formatHomePath(location)}`,
        required: false,
        options: entries.map((entry) => ({
          value: join(location, entry.name),
          label: `${entry.name}${entry.isDirectory() ? "/" : ""}`,
        })),
      });
      if (prompts.isCancel(selected)) return selected;
      return selected.length ? selected : undefined;
    }
    location = await canonicalPath(choice);
  }
}

export async function runSandboxMenu(
  paths: AxonPaths,
  cwd: string,
  ui: SandboxMenuUI = prompts,
  options: { readonly signal?: AbortSignal; readonly restartOnSave?: boolean } = {},
): Promise<boolean> {
  const { signal, restartOnSave = false } = options;
  signal?.throwIfAborted();
  const cancellation = signal ? { signal } : {};
  const invocation = currentPiInvocationEnvironment();
  if (invocation.ci || !invocation.stdinIsTty || !invocation.stdoutIsTty) {
    throw new LauncherError(
      "Interactive filesystem configuration requires a terminal",
      LAUNCHER_EXIT_STATUS.usage,
      {
        remediation:
          "Use axon sandbox show or sandbox allow-read/allow-write/deny/revoke/mode for scripts.",
      },
    );
  }
  const project = await validateFilesystemProject(paths, cwd);
  const original = await readFilesystemPreferences(paths, project);
  let draft = structuredClone(original);
  let policy: SandboxPolicy | undefined;
  const changed = () => JSON.stringify(draft) !== JSON.stringify(original);
  function cancelled(value: unknown): value is symbol {
    if (!prompts.isCancel(value)) return false;
    ui.cancel("Filesystem editor cancelled. No changes saved.");
    return true;
  }
  ui.intro("Axon · filesystem access policy");
  ui.note(
    formatFilesystemPermissions(paths, project, draft),
    "Project profile + essential Pi state",
  );
  while (!signal?.aborted) {
    const action = await ui.select<MenuAction>({
      ...cancellation,
      message: `${formatHomePath(project)} · ${draft.readPaths.length} read-only / ${draft.writePaths.length} read-write / ${draft.denyPaths.length} blocked${changed() ? " · unsaved" : ""}`,
      options: [
        { value: "preview", label: "Review filesystem policy" },
        { value: "mode", label: "Set project access", hint: draft.projectMode },
        {
          value: "allow-read",
          label: "Add read-only paths",
          hint: "browse/select multiple repositories or directories",
        },
        {
          value: "allow-write",
          label: "Add read/write paths",
          hint: "files here may be changed by the agent",
        },
        { value: "deny", label: "Block paths", hint: "exclude sensitive files or subdirectories" },
        { value: "manage", label: "Change or remove a path grant" },
        {
          value: "policy",
          label: "Inspect backend restrictions",
          hint: "requires your saved Axon login",
        },
        {
          value: "save",
          label: restartOnSave ? "Review, save and restart Axon" : "Review, save and exit",
        },
        { value: "discard", label: changed() ? "Discard changes and exit" : "Exit" },
      ],
    });
    if (cancelled(action)) return false;
    try {
      if (action === "preview") {
        ui.note(formatFilesystemPermissions(paths, project, draft, policy), "Requested policy");
      } else if (action === "policy") {
        const progress = ui.spinner(cancellation);
        progress.start("Fetching current backend restrictions");
        try {
          policy = (await authorizeSandbox(paths)).policy;
          progress.stop("Backend restrictions loaded (a snapshot; checked again at launch)");
          ui.note(
            formatFilesystemPermissions(paths, project, draft, policy),
            "Policy and backend restrictions",
          );
        } catch {
          policy = undefined;
          progress.error("Backend restrictions unavailable");
          ui.note(
            "You can edit local requests, but Pi will not launch without fresh backend authorization. Check your login and backend connectivity.",
            "Backend unavailable",
          );
        }
      } else if (action === "mode") {
        const mode = await ui.select<FilesystemPreferences["projectMode"]>({
          ...cancellation,
          message: "How may Pi access the project directory?",
          initialValue: draft.projectMode,
          options: [
            { value: "read-only", label: "Read-only", hint: "inspect files without changing them" },
            {
              value: "read-write",
              label: "Read/write",
              hint: "edit, create and remove project files",
            },
          ],
        });
        if (cancelled(mode)) return false;
        draft = await editFilesystemPreferences(paths, project, draft, "mode", mode);
      } else if (action === "allow-read" || action === "allow-write" || action === "deny") {
        if (
          (action === "allow-read" && policy?.allowAdditionalReadPaths === false) ||
          (action === "allow-write" && policy?.allowAdditionalWritePaths === false)
        ) {
          ui.note(
            "Your administrator does not allow this kind of additional grant.",
            "Backend restriction",
          );
          continue;
        }
        const selected = await browsePaths(project, ui, signal);
        if (cancelled(selected)) return false;
        if (selected)
          draft = await editFilesystemPreferences(paths, project, draft, action, selected);
      } else if (action === "manage") {
        const entries = [
          ...draft.readPaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: "read-only",
          })),
          ...draft.writePaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: "read/write",
          })),
          ...draft.denyPaths.map((path) => ({
            value: path,
            label: formatHomePath(path),
            hint: "blocked",
          })),
        ];
        if (!entries.length) {
          ui.note(
            "No additional path grants yet. Add read-only, read/write or blocked paths first.",
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
            { value: "allow-read", label: "Read-only" },
            { value: "allow-write", label: "Read/write" },
            { value: "deny", label: "Blocked" },
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
        // The complete draft is validated against loaded limits before it can be saved.
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
        ui.note(formatFilesystemPermissions(paths, project, draft, policy), "Review before saving");
        const save = await ui.confirm({
          ...cancellation,
          message: restartOnSave
            ? "Save these permissions and restart Axon now?"
            : "Save these permissions for this project?",
          initialValue: false,
        });
        if (cancelled(save)) return false;
        if (!save) continue;
        signal?.throwIfAborted();
        await saveFilesystemPreferences(paths, project, draft, original, policy);
        ui.outro(
          `Saved ${formatHomePath(await filesystemPreferencesPath(paths, project))}. ${restartOnSave ? "Restarting Axon…" : "Restart Pi to apply."}`,
        );
        return true;
      }
    } catch (error) {
      ui.note(errorMessage(error), "No changes saved");
    }
  }
  return false;
}
