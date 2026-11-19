/** Shapes of the backend's /api/v1/admin/catalog API. See apps/backend/app/routers/admin_catalog.py. */

export type CatalogKind = "mcp" | "skill";
export type CatalogStatus = "draft" | "published" | "archived";
export type InstallTier = "one_click" | "guided" | "manual";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * A catalog entry's working copy. The spec uses the camelCase keys the hub reads
 * (see app/services/catalog/specs.py). Drafts may be incomplete or hand-edited in the
 * JSON tab, so the editor reads every field defensively.
 */
export interface Draft {
  metadata: JsonObject;
  spec: JsonObject;
}

export interface CatalogIssue {
  path: string;
  message: string;
}

export interface CatalogItemSummary {
  id: string;
  kind: CatalogKind;
  slug: string;
  status: CatalogStatus;
  featured: boolean;
  sort_order: number;
  name: string;
  summary: string;
  tier: InstallTier | null;
  error_count: number;
  warning_count: number;
  published_revision: number | null;
  latest_revision: number | null;
  has_unpublished_changes: boolean;
  lock_version: number;
  updated_at: string;
  updated_by_email: string;
  published_at: string | null;
  published_by_email: string | null;
}

export interface CatalogItem extends CatalogItemSummary {
  created_at: string;
  created_by_email: string;
  draft: Draft;
  draft_spec_version: number;
  published: Draft | null;
  errors: CatalogIssue[];
  warnings: CatalogIssue[];
}

export interface RevisionSummary {
  revision: number;
  spec_version: number;
  note: string | null;
  published_by_email: string;
  published_at: string;
  current: boolean;
}

export interface Revision extends RevisionSummary {
  content: Draft;
}

export interface ValidationResult {
  valid: boolean;
  tier: InstallTier | null;
  errors: CatalogIssue[];
  warnings: CatalogIssue[];
}

export type BlockType = "text" | "command" | "link" | "callout" | "input" | "check" | "confirm";
export const HELP_BLOCK_TYPES: readonly BlockType[] = ["text", "command", "link", "callout"];
export const STEP_BLOCK_TYPES: readonly BlockType[] = [
  ...HELP_BLOCK_TYPES,
  "input",
  "check",
  "confirm",
];

export type ServerMode = "stdio" | "http" | "none";
export type InputType = "text" | "secret" | "url" | "path";
export const EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
