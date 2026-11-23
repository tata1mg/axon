import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { navigate, usePath } from "@/lib/router";

import { useAdminSession } from "../auth-context";
import { roleIncludes } from "../types";
import { CatalogCreatePage, CatalogItemPage } from "./CatalogEditorPage";
import { CatalogListPage } from "./CatalogListPage";

const BASE = "/admin/catalog";
const ITEM = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CREATE = /^\/new\/(mcp|skill)$/;

/** Routes inside the catalog: the list, /new/<kind>, and /<item id>. */
export function CatalogSection() {
  const path = usePath();
  const { user } = useAdminSession();
  const rest = path.slice(BASE.length);
  const item = ITEM.exec(rest);
  const create = CREATE.exec(rest);
  const known = rest === "" || item !== null || create !== null;

  useEffect(() => {
    if (!known) navigate(BASE, { replace: true });
  }, [known]);

  if (rest === "") return <CatalogListPage />;
  if (item?.[1]) return <CatalogItemPage key={item[1]} id={item[1]} />;
  if (create?.[1]) {
    if (!roleIncludes(user.role, "admin"))
      return (
        <div className="space-y-3">
          <p className="text-sm">Only admins can add catalog items.</p>
          <Button variant="outline" size="lg" onClick={() => navigate(BASE)}>
            Back to catalog
          </Button>
        </div>
      );
    return <CatalogCreatePage key={create[1]} kind={create[1] as "mcp" | "skill"} />;
  }
  return null;
}
