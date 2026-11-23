import { ChevronRight, Plus, Star } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { navigate } from "@/lib/router";

import { useAdminSession } from "../auth-context";
import { AppLink, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components";
import { formatDateTime } from "../format";
import { roleIncludes } from "../types";
import { useAdminQuery } from "../use-admin-query";
import { Code, ProblemCounts, StatusBadges, TierBadge } from "./fields";
import { KIND_LABELS } from "./model";
import type { CatalogItemSummary, CatalogKind } from "./types";

export function CatalogListPage() {
  const { user } = useAdminSession();
  const isAdmin = roleIncludes(user.role, "admin");
  const [kind, setKind] = useState<CatalogKind>("mcp");
  const [showArchived, setShowArchived] = useState(false);
  const list = useAdminQuery<{ items: CatalogItemSummary[] }>(
    `/catalog/items?kind=${kind}${showArchived ? "&include_archived=true" : ""}`,
  );
  const label = KIND_LABELS[kind];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalog"
        description={
          <>
            What developers can install from <Code>axon hub</Code>. Edits stay in a draft until you
            publish them, and every change is in the audit log.
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={kind} onValueChange={(value) => setKind(value as CatalogKind)}>
          <TabsList>
            <TabsTrigger value="mcp">MCP servers</TabsTrigger>
            <TabsTrigger value="skill">Skills (preview)</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="catalog-show-archived"
              checked={showArchived}
              onCheckedChange={(checked) => setShowArchived(checked === true)}
            />
            <Label htmlFor="catalog-show-archived">Show archived</Label>
          </div>
          {isAdmin && (
            <Button size="lg" onClick={() => navigate(`/admin/catalog/new/${kind}`)}>
              <Plus aria-hidden data-icon="inline-start" />
              Add {label.one}
            </Button>
          )}
        </div>
      </div>

      {kind === "skill" && (
        <p className="text-muted-foreground text-sm">
          Skills are a preview. Developers can see published skills in the hub but cannot install
          them yet.
        </p>
      )}

      <Panel>
        {list.loading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : list.data && list.data.items.length > 0 ? (
          <ul className="divide-y">
            {list.data.items.map((item) => (
              <li key={item.id}>
                <AppLink
                  to={`/admin/catalog/${item.id}`}
                  className="hover:bg-muted/40 flex items-center gap-3 px-4 py-3 transition-colors"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.featured && (
                        <Star
                          aria-label="Featured"
                          className="size-3.5 fill-current text-amber-500"
                        />
                      )}
                      <span className="font-medium">{item.name}</span>
                      <span className="text-muted-foreground font-mono text-xs">{item.slug}</span>
                    </div>
                    {item.summary && (
                      <p className="text-muted-foreground truncate text-sm">{item.summary}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadges item={item} />
                      <TierBadge tier={item.tier} />
                      <ProblemCounts errors={item.error_count} warnings={item.warning_count} />
                      <span className="text-muted-foreground text-xs">
                        Updated {formatDateTime(item.updated_at)} by {item.updated_by_email}
                      </span>
                    </div>
                  </div>
                  <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0" />
                </AppLink>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>
            No {label.many} yet.
            {isAdmin &&
              (kind === "mcp"
                ? " Add one, and use Import from mcp.json to start from an existing config."
                : " Add one to show it in the hub.")}
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
