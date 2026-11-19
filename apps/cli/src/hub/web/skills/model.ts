// Pure My skills rules, shared by the page and unit tests. Types mirror ../../skills.ts.

export type SkillLocationId = "axon" | "agents";
export type LocalSkillStatus = "ok" | "not_loaded" | "shadowed";

export interface SkillLocation {
  readonly id: SkillLocationId;
  readonly path: string;
  readonly exists: boolean;
}

export interface LocalSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly location: SkillLocationId;
  readonly status: LocalSkillStatus;
  readonly problems: readonly string[];
  readonly modelInvocation: boolean;
}

export interface SkillsView {
  readonly locations: readonly SkillLocation[];
  readonly skills: readonly LocalSkill[];
  readonly truncated: boolean;
}

export const LOCATION_LABELS: Record<SkillLocationId, string> = {
  axon: "Axon",
  agents: "Agent Skills",
};

export type SkillFilter = "all" | "attention";

export function needsAttention(skill: LocalSkill): boolean {
  return skill.status !== "ok";
}

export function skillTag(
  skill: LocalSkill,
): { readonly label: string; readonly tone: "warn" | "muted" } | null {
  switch (skill.status) {
    case "not_loaded":
      return { label: "Not loaded", tone: "warn" };
    case "shadowed":
      return { label: "Overridden", tone: "muted" };
    default:
      return null;
  }
}

/** Alphabetical, keeping Pi's load order for skills that share a name. */
export function sortSkills(skills: readonly LocalSkill[]): LocalSkill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export function visibleSkills(skills: readonly LocalSkill[], filter: SkillFilter): LocalSkill[] {
  return sortSkills(filter === "attention" ? skills.filter(needsAttention) : skills);
}
