/**
 * The hub side of the organization catalog: what's published, how each entry relates to
 * the user's config, and installing or updating an entry.
 *
 * Installs render from the hub's own copy of the published entry, fetched again at install
 * time. The browser sends only the slug, the revision it reviewed, and the values the
 * user typed; it can never supply the server definition itself. A revision that no longer
 * matches the current publication is a conflict.
 */
import { z } from "zod";

import type { AxonPaths } from "../product/paths.ts";
import { type CatalogFetcher, fetchPublishedCatalog } from "./catalog-client.ts";
import {
  extractInputs,
  fingerprint,
  inputPositions,
  renderServer,
  validateInputValues,
} from "./catalog-install.ts";
import { type InstallsFile, readInstalls, writeInstalls } from "./catalog-installs.ts";
import { type CatalogItem, type McpCatalogItem, SUPPORTED_SPECS } from "./catalog-schema.ts";
import { HubError } from "./errors.ts";
import type { LocalMcpStore, McpCatalog } from "./mcp-store.ts";

type JsonObject = Record<string, unknown>;

export type LocalState =
  | { readonly state: "not_installed" }
  | { readonly state: "name_in_use"; readonly name: string }
  | {
      readonly state: "installed" | "update_available" | "changed_locally";
      readonly name: string;
      readonly installedRevision: number;
      readonly changedLocally: boolean;
    };

export interface PrerequisiteStatus {
  readonly id: string;
  readonly found: boolean;
  readonly path?: string;
}

export type CatalogItemView = CatalogItem & {
  readonly local: LocalState;
  readonly prerequisiteStatus: readonly PrerequisiteStatus[];
};

export type CatalogView =
  | {
      readonly status: "ok";
      readonly items: readonly CatalogItemView[];
      readonly skipped: number;
      readonly configRevision: string;
    }
  | { readonly status: "signin_required" }
  | { readonly status: "unavailable"; readonly message: string };

const installSchema = z.strictObject({
  kind: z.literal("mcp"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  revision: z.number().int().min(1),
  configRevision: z.string().regex(/^(?:missing|[a-f0-9]{64})$/),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
  inputs: z.record(z.string().max(64), z.string().max(16_384)).default({}),
  confirmExecution: z.boolean().optional(),
});

export interface HubCatalogOptions {
  readonly skillsPreview: boolean;
  readonly fetcher?: CatalogFetcher;
  readonly serviceOrigin?: string;
  /** Looks an executable up on PATH; never runs it. */
  readonly which?: (executable: string) => string | null;
  readonly now?: () => Date;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aliasTaken(servers: JsonObject, name: string): boolean {
  const normalized = name.replaceAll("-", "_");
  return Object.keys(servers).some((existing) => existing.replaceAll("-", "_") === normalized);
}

export function localState(
  item: McpCatalogItem,
  servers: JsonObject,
  installs: InstallsFile,
): LocalState {
  const record = installs.mcp[item.slug];
  const entry = record ? servers[record.name] : undefined;
  if (record && isObject(entry)) {
    const changedLocally = fingerprint(entry, record.positions) !== record.fingerprint;
    const base = { name: record.name, installedRevision: record.revision, changedLocally };
    if (record.revision !== item.revision) return { state: "update_available", ...base };
    return { state: changedLocally ? "changed_locally" : "installed", ...base };
  }
  if (aliasTaken(servers, item.slug)) return { state: "name_in_use", name: item.slug };
  return { state: "not_installed" };
}

export class HubCatalog {
  private items: CatalogItem[] | undefined;

  constructor(
    private readonly paths: AxonPaths,
    private readonly store: LocalMcpStore,
    private readonly options: HubCatalogOptions,
  ) {}

  private get kinds(): Record<string, number> {
    return this.options.skillsPreview ? { ...SUPPORTED_SPECS } : { mcp: SUPPORTED_SPECS.mcp };
  }

  /** Fetch the current publication; the cached copy is dropped when it can't be seen. */
  private async refresh(): Promise<
    { readonly status: "ok"; readonly skipped: number } | Exclude<CatalogView, { status: "ok" }>
  > {
    const result = await fetchPublishedCatalog(this.paths, {
      kinds: this.kinds,
      ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
      ...(this.options.serviceOrigin ? { serviceOrigin: this.options.serviceOrigin } : {}),
    });
    if (result.status !== "ok") {
      // Never install from a copy the user can no longer see.
      this.items = undefined;
      return result;
    }
    this.items = result.items.filter((item) => item.kind === "mcp" || this.options.skillsPreview);
    return { status: "ok", skipped: result.skipped };
  }

  /** Fetch the published catalog again and describe it against the user's config. */
  async view(): Promise<CatalogView> {
    const result = await this.refresh();
    return result.status === "ok" ? this.describe(result.skipped) : result;
  }

  private async describe(skipped: number): Promise<CatalogView> {
    const { revision, servers } = await this.store.readServers();
    const installs = await readInstalls(this.paths.hubCatalogInstalls);
    const which = this.options.which ?? ((executable: string) => Bun.which(executable));
    const items = (this.items ?? []).map((item): CatalogItemView => {
      if (item.kind !== "mcp")
        return { ...item, local: { state: "not_installed" }, prerequisiteStatus: [] };
      return {
        ...item,
        local: localState(item, servers, installs),
        prerequisiteStatus: item.spec.prerequisites.map((prerequisite) => {
          if (!prerequisite.detect) return { id: prerequisite.id, found: false };
          const path = which(prerequisite.detect.executable);
          return path
            ? { id: prerequisite.id, found: true, path }
            : { id: prerequisite.id, found: false };
        }),
      };
    });
    return { status: "ok", items, skipped, configRevision: revision };
  }

  async install(body: unknown): Promise<CatalogView> {
    const parsed = installSchema.safeParse(body);
    if (!parsed.success) throw new HubError(400, "Invalid install request.");
    const request = parsed.data;
    // Revalidate against the current publication, not the last Discover fetch: an admin may
    // have withdrawn or superseded this entry while the install dialog was open.
    const current = await this.refresh();
    if (current.status === "signin_required")
      throw new HubError(409, "Your Axon session ended. Sign in again, then refresh.");
    if (current.status === "unavailable") throw new HubError(503, current.message);
    const item = this.items?.find(
      (entry): entry is McpCatalogItem => entry.kind === "mcp" && entry.slug === request.slug,
    );
    if (!item) throw new HubError(409, "This entry is no longer published. Refresh and try again.");
    if (item.revision !== request.revision)
      throw new HubError(
        409,
        "This entry changed in the catalog. Review the latest version and try again.",
      );
    const template = item.spec.server;
    if (!template)
      throw new HubError(400, "This entry has setup steps only. There's nothing to install.");

    const { servers } = await this.store.readServers();
    const installs = await readInstalls(this.paths.hubCatalogInstalls);
    const record = installs.mcp[item.slug];
    const previous = record ? servers[record.name] : undefined;
    const updating = record !== undefined && isObject(previous);
    const name = updating ? record.name : (request.name ?? item.slug);
    const kept = updating ? extractInputs(template, previous) : new Map<string, string>();
    const values = validateInputValues(item.spec.inputs, request.inputs, kept);
    const rendered = renderServer(template, values);
    const positions = inputPositions(template);

    await this.store.putEntry({
      revision: request.configRevision,
      name,
      rendered,
      replace: updating,
      confirmExecution: request.confirmExecution === true,
      afterWrite: async (entry) => {
        const url =
          typeof entry["url"] === "string" && !positions.includes("url") ? entry["url"] : undefined;
        // Re-read under the write lock: the copy read above may predate another write. Any
        // other record for this name is stale: that entry already left the config.
        const latest = await readInstalls(this.paths.hubCatalogInstalls);
        const others = Object.entries(latest.mcp).filter(([, other]) => other.name !== name);
        const next: InstallsFile = {
          schemaVersion: 1,
          mcp: {
            ...Object.fromEntries(others),
            [item.slug]: {
              name,
              revision: item.revision,
              fingerprint: fingerprint(entry, positions),
              positions,
              installedAt: (this.options.now?.() ?? new Date()).toISOString(),
              ...(url === undefined ? {} : { url }),
            },
          },
        };
        try {
          await writeInstalls(this.paths.hubCatalogInstalls, next);
        } catch (error) {
          if (error instanceof HubError) throw error;
          throw new HubError(
            500,
            "The server was added to your config, but the hub couldn't record its catalog revision.",
          );
        }
      },
    });
    return this.describe(0);
  }

  /** Mark servers installed from the catalog, and show the catalog URL the store would hide. */
  async annotate(catalog: McpCatalog): Promise<McpCatalog> {
    const installs = await readInstalls(this.paths.hubCatalogInstalls);
    const records = new Map(
      Object.entries(installs.mcp).map(([slug, record]) => [record.name, { slug, record }]),
    );
    if (records.size === 0) return catalog;
    const { servers: raw } = await this.store.readServers();
    return {
      ...catalog,
      servers: catalog.servers.map((server) => {
        const match = records.get(server.name);
        if (!match) return server;
        const entry = raw[server.name];
        const url =
          server.url === undefined &&
          match.record.url !== undefined &&
          isObject(entry) &&
          entry["url"] === match.record.url
            ? { url: match.record.url }
            : {};
        return {
          ...server,
          ...url,
          catalog: { slug: match.slug, revision: match.record.revision },
        };
      }),
    };
  }
}
