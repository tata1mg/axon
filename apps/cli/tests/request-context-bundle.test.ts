import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const bundlePath = join(projectRoot, "src/harnesses/pi/resources/extensions/request-context.mjs");

test("embedded request-context bundle is deterministic and current", async () => {
  const child = Bun.spawn([process.execPath, "run", "request-context:check"], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" });
});

test("embedded request-context bundle includes shared workflow normalization and needs only Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "axon-request-context-bundle-"));
  try {
    const stub = join(root, "node_modules/@earendil-works/pi-coding-agent");
    await Bun.write(
      join(stub, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    await Bun.write(join(stub, "index.js"), 'export const VERSION = "test-pi";\n');
    const source = await Bun.file(bundlePath).text();
    expect(source).not.toContain(projectRoot);
    const isolated = join(root, "request-context.mjs");
    await Bun.write(isolated, source);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const module = await import(process.argv[1]);
       if (typeof module.default !== "function") throw new Error("Missing extension factory");
       console.log(JSON.stringify(module.buildRequestContext({}, {}, { AXON_WORKFLOW: " PR-Review " }).metadata("main")));`,
        isolated,
      ],
      {
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      pi_version: "test-pi",
      axon_workflow: "pr-review",
      call_kind: "main",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
