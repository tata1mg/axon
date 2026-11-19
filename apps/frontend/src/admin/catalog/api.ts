import { adminRequest } from "@/lib/api";

import type {
  CatalogItem,
  CatalogKind,
  Draft,
  Revision,
  RevisionSummary,
  ValidationResult,
} from "./types";

const ITEMS = "/catalog/items";

export type ItemAction = "publish" | "unpublish" | "archive" | "unarchive";

export interface ItemUpdate {
  lock_version: number;
  draft?: Draft;
  slug?: string;
  featured?: boolean;
  sort_order?: number;
}

export const catalogApi = {
  async create(body: {
    kind: CatalogKind;
    slug: string;
    draft: Draft;
    featured: boolean;
    sort_order: number;
  }): Promise<CatalogItem> {
    return (await adminRequest<CatalogItem>("POST", ITEMS, { body })).data;
  },

  async get(id: string): Promise<CatalogItem> {
    return (await adminRequest<CatalogItem>("GET", `${ITEMS}/${id}`)).data;
  },

  async update(id: string, body: ItemUpdate): Promise<CatalogItem> {
    return (await adminRequest<CatalogItem>("PATCH", `${ITEMS}/${id}`, { body })).data;
  },

  async remove(id: string, lockVersion: number): Promise<void> {
    await adminRequest("DELETE", `${ITEMS}/${id}`, { body: { lock_version: lockVersion } });
  },

  async act(
    id: string,
    action: ItemAction,
    lockVersion: number,
    note?: string,
  ): Promise<CatalogItem> {
    const body =
      action === "publish" ? { lock_version: lockVersion, note } : { lock_version: lockVersion };
    return (await adminRequest<CatalogItem>("POST", `${ITEMS}/${id}/${action}`, { body })).data;
  },

  async revisions(id: string): Promise<RevisionSummary[]> {
    return (await adminRequest<{ revisions: RevisionSummary[] }>("GET", `${ITEMS}/${id}/revisions`))
      .data.revisions;
  },

  async revision(id: string, revision: number): Promise<Revision> {
    return (await adminRequest<Revision>("GET", `${ITEMS}/${id}/revisions/${revision}`)).data;
  },

  async restore(id: string, revision: number, lockVersion: number): Promise<CatalogItem> {
    return (
      await adminRequest<CatalogItem>("POST", `${ITEMS}/${id}/revisions/${revision}/restore`, {
        body: { lock_version: lockVersion },
      })
    ).data;
  },

  async validate(kind: CatalogKind, draft: Draft): Promise<ValidationResult> {
    return (
      await adminRequest<ValidationResult>("POST", "/catalog/validate", { body: { kind, draft } })
    ).data;
  },
};
