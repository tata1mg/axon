import { join, resolve } from "node:path";

import { sha256 } from "../src/hash.ts";

/**
 * Vendors the upstream Agent Safehouse release script into the CLI.
 *
 *   bun run safehouse:update <version>   download, verify against the GitHub digest, rewrite pins
 *   bun run safehouse:check              offline: vendored files agree with runtime.ts pins
 */
const REPOSITORY = "eugene1g/agent-safehouse";
const ASSET_NAME = "safehouse.sh";
const RUNTIME_SOURCE = "src/axon-safehouse/runtime.ts";
const VENDORED_SCRIPT = "src/axon-safehouse/vendor/safehouse.sh";
const VENDORED_LICENSE = "src/axon-safehouse/vendor/LICENSE";
const VERSION_PATTERN = /^export const SAFEHOUSE_VERSION = "([^"]+)";$/m;
const SHA256_PATTERN = /^export const SAFEHOUSE_SHA256 = "([0-9a-f]{64})";$/m;
const MAX_BYTES_PATTERN = /^export const SAFEHOUSE_MAX_BYTES = ([0-9 *]+);$/m;
const EMBEDDED_VERSION_PATTERN = /^safehouse_project_version_embedded="([^"]+)"$/m;

export interface SafehouseVendorOptions {
  readonly repositoryRoot?: string;
  readonly fetch?: typeof fetch;
}

interface RuntimePins {
  readonly source: string;
  readonly version: string;
  readonly sha256: string;
  readonly maxBytes: number;
}

function match(pattern: RegExp, text: string, description: string): string {
  const value = pattern.exec(text)?.[1];
  if (!value) throw new Error(`could not find ${description}`);
  return value;
}

async function readRuntimePins(repositoryRoot: string): Promise<RuntimePins> {
  const source = await Bun.file(join(repositoryRoot, RUNTIME_SOURCE)).text();
  const maxBytesExpression = match(
    MAX_BYTES_PATTERN,
    source,
    `SAFEHOUSE_MAX_BYTES in ${RUNTIME_SOURCE}`,
  );
  const maxBytes = maxBytesExpression
    .split("*")
    .map((factor) => Number(factor.trim()))
    .reduce((product, factor) => product * factor, 1);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`SAFEHOUSE_MAX_BYTES in ${RUNTIME_SOURCE} is not a positive integer`);
  }
  return {
    source,
    version: match(VERSION_PATTERN, source, `SAFEHOUSE_VERSION in ${RUNTIME_SOURCE}`),
    sha256: match(SHA256_PATTERN, source, `SAFEHOUSE_SHA256 in ${RUNTIME_SOURCE}`),
    maxBytes,
  };
}

function verifyScript(content: Uint8Array, version: string, maxBytes: number): void {
  if (content.byteLength === 0 || content.byteLength > maxBytes) {
    throw new Error(`${ASSET_NAME} is ${content.byteLength} bytes; limit is ${maxBytes}`);
  }
  const text = new TextDecoder().decode(content);
  if (!text.startsWith("#!/usr/bin/env bash\n")) {
    throw new Error(`${ASSET_NAME} is not a bash script`);
  }
  const embedded = match(EMBEDDED_VERSION_PATTERN, text, `the embedded version in ${ASSET_NAME}`);
  if (embedded !== version) {
    throw new Error(`${ASSET_NAME} embeds version ${embedded}, expected ${version}`);
  }
}

export async function checkVendoredSafehouse(options: SafehouseVendorOptions = {}): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const pins = await readRuntimePins(repositoryRoot);
  const script = Bun.file(join(repositoryRoot, VENDORED_SCRIPT));
  if (!(await script.exists())) {
    throw new Error(
      `${VENDORED_SCRIPT} is missing; run \`bun run safehouse:update ${pins.version}\``,
    );
  }
  const content = await script.bytes();
  verifyScript(content, pins.version, pins.maxBytes);
  if (sha256(content) !== pins.sha256) {
    throw new Error(
      `${VENDORED_SCRIPT} does not match SAFEHOUSE_SHA256; run \`bun run safehouse:update ${pins.version}\``,
    );
  }
  const license = await Bun.file(join(repositoryRoot, VENDORED_LICENSE))
    .text()
    .catch(() => "");
  if (!license.includes("Apache License")) {
    throw new Error(`${VENDORED_LICENSE} is missing the upstream Apache-2.0 license`);
  }
  console.log(`Verified vendored Agent Safehouse ${pins.version}.`);
}

async function download(
  fetcher: typeof fetch,
  url: string,
  maxBytes: number,
  accept?: string,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    headers: accept ? { Accept: accept } : {},
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  const content = new Uint8Array(await response.arrayBuffer());
  if (content.byteLength > maxBytes) throw new Error(`GET ${url} exceeded ${maxBytes} bytes`);
  return content;
}

export async function updateVendoredSafehouse(
  version: string,
  options: SafehouseVendorOptions = {},
): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`expected a release version like 0.12.0, received ${JSON.stringify(version)}`);
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const fetcher = options.fetch ?? fetch;
  const pins = await readRuntimePins(repositoryRoot);

  // The release API digest is GitHub's record of the uploaded asset, independent of the download.
  const release = JSON.parse(
    new TextDecoder().decode(
      await download(
        fetcher,
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`,
        4 * 1024 * 1024,
        "application/vnd.github+json",
      ),
    ),
  ) as { assets?: { name?: string; digest?: string; browser_download_url?: string }[] };
  const asset = release.assets?.find((candidate) => candidate.name === ASSET_NAME);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? "")?.[1];
  const assetUrl = asset?.browser_download_url;
  if (!digest || !assetUrl?.startsWith(`https://github.com/${REPOSITORY}/releases/download/`)) {
    throw new Error(`release v${version} has no ${ASSET_NAME} asset with a sha256 digest`);
  }

  const script = await download(fetcher, assetUrl, pins.maxBytes);
  if (sha256(script) !== digest) {
    throw new Error(`downloaded ${ASSET_NAME} does not match the GitHub release digest`);
  }
  verifyScript(script, version, pins.maxBytes);

  const license = await download(
    fetcher,
    `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/LICENSE`,
    1024 * 1024,
  );
  if (!new TextDecoder().decode(license).includes("Apache License")) {
    throw new Error(
      `upstream LICENSE at v${version} is no longer Apache-2.0; review before vendoring`,
    );
  }

  const source = pins.source
    .replace(VERSION_PATTERN, `export const SAFEHOUSE_VERSION = "${version}";`)
    .replace(SHA256_PATTERN, `export const SAFEHOUSE_SHA256 = "${digest}";`);
  await Bun.write(join(repositoryRoot, VENDORED_SCRIPT), script);
  await Bun.write(join(repositoryRoot, VENDORED_LICENSE), license);
  await Bun.write(join(repositoryRoot, RUNTIME_SOURCE), source);
  console.log(
    `Vendored Agent Safehouse ${version} (${script.byteLength} bytes, sha256 ${digest}). Review and commit the result.`,
  );
}

if (import.meta.main) {
  try {
    const [argument] = process.argv.slice(2);
    if (argument === "--check") await checkVendoredSafehouse();
    else if (argument) await updateVendoredSafehouse(argument);
    else throw new Error("usage: update-safehouse.ts <version> | --check");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
