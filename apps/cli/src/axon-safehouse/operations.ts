import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type { AxonSafehouseSession, LaunchSpec } from "../launcher/contracts.ts";
import { axonSafehouseFailure } from "./policy.ts";

const operationSchema = z.strictObject({
  tool: z.enum(["read", "write", "edit", "grep", "find", "ls", "shell"]),
  input: z.record(z.string(), z.unknown()),
  cwd: z.string().min(1).max(4096),
});
const shellSchema = z.strictObject({
  command: z.string().max(1024 * 1024),
  shellPath: z.string().min(1).max(4096).optional(),
  timeout: z.number().positive().max(2_147_483.647).optional(),
});

// This fixed program runs only inside sandbox-exec. No request can select a module or host argv.
// Use Pi's pinned native implementations so edits, images and structured results retain their semantics.
const FILE_TOOL_RUNNER = `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
const tools = await import(process.argv[1]);
const factories = {
  read: tools.createReadToolDefinition,
  write: tools.createWriteToolDefinition,
  edit: tools.createEditToolDefinition,
  grep: tools.createGrepToolDefinition,
  find: tools.createFindToolDefinition,
  ls: tools.createLsToolDefinition,
};
try {
  const tool = factories[request.tool](request.cwd);
  const result = await tool.execute("axon-operation", request.input, undefined, undefined, {
    cwd: request.cwd,
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "Axon Safehouse operation failed");
  process.exitCode = 1;
}
`;

/** The parent supplies the executable, environment and project; Pi can request only known operations. */
export function createAxonSafehouseOperations(
  axonSafehouse: AxonSafehouseSession,
  specification: LaunchSpec,
): (request: Request) => Promise<Response> {
  const node = Bun.which("node", { PATH: specification.environment["PATH"] ?? "/usr/bin:/bin" });
  let toolsModule: Promise<string> | undefined;
  let activeRequests = 0;
  // Preserve the native file-mutation queue across workers by serializing mutations in the parent.
  let mutations = Promise.resolve();

  return async (request) => {
    if (activeRequests >= 8)
      return Response.json(
        { error: "Too many concurrent Axon Safehouse operations" },
        { status: 429 },
      );
    activeRequests++;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) > 10 * 1024 * 1024)
        return Response.json({ error: "Axon Safehouse operation is too large" }, { status: 413 });
      const operation = operationSchema.parse(JSON.parse(text));
      const execute = async (): Promise<Response> => {
        request.signal.throwIfAborted();
        let executable: string;
        let argumentsVector: readonly string[];
        let stdin: string | undefined;
        let timeoutMs: number | undefined = 300_000;
        if (operation.tool === "shell") {
          const shell = shellSchema.parse(operation.input);
          executable = shell.shellPath ?? "/bin/bash";
          argumentsVector = ["-c", shell.command];
          timeoutMs = shell.timeout === undefined ? undefined : shell.timeout * 1000;
        } else {
          if (!node)
            throw axonSafehouseFailure("Node.js is required for Axon Safehouse file operations");
          toolsModule ??= realpath(specification.executable).then(
            (path) =>
              pathToFileURL(Bun.resolveSync("@earendil-works/pi-coding-agent", dirname(path))).href,
          );
          executable = node;
          argumentsVector = ["--input-type=module", "--eval", FILE_TOOL_RUNNER, await toolsModule];
          stdin = JSON.stringify(operation);
        }
        const result = await axonSafehouse.run(
          {
            executable,
            arguments: argumentsVector,
            // No caller-provided environment, relay capability or host credentials enter a worker.
            environment: specification.environment,
            cwd: operation.cwd,
          },
          {
            purpose: "operation",
            signal: request.signal,
            ...(stdin === undefined ? {} : { stdin }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
        );
        if (operation.tool === "shell")
          return Response.json(result, { headers: { "Cache-Control": "no-store" } });
        if (result.exitCode !== 0)
          throw new Error(result.stderr.slice(0, 8192) || "Axon Safehouse file operation failed");
        return Response.json(JSON.parse(result.stdout), {
          headers: { "Cache-Control": "no-store" },
        });
      };
      if (operation.tool !== "edit" && operation.tool !== "write") return await execute();
      const pending = mutations.then(execute);
      mutations = pending.then(
        () => {},
        () => {},
      );
      return await pending;
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Axon Safehouse operation failed" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      activeRequests--;
    }
  };
}
