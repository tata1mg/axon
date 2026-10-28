/** Edit this list to add startup tips. Each launch shows one randomly selected tip. */
export const STARTUP_TIPS: readonly [string, ...string[]] = [
  "Use /yolo to toggle approval-free terminal commands for this session (if your policy allows it).",
  "Use /terminal-permissions to see your terminal mode and command restrictions.",
  "Use /review to review uncommitted changes, a branch, or a pull request.",
  "Use /hotkeys to see all keyboard shortcuts.",
  "Type ! before a command to run it directly in your terminal.",
];

export function randomStartupTip(random: () => number = Math.random): string {
  return STARTUP_TIPS[Math.floor(random() * STARTUP_TIPS.length)] ?? STARTUP_TIPS[0];
}
