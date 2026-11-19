/**
 * Read-only list of the user-level skills Pi loads, for the hub's My skills page.
 *
 * Follows Pi's discovery (core/skills.js and collectSkillEntries in core/package-manager.js):
 * `~/.axon/pi/skills` first, then `~/.agents/skills`. A directory with `SKILL.md` is one skill and
 * is not searched further. Other `.md` files count only when their frontmatter has a description:
 * directly in the root for Pi's folder, below it for `.agents`. Dot entries and `node_modules` are
 * skipped, and the first skill with a given name wins.
 *
 * Not covered: `.gitignore`-style ignore files, skills from Pi packages and settings paths, and
 * project skills. Only frontmatter metadata leaves this module, never skill bodies.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type SkillLocationId = "axon" | "agents";

export interface SkillLocation {
  readonly id: SkillLocationId;
  readonly path: string;
  readonly exists: boolean;
}

export type LocalSkillStatus = "ok" | "not_loaded" | "shadowed";

export interface LocalSkill {
  readonly name: string;
  readonly description: string;
  /** The skill's `SKILL.md`, or its standalone Markdown file. */
  readonly path: string;
  readonly location: SkillLocationId;
  readonly status: LocalSkillStatus;
  /** Pi's validation warnings, and why it isn't loaded when `status` isn't `ok`. */
  readonly problems: readonly string[];
  /** False when `disable-model-invocation: true`: only `/skill:name` loads it. */
  readonly modelInvocation: boolean;
}

export interface SkillsView {
  readonly locations: readonly SkillLocation[];
  readonly skills: readonly LocalSkill[];
  /** The scan stopped at its limits; some skills may be missing. */
  readonly truncated: boolean;
}

const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;
const MAX_SKILLS = 500;
/** Frontmatter sits at the top; Pi's own limit for the whole file doesn't matter here. */
const FRONTMATTER_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export function skillLocations(piDirectory: string, userHome: string) {
  return [
    { id: "axon", path: join(piDirectory, "skills") },
    { id: "agents", path: join(userHome, ".agents", "skills") },
  ] as const satisfies readonly { id: SkillLocationId; path: string }[];
}

interface Scan {
  entries: number;
  truncated: boolean;
}

async function kindOf(path: string): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** Markdown candidates in Pi's order, before frontmatter is read. */
async function collect(
  directory: string,
  mode: SkillLocationId,
  root: string,
  depth: number,
  scan: Scan,
): Promise<string[]> {
  if (depth > MAX_DEPTH) {
    scan.truncated = true;
    return [];
  }
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return [];
  }
  scan.entries += names.length;
  if (scan.entries > MAX_ENTRIES) {
    scan.truncated = true;
    return [];
  }
  if (names.includes("SKILL.md") && (await kindOf(join(directory, "SKILL.md"))) === "file")
    return [join(directory, "SKILL.md")];
  const found: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(directory, name);
    const kind = await kindOf(path);
    if (kind === "directory") found.push(...(await collect(path, mode, root, depth + 1, scan)));
    else if (
      kind === "file" &&
      name.endsWith(".md") &&
      (mode === "axon" ? directory === root : directory !== root)
    )
      found.push(path);
  }
  return found;
}

function nameProblems(name: string): string[] {
  const problems: string[] = [];
  if (name.length > MAX_NAME_LENGTH)
    problems.push(`The name is over ${MAX_NAME_LENGTH} characters.`);
  if (!/^[a-z0-9-]+$/.test(name))
    problems.push("The name should use only lowercase letters, digits and hyphens.");
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    problems.push("The name shouldn't start or end with a hyphen, or repeat one.");
  return problems;
}

function frontmatter(content: string): Record<string, unknown> {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const parsed: unknown = Bun.YAML.parse(text.slice(4, end));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

type Candidate = Omit<LocalSkill, "status" | "location"> & { readonly loaded: boolean };

async function read(path: string): Promise<Candidate | undefined> {
  const declared = basename(path) === "SKILL.md";
  const fallbackName = basename(dirname(path));
  let fields: Record<string, unknown>;
  try {
    fields = frontmatter(await Bun.file(path).slice(0, FRONTMATTER_BYTES).text());
  } catch {
    if (!declared) return undefined;
    return {
      name: fallbackName,
      description: "",
      path,
      problems: ["The frontmatter isn’t valid YAML, so Pi doesn’t load this skill."],
      modelInvocation: true,
      loaded: false,
    };
  }
  const description = typeof fields["description"] === "string" ? fields["description"] : "";
  const hasDescription = description.trim() !== "";
  if (!declared && !hasDescription) return undefined;
  const name =
    (typeof fields["name"] === "string" && fields["name"]) ||
    (declared ? fallbackName : basename(path, ".md"));
  const problems = nameProblems(name);
  if (!hasDescription)
    problems.unshift("It has no description, so Pi doesn’t load it. Add one to the frontmatter.");
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    problems.push(`The description is over ${MAX_DESCRIPTION_LENGTH} characters.`);
  return {
    name,
    description: description.trim(),
    path,
    problems,
    modelInvocation: fields["disable-model-invocation"] !== true,
    loaded: hasDescription,
  };
}

async function exists(path: string): Promise<boolean> {
  return (await kindOf(path)) === "directory";
}

/** Every user-level skill in load order, including ones Pi skips, so they can be repaired. */
export async function listLocalSkills(
  locations: readonly { readonly id: SkillLocationId; readonly path: string }[],
): Promise<SkillsView> {
  const scan: Scan = { entries: 0, truncated: false };
  const skills: LocalSkill[] = [];
  const winners = new Map<string, LocalSkill>();
  const seen = new Set<string>();
  const views: SkillLocation[] = [];
  for (const location of locations) {
    const present = await exists(location.path);
    views.push({ ...location, exists: present });
    if (!present) continue;
    for (const path of await collect(location.path, location.id, location.path, 0, scan)) {
      if (skills.length >= MAX_SKILLS) {
        scan.truncated = true;
        break;
      }
      // The same file reached through a symlink is one skill, as in Pi.
      const real = await realpath(path).catch(() => path);
      if (seen.has(real)) continue;
      seen.add(real);
      const candidate = await read(path);
      if (!candidate) continue;
      const { loaded, ...fields } = candidate;
      const winner = loaded ? winners.get(candidate.name) : undefined;
      const skill: LocalSkill = winner
        ? {
            ...fields,
            location: location.id,
            status: "shadowed",
            problems: [
              `Pi loads the skill with this name from ${winner.path} instead.`,
              ...fields.problems,
            ],
          }
        : { ...fields, location: location.id, status: loaded ? "ok" : "not_loaded" };
      if (loaded && !winner) winners.set(skill.name, skill);
      skills.push(skill);
    }
  }
  return { locations: views, skills, truncated: scan.truncated };
}
