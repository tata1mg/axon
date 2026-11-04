import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-spawn-resize-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a detached TUI inside Axon Safehouse receives terminal resize signals", async () => {
  const ready = join(root, "ready");
  const child = join(root, "child.ts");
  // The fake TUI exits 0 only if Axon forwards the resize; otherwise it times out with 3.
  await Bun.write(
    child,
    `process.on("SIGWINCH", () => { console.log("resized"); process.exit(0); });
await Bun.write(${JSON.stringify(ready)}, "1");
setTimeout(() => process.exit(3), 5_000);
`,
  );
  const harness = join(root, "harness.ts");
  await Bun.write(
    harness,
    `import { existsSync } from "node:fs";
import { spawnHarness } from ${JSON.stringify(resolve(import.meta.dir, "../src/launcher/spawn-harness.ts"))};
const waitForChild = setInterval(() => {
  if (!existsSync(${JSON.stringify(ready)})) return;
  clearInterval(waitForChild);
  // A real terminal delivers SIGWINCH only to Axon's foreground process group.
  process.kill(process.pid, "SIGWINCH");
}, 20);
await spawnHarness({
  executable: process.execPath,
  arguments: [${JSON.stringify(child)}],
  cwd: ${JSON.stringify(root)},
  environment: { ...process.env },
  offline: true,
  // A revocable (brokered) session is what makes Pi run in its own detached session.
  revoked: new AbortController().signal,
});
`,
  );
  const run = Bun.spawn([process.execPath, harness], {
    cwd: root,
    env: { ...process.env, HOME: root, AXON_HOME: join(root, ".axon") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  expect({ exitCode, stdout: stdout.trim(), stderr: exitCode === 0 ? "" : stderr }).toEqual({
    exitCode: 0,
    stdout: "resized",
    stderr: "",
  });
}, 15_000);
