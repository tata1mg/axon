import { homedir } from "node:os";

import type { AxonPaths } from "../product/paths.ts";
import hubCss from "./assets/hub.css" with { type: "text" };
import hubJs from "./assets/hub.js" with { type: "text" };
import { HubBrowserSession } from "./browser-session.ts";
import { HubCatalog, type HubCatalogOptions } from "./catalog.ts";
import { HubError } from "./errors.ts";
import { HUB_SKILLS_PREVIEW } from "./features.ts";
import { LocalMcpStore } from "./mcp-store.ts";
import { listLocalSkills, skillLocations } from "./skills.ts";
import hubHtml from "./web/index.html" with { type: "text" };

const BASE = "/_axon/hub";
export const MAX_HUB_REQUEST_BYTES = 64 * 1024;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function secure(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

async function json(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new HubError(415, "Send an application/json request.");
  const reader = request.body?.getReader();
  if (!reader) throw new HubError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HUB_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HubError(413, "The hub request exceeds 64 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError(400, "The request body is not valid JSON.");
  }
}

export interface LocalHub {
  readonly origin: string;
  /** Single-use, short-lived bootstrap link. Do not persist or send to telemetry. */
  readonly launchUrl: string;
  stop(): Promise<void>;
}

export interface LocalHubOptions extends Partial<Omit<HubCatalogOptions, "now">> {
  readonly now?: () => number;
  readonly catalogEnabled?: boolean;
  /** Where `~/.agents/skills` is looked up. Defaults to the OS user's home. */
  readonly userHome?: string;
}

/**
 * Separate loopback listener: no model forwarding, filesystem browsing, or arbitrary
 * commands. Its only outbound request is the read-only catalog GET. The only files it reads
 * outside Pi's MCP config are skill frontmatter in the two user-level skill folders.
 */
export function startLocalHub(paths: AxonPaths, options: LocalHubOptions = {}): LocalHub {
  const session = new HubBrowserSession(options.now);
  const mcps = new LocalMcpStore(paths);
  const skills = skillLocations(paths.pi, options.userHome ?? (process.env["HOME"] || homedir()));
  const catalogEnabled = options.catalogEnabled !== false;
  const skillsPreview = catalogEnabled && (options.skillsPreview ?? HUB_SKILLS_PREVIEW);
  const catalog = new HubCatalog(paths, mcps, {
    skillsPreview,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.serviceOrigin ? { serviceOrigin: options.serviceOrigin } : {}),
    ...(options.which ? { which: options.which } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 15,
    maxRequestBodySize: MAX_HUB_REQUEST_BYTES,
    error() {
      return secure(
        Response.json({ error: "The hub could not process this request safely." }, { status: 500 }),
      );
    },
    async fetch(request, server) {
      try {
        const url = new URL(request.url);
        // Exact authority checks prevent alternate Host headers and DNS rebinding.
        if (url.origin !== server.url.origin || request.headers.get("host") !== server.url.host)
          throw new HubError(403, "This hub accepts only its own loopback address.");
        const origin = request.headers.get("origin");
        const site = request.headers.get("sec-fetch-site");
        if (
          (origin !== null && origin !== server.url.origin) ||
          (site !== null && site !== "same-origin" && site !== "none")
        )
          throw new HubError(403, "Cross-origin hub requests are not allowed.");
        if (url.search) throw new HubError(404, "Hub endpoint not found.");
        const assets: Record<string, readonly [string, string]> = {
          [`${BASE}/`]: [hubHtml as unknown as string, "text/html; charset=utf-8"],
          [`${BASE}/hub.js`]: [hubJs, "text/javascript; charset=utf-8"],
          [`${BASE}/hub.css`]: [hubCss, "text/css; charset=utf-8"],
        };
        const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
        if (asset && (request.method === "GET" || request.method === "HEAD"))
          return secure(
            new Response(request.method === "HEAD" ? null : asset[0], {
              headers: { "Content-Type": asset[1] },
            }),
          );
        if (!url.pathname.startsWith(`${BASE}/api/`))
          throw new HubError(404, "Hub endpoint not found.");
        const mutation = request.method !== "GET";
        if (mutation && origin !== server.url.origin)
          throw new HubError(403, "A same-origin hub request is required.");
        if (url.pathname === `${BASE}/api/session` && request.method === "POST") {
          const body = await json(request);
          const token =
            body && typeof body === "object" && "token" in body ? body.token : undefined;
          const result = session.exchange(token);
          return secure(
            Response.json(
              { csrfToken: result.csrfToken },
              { headers: { "Set-Cookie": result.cookie } },
            ),
          );
        }
        const csrfToken = session.authenticate(request, mutation);
        if (url.pathname === `${BASE}/api/session` && request.method === "GET")
          return secure(
            Response.json({
              schemaVersion: 1,
              csrfToken,
              features: {
                localMcps: true,
                localSkills: true,
                catalog: catalogEnabled,
                skills: skillsPreview,
              },
              scope: "user",
            }),
          );
        if (catalogEnabled) {
          if (url.pathname === `${BASE}/api/catalog` && request.method === "GET")
            return secure(Response.json(await catalog.view()));
          if (url.pathname === `${BASE}/api/catalog/install` && request.method === "POST")
            return secure(Response.json(await catalog.install(await json(request))));
        }
        if (url.pathname === `${BASE}/api/skills` && request.method === "GET")
          return secure(Response.json(await listLocalSkills(skills)));
        if (url.pathname === `${BASE}/api/mcps`) {
          if (request.method === "GET")
            return secure(Response.json(await catalog.annotate(await mcps.list())));
          if (request.method === "POST")
            return secure(Response.json(await mcps.create(await json(request)), { status: 201 }));
        }
        const match = new RegExp(`^${BASE}/api/mcps/([^/]+)$`).exec(url.pathname);
        if (match?.[1]) {
          let name: string;
          try {
            name = decodeURIComponent(match[1]);
          } catch {
            throw new HubError(400, "Invalid MCP server name.");
          }
          if (request.method === "PATCH")
            return secure(Response.json(await mcps.update(name, await json(request))));
          if (request.method === "DELETE")
            return secure(Response.json(await mcps.remove(name, await json(request))));
        }
        throw new HubError(404, "Hub endpoint not found.");
      } catch (error) {
        return secure(
          Response.json(
            {
              error:
                error instanceof HubError
                  ? error.message
                  : "The hub could not access MCP configuration safely. Check local permissions and retry.",
            },
            { status: error instanceof HubError ? error.status : 500 },
          ),
        );
      }
    },
  });
  return {
    origin: server.url.origin,
    launchUrl: `${server.url.origin}${BASE}/#token=${session.bootstrapToken}`,
    async stop() {
      session.close();
      await server.stop(true);
    },
  };
}
