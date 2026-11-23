// Per-kind rules for Discover. A new catalog kind adds an entry here and a case in `cardFor`;
// the page, filters and sections are generic. Pure, so tests can import it without a DOM.
import { actionFor, type CatalogItem, stateTag } from "./model.ts";

export type CatalogKind = CatalogItem["kind"];

export interface KindInfo {
  readonly kind: CatalogKind;
  /** Plural, for chips and section headings. */
  readonly label: string;
  /** An IconName from ui/Icon.tsx, which this DOM-free module doesn't import. */
  readonly icon: "plug" | "book";
  /** The `/session` feature that turns this kind on. */
  readonly feature: string;
  /** Listed but not installable yet. */
  readonly preview: boolean;
  readonly empty: string;
}

export const KINDS: readonly KindInfo[] = [
  {
    kind: "mcp",
    label: "MCP servers",
    icon: "plug",
    feature: "catalog",
    preview: false,
    empty: "When your admins publish MCP servers to the catalog, they appear here.",
  },
  {
    kind: "skill",
    label: "Skills",
    icon: "book",
    feature: "skills",
    preview: true,
    empty: "When your admins publish skills to the catalog, they appear here.",
  },
];

export function enabledKinds(features: Readonly<Record<string, boolean>>): KindInfo[] {
  return KINDS.filter(({ feature }) => features[feature] === true);
}

export interface CardAction {
  readonly label: string;
  readonly primary: boolean;
  readonly disabled: boolean;
}
export interface CardTag {
  readonly label: string;
  readonly tone: "ok" | "warn" | "muted";
}

/** The button and status tag on a Discover card. */
export function cardFor(item: CatalogItem): {
  readonly action: CardAction;
  readonly tag: CardTag | null;
} {
  switch (item.kind) {
    case "mcp": {
      const { action, label } = actionFor(item);
      const primary = action === "install" || action === "update" || action === "install_as";
      return { action: { label, primary, disabled: false }, tag: stateTag(item) };
    }
    case "skill":
      return {
        action: { label: "Install", primary: false, disabled: true },
        tag: { label: "Coming soon", tone: "muted" },
      };
  }
}

export type KindFilter = "all" | CatalogKind;

export interface Section {
  readonly info: KindInfo;
  readonly items: readonly CatalogItem[];
}

/**
 * Enabled kinds in registry order, keeping the backend's order (featured first) inside each.
 * "All" drops empty kinds; a single kind is returned even when empty, for its empty state.
 */
export function sections(
  items: readonly CatalogItem[],
  kinds: readonly KindInfo[],
  filter: KindFilter,
): Section[] {
  const all = kinds.map((info) => ({
    info,
    items: items.filter(({ kind }) => kind === info.kind),
  }));
  if (filter === "all") return all.filter((section) => section.items.length > 0);
  return all.filter((section) => section.info.kind === filter);
}
