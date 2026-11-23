import { Blocks, History, LayoutDashboard, Users, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import { CatalogSection } from "./catalog/CatalogSection";
import { AccessPage } from "./pages/AccessPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { OverviewPage } from "./pages/OverviewPage";
import type { AdminRole } from "./types";

export interface AdminSection {
  /** App-relative path, always under /admin. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** Hides the section in the UI; the backend enforces the same role on its API. */
  minRole: AdminRole;
  component: ComponentType;
  /** The section also owns paths below `path` (for example /admin/catalog/<id>). */
  nested?: boolean;
}

export function sectionMatches(section: AdminSection, path: string): boolean {
  return section.path === path || (section.nested === true && path.startsWith(`${section.path}/`));
}

/**
 * Every dashboard area is registered here. A new feature adds one entry plus its page
 * and backend routes.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    path: "/admin",
    label: "Overview",
    icon: LayoutDashboard,
    minRole: "viewer",
    component: OverviewPage,
  },
  {
    path: "/admin/catalog",
    label: "Catalog",
    icon: Blocks,
    minRole: "viewer",
    component: CatalogSection,
    nested: true,
  },
  {
    path: "/admin/audit",
    label: "Audit log",
    icon: History,
    minRole: "viewer",
    component: AuditLogPage,
  },
  { path: "/admin/access", label: "Access", icon: Users, minRole: "admin", component: AccessPage },
];
