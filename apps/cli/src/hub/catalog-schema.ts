/**
 * The published catalog as `axon hub` reads it from `GET /api/v1/catalog`.
 *
 * Mirrors apps/backend/app/services/catalog/specs.py, which is the source of truth. The
 * backend validates before publishing; this is defense in depth, because these entries
 * are written into the user's Pi config. Entries that don't match are skipped, never
 * partially used, and unknown fields are refused so nothing unexpected reaches mcp.json.
 */
import { z } from "zod";

/** Kinds and spec versions this hub understands. Sent to the backend as `?kinds=`. */
export const SUPPORTED_SPECS = { mcp: 1, skill: 0 } as const;
export type CatalogKind = keyof typeof SUPPORTED_SPECS;

/** Control characters, optionally allowing tab and newline. */
export function hasControlCharacters(value: string, allowLineBreaks = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowLineBreaks && (character === "\n" || character === "\t")) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

const singleLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasControlCharacters(value), "must be a single line");
const multiLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasControlCharacters(value, true), "must be printable");
const httpsUrl = singleLine(2048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "must be an https URL");
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const label = singleLine(120).min(1);

const text = z.strictObject({ type: z.literal("text"), text: multiLine(4000).min(1) });
const command = z.strictObject({
  type: z.literal("command"),
  command: multiLine(4000).min(1),
  label: label.optional(),
});
const link = z.strictObject({ type: z.literal("link"), label, url: httpsUrl });
const callout = z.strictObject({
  type: z.literal("callout"),
  tone: z.enum(["info", "warning"]).default("info"),
  text: multiLine(4000).min(1),
});
const inputBlock = z.strictObject({ type: z.literal("input"), input: identifier });
const check = z.strictObject({ type: z.literal("check"), prerequisite: identifier });
const confirm = z.strictObject({ type: z.literal("confirm"), id: identifier, label });

export const helpBlockSchema = z.discriminatedUnion("type", [text, command, link, callout]);
export const stepBlockSchema = z.discriminatedUnion("type", [
  text,
  command,
  link,
  callout,
  inputBlock,
  check,
  confirm,
]);
export type HelpBlock = z.infer<typeof helpBlockSchema>;
export type StepBlock = z.infer<typeof stepBlockSchema>;

const metadataSchema = z.strictObject({
  name: singleLine(80).min(1),
  summary: singleLine(300).default(""),
  tags: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
    .max(10)
    .default([]),
  docsUrl: httpsUrl.optional(),
  icon: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .optional(),
});
export type CatalogMetadata = z.infer<typeof metadataSchema>;

const value = singleLine(8192);
export const serverTemplateSchema = z.strictObject({
  type: z.enum(["stdio", "http", "streamable-http"]).optional(),
  command: singleLine(1024).min(1).optional(),
  args: z.array(value).max(256).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value).optional(),
  cwd: singleLine(4096).min(1).optional(),
  url: singleLine(2048).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/), value).optional(),
  timeout: z.number().positive().max(86_400).optional(),
  description: multiLine(2048).optional(),
  exposure: z.enum(["codemode", "deferred", "direct", "hidden"]).default("codemode"),
});
export type ServerTemplate = z.infer<typeof serverTemplateSchema>;

const mcpInputSchema = z.strictObject({
  id: identifier,
  label,
  type: z.enum(["text", "secret", "url", "path"]).default("text"),
  required: z.boolean().default(true),
  placeholder: singleLine(200).optional(),
  pattern: z.string().min(1).max(500).optional(),
  help: z.array(helpBlockSchema).max(20).default([]),
});
export type McpInput = z.infer<typeof mcpInputSchema>;

const prerequisiteSchema = z.strictObject({
  id: identifier,
  label,
  detect: z
    .strictObject({ executable: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/) })
    .optional(),
  help: z.array(helpBlockSchema).max(20).default([]),
});
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

export const mcpSpecSchema = z.strictObject({
  server: serverTemplateSchema.optional(),
  inputs: z.array(mcpInputSchema).max(20).default([]),
  prerequisites: z.array(prerequisiteSchema).max(10).default([]),
  steps: z.array(stepBlockSchema).max(50).default([]),
  afterInstall: z.array(helpBlockSchema).max(20).default([]),
});
export type McpSpec = z.infer<typeof mcpSpecSchema>;

const skillSpecSchema = z.strictObject({
  source: z.strictObject({ type: z.literal("placeholder"), notes: multiLine(2000).default("") }),
});

const itemBase = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  revision: z.number().int().min(1),
  tier: z.enum(["one_click", "guided", "manual"]).nullable(),
  featured: z.boolean(),
  publishedAt: z.string().max(64),
  metadata: metadataSchema,
};

export const mcpItemSchema = z.object({
  ...itemBase,
  kind: z.literal("mcp"),
  specVersion: z.literal(SUPPORTED_SPECS.mcp),
  spec: mcpSpecSchema,
});
export type McpCatalogItem = z.infer<typeof mcpItemSchema>;

export const skillItemSchema = z.object({
  ...itemBase,
  kind: z.literal("skill"),
  specVersion: z.literal(SUPPORTED_SPECS.skill),
  spec: skillSpecSchema,
});
export type SkillCatalogItem = z.infer<typeof skillItemSchema>;

export type CatalogItem = McpCatalogItem | SkillCatalogItem;

export const catalogEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.unknown()).max(100),
});

/** Parse each item on its own, so one malformed entry never hides the rest. */
export function parseCatalogItems(items: readonly unknown[]): {
  readonly items: CatalogItem[];
  readonly skipped: number;
} {
  const parsed: CatalogItem[] = [];
  let skipped = 0;
  for (const raw of items) {
    const kind = raw !== null && typeof raw === "object" ? Reflect.get(raw, "kind") : undefined;
    const result =
      kind === "mcp"
        ? mcpItemSchema.safeParse(raw)
        : kind === "skill"
          ? skillItemSchema.safeParse(raw)
          : undefined;
    if (result?.success) parsed.push(result.data);
    else skipped += 1;
  }
  return { items: parsed, skipped };
}
