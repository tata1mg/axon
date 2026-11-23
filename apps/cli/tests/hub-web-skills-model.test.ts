import { expect, test } from "bun:test";

import {
  type LocalSkill,
  needsAttention,
  skillTag,
  sortSkills,
  visibleSkills,
} from "../src/hub/web/skills/model.ts";

function skill(name: string, status: LocalSkill["status"] = "ok"): LocalSkill {
  return {
    name,
    description: "Does things.",
    path: `/home/me/.axon/pi/skills/${name}/SKILL.md`,
    location: "axon",
    status,
    problems: [],
    modelInvocation: true,
  };
}

test("tags only skills Pi skips or overrides", () => {
  expect(skillTag(skill("a"))).toBeNull();
  expect(skillTag(skill("a", "not_loaded"))).toEqual({ label: "Not loaded", tone: "warn" });
  expect(skillTag(skill("a", "shadowed"))).toEqual({ label: "Overridden", tone: "muted" });
  expect(needsAttention(skill("a", "shadowed"))).toBe(true);
});

test("sorts by name and filters to the ones needing attention", () => {
  const skills = [skill("zeta"), skill("Alpha", "not_loaded"), skill("beta")];
  expect(sortSkills(skills).map(({ name }) => name)).toEqual(["Alpha", "beta", "zeta"]);
  expect(visibleSkills(skills, "attention").map(({ name }) => name)).toEqual(["Alpha"]);
  expect(visibleSkills(skills, "all")).toHaveLength(3);
});
