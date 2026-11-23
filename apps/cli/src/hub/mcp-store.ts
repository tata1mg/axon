import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { withFileLock } from "../launcher/file-lock.ts";
import type { AxonPaths } from "../product/paths.ts";
import { mergeEntry } from "./catalog-install.ts";
import { readInstalls, writeInstalls } from "./catalog-installs.ts";
import { HubError } from "./errors.ts";

export const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const textSchema = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"));
const nonemptyText = textSchema.refine((value) => value.trim().length > 0);
const exposureSchema = z.enum(["codemode", "deferred", "direct", "hidden"]);
const valuesSchema = z.record(z.string().min(1).max(256), textSchema.nullable());
const fieldsSchema = z.strictObject({
  command: nonemptyText.optional(),
  args: z.array(textSchema).max(256).optional(),
  cwd: textSchema.optional(),
  url: nonemptyText.optional(),
  env: valuesSchema.optional(),
  headers: valuesSchema.optional(),
  description: z.string().max(2048).optional(),
  enabled: z.boolean().optional(),
  exposure: exposureSchema.optional(),
  timeout: z.number().finite().positive().max(86400).optional(),
});
const revisionSchema = z.string().regex(/^(?:missing|[a-f0-9]{64})$/);
const createSchema = z.strictObject({
  revision: revisionSchema,
  name: nameSchema,
  definition: fieldsSchema,
  confirmExecution: z.boolean().optional(),
});
const updateSchema = z.strictObject({
  revision: revisionSchema,
  changes: fieldsSchema,
  confirmExecution: z.boolean().optional(),
});
const deleteSchema = z.strictObject({ revision: revisionSchema });

type Fields = z.infer<typeof fieldsSchema>;
type JsonObject = Record<string, unknown>;
interface Snapshot {
  readonly revision: string;
  readonly config: JsonObject;
  readonly servers: JsonObject;
}

export interface McpServerView {
  readonly name: string;
  readonly transport: "stdio" | "http" | "unknown";
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly requiresExecutionApproval: boolean;
  readonly description: string;
  readonly exposure: string;
  readonly command?: string;
  /** Credentials, query strings, and fragments make the entire URL write-only. */
  readonly url?: string;
  readonly hasStoredUrl: boolean;
  readonly argumentCount: number;
  readonly environmentKeys: readonly string[];
  readonly headerKeys: readonly string[];
  /** Set when this entry was installed from the organization catalog. */
  readonly catalog?: { readonly slug: string; readonly revision: number };
}

export interface McpCatalog {
  readonly revision: string;
  readonly configPath: string;
  readonly scope: "user";
  readonly servers: readonly McpServerView[];
  readonly reloadRequired: true;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HubError(400, "Invalid MCP configuration request.");
  return result.data;
}

function transport(definition: JsonObject): McpServerView["transport"] {
  if (typeof definition["command"] === "string" && definition["url"] === undefined) return "stdio";
  if (typeof definition["url"] === "string" && definition["command"] === undefined) return "http";
  return "unknown";
}

function requiresExecutionApproval(definition: JsonObject): boolean {
  const containsHelper = (value: unknown): boolean => {
    if (typeof value === "string") return value.trimStart().startsWith("!");
    return object(value) && Object.values(value).some(containsHelper);
  };
  return (
    transport(definition) === "stdio" ||
    ["env", "headers", "oauth", "auth"].some((key) => containsHelper(definition[key]))
  );
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !validUrl(value)) return undefined;
  const url = new URL(value);
  return url.username || url.password || url.search || url.hash ? undefined : value;
}

function view(name: string, value: unknown): McpServerView {
  const definition = object(value) ? value : {};
  const kind = transport(definition);
  const url = safeUrl(definition["url"]);
  return {
    name,
    transport: kind,
    enabled: definition["enabled"] !== false,
    editable: nameSchema.safeParse(name).success && kind !== "unknown",
    requiresExecutionApproval: requiresExecutionApproval(definition),
    description: typeof definition["description"] === "string" ? definition["description"] : "",
    exposure: typeof definition["exposure"] === "string" ? definition["exposure"] : "codemode",
    ...(kind === "stdio" ? { command: String(definition["command"]) } : {}),
    ...(url === undefined ? {} : { url }),
    hasStoredUrl: typeof definition["url"] === "string",
    argumentCount: Array.isArray(definition["args"]) ? definition["args"].length : 0,
    environmentKeys: object(definition["env"]) ? Object.keys(definition["env"]) : [],
    headerKeys: object(definition["headers"]) ? Object.keys(definition["headers"]) : [],
  };
}

function mergeValues(previous: unknown, updates: Record<string, string | null>): JsonObject {
  const result = object(previous) ? { ...previous } : {};
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) delete result[name];
    else Object.defineProperty(result, name, { value, enumerable: true, configurable: true });
  }
  return result;
}

function applyFields(previous: JsonObject, fields: Fields): JsonObject {
  const result: JsonObject = { ...previous, ...fields };
  if (fields.env !== undefined) result["env"] = mergeValues(previous["env"], fields.env);
  if (fields.headers !== undefined)
    result["headers"] = mergeValues(previous["headers"], fields.headers);
  return result;
}

function validateDefinition(definition: JsonObject): void {
  const kind = transport(definition);
  if (kind === "unknown") throw new HubError(400, "Specify either an executable or an HTTP URL.");
  if (kind === "stdio" && definition["type"] !== undefined && definition["type"] !== "stdio")
    throw new HubError(400, "This entry has an incompatible MCP transport type.");
  if (kind === "http") {
    if (!validUrl(String(definition["url"])))
      throw new HubError(400, "Use an http:// or https:// MCP URL.");
    if (
      definition["type"] !== undefined &&
      definition["type"] !== "http" &&
      definition["type"] !== "streamable-http"
    )
      throw new HubError(400, "This entry has an incompatible MCP transport type.");
  }
}

/** User-level configuration only. Never starts processes, expands env/!commands, or contacts servers. */
export class LocalMcpStore {
  readonly configPath: string;

  constructor(private readonly paths: AxonPaths) {
    this.configPath = join(paths.pi, "mcp.json");
  }

  private async checkDirectory(path: string, create: boolean): Promise<boolean> {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      const status = await lstat(path);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new HubError(
          422,
          "The MCP configuration directory is not a safe user-owned directory.",
        );
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async snapshot(): Promise<Snapshot> {
    if (
      !(await this.checkDirectory(this.paths.home, false)) ||
      !(await this.checkDirectory(this.paths.pi, false))
    )
      return { revision: "missing", config: {}, servers: {} };
    let file: Awaited<ReturnType<typeof open>>;
    try {
      // O_NONBLOCK also prevents a malicious FIFO from hanging the hub before fstat.
      file = await open(
        this.configPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if (missing(error)) return { revision: "missing", config: {}, servers: {} };
      throw new HubError(
        422,
        "The MCP configuration cannot be read safely. Check its type and permissions.",
      );
    }
    try {
      const status = await file.stat();
      if (
        !status.isFile() ||
        status.size > MAX_MCP_CONFIG_BYTES ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new HubError(
          422,
          "The MCP configuration must be a user-owned regular file of at most 1 MiB.",
        );
      // Bounded even if another writer grows the file after fstat.
      const buffer = Buffer.alloc(MAX_MCP_CONFIG_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes > MAX_MCP_CONFIG_BYTES)
        throw new HubError(422, "The MCP configuration exceeds 1 MiB.");
      const text = buffer.subarray(0, bytes).toString("utf8");
      let config: unknown;
      try {
        config = JSON.parse(text);
      } catch {
        throw new HubError(
          422,
          "mcp.json is not valid JSON. Repair it in an editor; the hub has not changed it.",
        );
      }
      if (!object(config) || (config["mcpServers"] !== undefined && !object(config["mcpServers"])))
        throw new HubError(
          422,
          "mcp.json must contain an object with an optional mcpServers object.",
        );
      return {
        revision: digest(text),
        config,
        servers: object(config["mcpServers"]) ? config["mcpServers"] : {},
      };
    } finally {
      await file.close();
    }
  }

  private catalog(snapshot: Snapshot): McpCatalog {
    return {
      revision: snapshot.revision,
      configPath: this.configPath,
      scope: "user",
      servers: Object.entries(snapshot.servers)
        .map(([name, definition]) => view(name, definition))
        .sort((a, b) => a.name.localeCompare(b.name)),
      reloadRequired: true,
    };
  }

  async list(): Promise<McpCatalog> {
    return this.catalog(await this.snapshot());
  }

  private async mutate(
    revision: string,
    operation: (servers: JsonObject) => JsonObject,
    afterWrite?: () => Promise<void>,
  ): Promise<McpCatalog> {
    await this.checkDirectory(this.paths.home, true);
    await this.checkDirectory(this.paths.pi, true);
    await this.checkDirectory(this.paths.locks, true);
    return withFileLock(join(this.paths.locks, "hub-mcp.lock"), async () => {
      const current = await this.snapshot();
      if (current.revision !== revision)
        throw new HubError(
          409,
          "MCP configuration changed elsewhere. Refresh before saving again.",
        );
      const servers = operation(current.servers);
      const config = { ...current.config, mcpServers: servers };
      const text = `${JSON.stringify(config, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_MCP_CONFIG_BYTES)
        throw new HubError(400, "The updated MCP configuration would exceed 1 MiB.");
      const temporary = join(this.paths.pi, `.mcp.${crypto.randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(text, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        // Also detect ordinary external-editor changes made while preparing this write.
        if ((await this.snapshot()).revision !== revision)
          throw new HubError(
            409,
            "MCP configuration changed elsewhere. Refresh before saving again.",
          );
        await rename(temporary, this.configPath);
      } finally {
        await rm(temporary, { force: true });
      }
      // Still under the lock, so records about this write can't interleave with another.
      await afterWrite?.();
      return this.catalog({ revision: digest(text), config, servers });
    });
  }

  /**
   * Drop catalog provenance recorded for `name`. Call only under the write lock, after the
   * entry left the config: a later, unrelated server under the same name must not inherit
   * it (Discover would offer to reset or update that server instead of reporting a collision).
   */
  private async forgetCatalogInstall(name: string, failure: string): Promise<void> {
    const installs = await readInstalls(this.paths.hubCatalogInstalls);
    const remaining = Object.entries(installs.mcp).filter(([, record]) => record.name !== name);
    if (remaining.length === Object.keys(installs.mcp).length) return;
    try {
      await writeInstalls(this.paths.hubCatalogInstalls, {
        ...installs,
        mcp: Object.fromEntries(remaining),
      });
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError(500, failure);
    }
  }

  /** Raw entries for the catalog service. Never sent to the browser as they are. */
  async readServers(): Promise<{ readonly revision: string; readonly servers: JsonObject }> {
    const { revision, servers } = await this.snapshot();
    return { revision, servers };
  }

  /**
   * Write one entry rendered from the catalog. A new install refuses a name in use; an
   * update replaces only catalog-managed fields and keeps the user's enabled state.
   */
  async putEntry(request: {
    readonly revision: string;
    readonly name: string;
    readonly rendered: JsonObject;
    readonly replace: boolean;
    readonly confirmExecution: boolean;
    readonly afterWrite: (entry: JsonObject) => Promise<void>;
  }): Promise<McpCatalog> {
    if (!revisionSchema.safeParse(request.revision).success)
      throw new HubError(400, "Invalid MCP configuration request.");
    if (!nameSchema.safeParse(request.name).success)
      throw new HubError(400, "Use a name of letters, digits, hyphens and underscores.");
    let written: JsonObject = {};
    return this.mutate(
      request.revision,
      (servers) => {
        const previous = servers[request.name];
        if (request.replace) {
          if (!object(previous))
            throw new HubError(
              409,
              "This server is no longer in your config. Refresh and install it again.",
            );
        } else {
          const normalized = request.name.replaceAll("-", "_");
          if (Object.keys(servers).some((name) => name.replaceAll("-", "_") === normalized))
            throw new HubError(
              409,
              "A server with this name (or its underscore alias) already exists.",
            );
        }
        written = mergeEntry(
          request.rendered,
          request.replace && object(previous) ? previous : undefined,
        );
        validateDefinition(written);
        if (requiresExecutionApproval(written) && !request.confirmExecution)
          throw new HubError(
            400,
            "Confirm that this MCP or its credential helpers can execute programs when Pi loads it.",
          );
        return { ...servers, [request.name]: written };
      },
      () => request.afterWrite(written),
    );
  }

  async create(input: unknown): Promise<McpCatalog> {
    const request = parse(createSchema, input);
    const definition = applyFields({}, request.definition);
    validateDefinition(definition);
    if (requiresExecutionApproval(definition) && request.confirmExecution !== true)
      throw new HubError(
        400,
        "Confirm that this MCP or its credential helpers can execute programs when Pi loads it.",
      );
    return this.mutate(
      request.revision,
      (servers) => {
        const normalized = request.name.replaceAll("-", "_");
        if (Object.keys(servers).some((name) => name.replaceAll("-", "_") === normalized))
          throw new HubError(
            409,
            "An MCP server with this name (or its underscore alias) already exists.",
          );
        return { ...servers, [request.name]: definition };
      },
      // A record left behind by an entry removed in an editor is stale by definition.
      () =>
        this.forgetCatalogInstall(
          request.name,
          "The server was added, but the hub couldn't clear an old catalog record for its name.",
        ),
    );
  }

  async update(name: string, input: unknown): Promise<McpCatalog> {
    const request = parse(updateSchema, input);
    return this.mutate(request.revision, (servers) => {
      if (!Object.hasOwn(servers, name)) throw new HubError(404, "MCP server not found.");
      const previous = servers[name];
      if (!object(previous))
        throw new HubError(422, "This entry must be repaired in an editor or removed.");
      const definition = applyFields(previous, request.changes);
      validateDefinition(definition);
      if (transport(previous) !== transport(definition))
        throw new HubError(400, "Remove and re-add a server to change its transport.");
      if (
        requiresExecutionApproval(definition) &&
        (request.changes.command !== undefined ||
          request.changes.args !== undefined ||
          request.changes.cwd !== undefined ||
          request.changes.env !== undefined ||
          request.changes.headers !== undefined ||
          request.changes.url !== undefined ||
          request.changes.enabled === true) &&
        request.confirmExecution !== true
      )
        throw new HubError(
          400,
          "Confirm that this MCP or its credential helpers can execute programs when Pi loads it.",
        );
      return { ...servers, [name]: definition };
    });
  }

  async remove(name: string, input: unknown): Promise<McpCatalog> {
    const request = parse(deleteSchema, input);
    return this.mutate(
      request.revision,
      (servers) => {
        if (!Object.hasOwn(servers, name)) throw new HubError(404, "MCP server not found.");
        const result = { ...servers };
        delete result[name];
        return result;
      },
      () =>
        this.forgetCatalogInstall(
          name,
          "The server was removed, but the hub couldn't clear its catalog record.",
        ),
    );
  }
}
