/**
 * Which catalog entries this user installed, kept in `${AXON_HOME}/hub-catalog-installs.json`
 * beside (not inside) Pi's config, so Pi's file carries no extra fields. It never holds
 * input values: only the server name, the catalog revision, and a fingerprint of the
 * catalog-managed fields with inputs masked.
 */
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { HubError } from "./errors.ts";

const MAX_FILE_BYTES = 256 * 1024;

const recordSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  revision: z.number().int().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  positions: z.array(z.string().max(300)).max(400),
  installedAt: z.string().max(64),
  /** The catalog URL when it has no inputs, so the hub can show it instead of hiding it. */
  url: z.string().max(2048).optional(),
});
export type InstallRecord = z.infer<typeof recordSchema>;

const fileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mcp: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), recordSchema),
});
export type InstallsFile = z.infer<typeof fileSchema>;

function empty(): InstallsFile {
  return { schemaVersion: 1, mcp: {} };
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** A missing or unreadable file means "nothing recorded": the hub then shows entries as not installed. */
export async function readInstalls(path: string): Promise<InstallsFile> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size > MAX_FILE_BYTES) return empty();
    const parsed = fileSchema.safeParse(JSON.parse(await Bun.file(path).text()));
    return parsed.success ? parsed.data : empty();
  } catch {
    return empty();
  }
}

export async function writeInstalls(path: string, installs: InstallsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new HubError(422, "The hub's install record is a symlink. Remove it and retry.");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(fileSchema.parse(installs), null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
