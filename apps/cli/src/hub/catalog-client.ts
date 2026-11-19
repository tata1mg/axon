/**
 * Reads the published organization catalog with the user's saved Axon session.
 *
 * This is the hub's only outbound request: a read-only GET. Like the CLI's other
 * authenticated calls it sends no cookies, follows no redirects, and persists a rotated
 * session only when the backend issued one for the credential it was sent.
 */

import { BUILD_INFO } from "../build-info.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import type { AxonPaths } from "../product/paths.ts";
import { type CatalogItem, catalogEnvelopeSchema, parseCatalogItems } from "./catalog-schema.ts";

export const CATALOG_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export type CatalogFetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface CatalogFetchOptions {
  readonly kinds: Readonly<Record<string, number>>;
  readonly serviceOrigin?: string;
  readonly fetcher?: CatalogFetcher;
  readonly timeoutMs?: number;
}

export type CatalogFetchResult =
  | { readonly status: "ok"; readonly items: CatalogItem[]; readonly skipped: number }
  | { readonly status: "signin_required" }
  | { readonly status: "unavailable"; readonly message: string };

const unavailable = (message: string): CatalogFetchResult => ({ status: "unavailable", message });

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES || !response.body)
    throw new Error("Catalog response too large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_CATALOG_BYTES) throw new Error("Catalog response too large");
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function fetchPublishedCatalog(
  paths: AxonPaths,
  options: CatalogFetchOptions,
): Promise<CatalogFetchResult> {
  let session: string | undefined;
  try {
    session = await loadEncryptedSession(paths);
  } catch {
    return { status: "signin_required" };
  }
  if (session === undefined) return { status: "signin_required" };

  const kinds = Object.entries(options.kinds)
    .map(([kind, version]) => `${kind}:${version}`)
    .join(",");
  const signal = AbortSignal.timeout(options.timeoutMs ?? CATALOG_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      resolveServiceUrl(
        options.serviceOrigin ?? BUILD_INFO.serviceOrigin,
        SERVICE_ENDPOINTS.catalog.items,
        {
          kinds,
        },
      ),
      {
        headers: { accept: "application/json", authorization: `Bearer ${session}` },
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
  } catch {
    return unavailable(
      signal.aborted
        ? "The Axon service didn't respond in time. Try again."
        : "Couldn't reach the Axon service. Check your network or VPN, then try again.",
    );
  }

  try {
    if (response.status === 401 || response.status === 403) return { status: "signin_required" };
    if (!response.ok)
      return unavailable(`The Axon service returned HTTP ${response.status}. Try again later.`);
    const refreshed = response.headers.get("x-session-refresh-token");
    if (refreshed && refreshed.length <= 8192 && /^[\x21-\x7e]+$/.test(refreshed)) {
      // Best effort: a lost rotation only means the next request uses the old credential.
      await refreshEncryptedSession(paths, session, refreshed).catch(() => false);
    }
    const envelope = catalogEnvelopeSchema.safeParse(JSON.parse(await boundedText(response)));
    if (!envelope.success)
      return unavailable(
        "The catalog response wasn't in a format this axon understands. Update axon.",
      );
    return { status: "ok", ...parseCatalogItems(envelope.data.items) };
  } catch {
    return unavailable("The catalog response couldn't be read. Try again.");
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
