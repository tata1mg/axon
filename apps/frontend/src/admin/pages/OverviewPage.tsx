import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { href, navigate } from "@/lib/router";

import { useAdminSession } from "../auth-context";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, RoleBadge } from "../components";
import { actionLabel, eventTarget, formatDateTime } from "../format";
import type { AuditEventPage } from "../types";
import { useAdminQuery } from "../use-admin-query";

const ROLE_SUMMARY = {
  admin: "You can view everything and make changes. Every change is recorded in the audit log.",
  viewer: "You can view the dashboard and its audit log, but cannot make changes.",
} as const;

export function OverviewPage() {
  const { user } = useAdminSession();
  const recent = useAdminQuery<AuditEventPage>("/audit-events?limit=5");

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome${user.name ? `, ${user.name}` : ""}`}
        description="Manage Axon settings for your organization."
      />

      <Panel title="Your access">
        <div className="space-y-2 p-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Signed in as</span>
            <span className="font-medium break-all">{user.email}</span>
            <RoleBadge role={user.role} />
          </p>
          <p className="text-muted-foreground">{ROLE_SUMMARY[user.role]}</p>
        </div>
      </Panel>

      <Panel
        title="Recent activity"
        action={
          <Button asChild variant="ghost" size="sm">
            <a
              href={href("/admin/audit")}
              onClick={(event) => {
                event.preventDefault();
                navigate("/admin/audit");
              }}
            >
              View all
              <ArrowRight aria-hidden data-icon="inline-end" />
            </a>
          </Button>
        }
      >
        {recent.loading ? (
          <LoadingState />
        ) : recent.error ? (
          <ErrorState message={recent.error} onRetry={recent.reload} />
        ) : recent.data && recent.data.events.length > 0 ? (
          <ul className="divide-y">
            {recent.data.events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <span className="font-medium">{actionLabel(event.action)}</span>
                <span className="text-muted-foreground break-all">{event.actor_email}</span>
                {eventTarget(event) && (
                  <span className="text-muted-foreground break-all">{eventTarget(event)}</span>
                )}
                <time className="text-muted-foreground ml-auto text-xs" dateTime={event.created_at}>
                  {formatDateTime(event.created_at)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No activity yet.</EmptyState>
        )}
      </Panel>
    </div>
  );
}
