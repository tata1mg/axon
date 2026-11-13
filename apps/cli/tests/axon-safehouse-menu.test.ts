import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFilesystemPreferences } from "../src/axon-safehouse/filesystem.ts";
import type { AxonSafehousePolicy } from "../src/axon-safehouse/policy.ts";
import {
  type AxonSafehouseMenuUI,
  runAxonSafehouseMenu,
} from "../src/cli/commands/axon-safehouse.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axon-safehouse-menu-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Answers prompts in order; records notes so tests can assert what the user was shown. */
function scriptedUI(answers: unknown[]) {
  const notes: string[] = [];
  const next = async () => {
    if (!answers.length) throw new Error("Menu asked more questions than the test scripted");
    return answers.shift();
  };
  const ui = {
    select: next,
    autocomplete: next,
    text: next,
    intro: () => {},
    outro: () => {},
    cancel: () => {},
    note: (message?: string) => {
      notes.push(message ?? "");
    },
  } as unknown as AxonSafehouseMenuUI;
  return { ui, notes };
}

test("relative menu paths resolve from the launch directory, not the checkout root", async () => {
  const paths = resolveAxonPaths({ HOME: join(root, "home") });
  const repository = join(root, "repo");
  const launch = join(repository, "packages", "api");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(launch, { recursive: true });
  const policy = {
    allowAdditionalReadPaths: true,
    allowAdditionalWritePaths: true,
    readPaths: [],
    writePaths: [],
  } as unknown as AxonSafehousePolicy;

  const { ui, notes } = scriptedUI(["deny", "enter", ".env", "back", "save", "save"]);
  const saved = await runAxonSafehouseMenu(paths, launch, ui, {
    requireTerminal: false,
    authorize: async () => policy,
  });

  expect(saved).toBe(true);
  const preferences = await readFilesystemPreferences(paths, launch);
  expect(preferences.denyPaths).toEqual([join(launch, ".env")]);
  expect(preferences.denyPaths).not.toContain(join(repository, ".env"));
  expect(notes.some((note) => note.includes(join("packages", "api", ".env")))).toBe(true);
});

test("the menu lists startup backend grants without another policy request", async () => {
  const paths = resolveAxonPaths({ HOME: join(root, "home") });
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  let authorizations = 0;

  const { ui, notes } = scriptedUI(["discard"]);
  await runAxonSafehouseMenu(paths, project, ui, {
    requireTerminal: false,
    authorize: async () => {
      authorizations++;
      throw new Error("opening the editor must not refetch policy");
    },
    displayPolicy: { readPaths: ["~/shared-libs"], writePaths: ["/opt/axon-output"] },
  });

  const shown = Bun.stripANSI(notes[0] ?? "");
  expect(authorizations).toBe(0);
  expect(shown).toContain("Managed by your administrator");
  expect(shown).toContain("~/shared-libs (read-only)");
  expect(shown).toContain("/opt/axon-output (read/write)");
});

test("the menu omits the administrator section without backend grants", async () => {
  const paths = resolveAxonPaths({ HOME: join(root, "home") });
  const project = join(root, "project");
  await mkdir(project, { recursive: true });

  const { ui, notes } = scriptedUI(["discard"]);
  await runAxonSafehouseMenu(paths, project, ui, {
    requireTerminal: false,
    displayPolicy: { readPaths: [], writePaths: [] },
  });

  expect(notes[0]).not.toContain("Managed by your administrator");
});
