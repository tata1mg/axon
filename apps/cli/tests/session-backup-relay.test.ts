import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AxonPaths, resolveAxonPaths } from "../src/product/paths.ts";
import { resolveProjectAxonPaths } from "../src/product/project-paths.ts";
import { createBackupRelay } from "../src/sessions/relay.ts";

let root: string;
let shared: AxonPaths;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "axon-backup-relay-")));
  shared = resolveAxonPaths({ AXON_HOME: join(root, ".axon") }, root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function session(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "2026-11-13T00-00-00-000Z_session.jsonl");
  await writeFile(path, "{}\n");
  return path;
}

async function recordLeaf(paths: AxonPaths, source: string): Promise<number> {
  const relay = createBackupRelay(paths);
  const url = new URL("http://127.0.0.1/_axon/backups/leaf");
  const response = await relay(
    new Request(url.toString(), {
      method: "POST",
      body: JSON.stringify({
        source,
        nativeId: "session",
        resume: { leaf_known: false, selected_leaf_id: null },
        reason: "manual",
      }),
    }),
    url,
  );
  if (!response) throw new Error("relay did not handle the request");
  return response.status;
}

describe("backup relay session directory", () => {
  test("accepts sessions Pi writes directly to the flat root from a blocked directory", async () => {
    expect(await recordLeaf(shared, await session(shared.piSessions))).toBe(200);
  });

  test("rejects other projects' histories under the flat root", async () => {
    const nested = await session(join(shared.piSessions, "--other-project--"));
    expect(await recordLeaf(shared, nested)).toBe(503);
  });

  test("accepts only the project's own directory for project launches", async () => {
    const project = join(root, "repo");
    await mkdir(join(project, ".git"), { recursive: true });
    const paths = await resolveProjectAxonPaths(shared, project);
    if (!paths.piSessionDirectory) throw new Error("expected a project session directory");

    expect(await recordLeaf(paths, await session(paths.piSessionDirectory))).toBe(200);
    expect(await recordLeaf(paths, await session(shared.piSessions))).toBe(503);
    expect(await recordLeaf(paths, await session(join(shared.piSessions, "--other--")))).toBe(503);
  });
});
