import type { SandboxResumeSession } from "../../launcher/contracts.ts";

// Mirror the pinned Pi CLI's value consumption so option values cannot become prompts.
const VALUE_OPTIONS = new Set([
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--tui-mode",
]);
const BOOLEAN_OPTIONS = new Set([
  "--no-session",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);
const SESSION_OPTIONS = new Set(["--session", "--session-id", "--fork"]);
const SESSION_SWITCHES = new Set(["--continue", "-c", "--resume", "-r"]);
// A persisted session owns its current model, thinking level and user-visible name.
const STARTUP_VALUE_OPTIONS = new Set(["--provider", "--model", "--thinking", "--name", "-n"]);

/** Retain launch options, not startup messages/files, and resume exactly the current session. */
export function piRestartArguments(
  original: readonly string[],
  session: SandboxResumeSession,
): readonly string[] {
  const retained: string[] = [];
  for (let index = 0; index < original.length; index++) {
    const argument = original[index];
    if (argument === undefined || argument === "--") break;
    if (
      SESSION_OPTIONS.has(argument) ||
      (session.sessionFile && STARTUP_VALUE_OPTIONS.has(argument))
    ) {
      index++;
      continue;
    }
    if (SESSION_SWITCHES.has(argument)) continue;
    if (!argument.startsWith("-")) continue;
    retained.push(argument);
    if (BOOLEAN_OPTIONS.has(argument)) continue;
    const next = original[index + 1];
    const extensionValue =
      argument.startsWith("--") &&
      !argument.includes("=") &&
      next !== undefined &&
      !next.startsWith("-") &&
      !next.startsWith("@");
    if (next !== undefined && (VALUE_OPTIONS.has(argument) || extensionValue)) {
      retained.push(next);
      index++;
    }
  }
  return [
    ...retained,
    ...(session.sessionFile
      ? ["--session", session.sessionFile]
      : ["--session-id", session.sessionId]),
  ];
}
