import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, RoleBadge } from "../components";
import type { AdminMember } from "../types";
import { useAdminQuery } from "../use-admin-query";

export function AccessPage() {
  const members = useAdminQuery<{ members: AdminMember[] }>("/members");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access"
        description={
          <>
            People who can sign in to this dashboard. Access is granted in the backend{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">config.json</code> under{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">ADMIN_DASHBOARD.MEMBERS</code>,
            not here, and changes apply after the backend restarts.
          </>
        }
      />
      <Panel>
        {members.loading ? (
          <LoadingState />
        ) : members.error ? (
          <ErrorState message={members.error} onRetry={members.reload} />
        ) : members.data && members.data.members.length > 0 ? (
          <ul className="divide-y">
            {members.data.members.map((member) => (
              <li
                key={member.email}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="break-all">{member.email}</span>
                <RoleBadge role={member.role} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No members are configured.</EmptyState>
        )}
      </Panel>
    </div>
  );
}
