import type { AuditEvent } from "./types";

const ACTION_LABELS: Record<string, string> = {
  "admin.sign_in": "Signed in",
  "admin.sign_in_denied": "Sign-in denied",
  "admin.sign_out": "Signed out",
  "catalog.item_created": "Created a catalog item",
  "catalog.item_updated": "Saved a catalog draft",
  "catalog.item_published": "Published a catalog item",
  "catalog.item_unpublished": "Unpublished a catalog item",
  "catalog.item_archived": "Archived a catalog item",
  "catalog.item_unarchived": "Unarchived a catalog item",
  "catalog.item_deleted": "Deleted a catalog draft",
  "catalog.revision_restored": "Restored a catalog revision",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

export function eventTarget(event: AuditEvent): string | null {
  const { kind, slug } = event.details;
  if (event.target_type === "catalog_item" && typeof kind === "string" && typeof slug === "string")
    return `${kind}: ${slug}`;
  return event.target_type ? `${event.target_type}: ${event.target_id}` : null;
}
