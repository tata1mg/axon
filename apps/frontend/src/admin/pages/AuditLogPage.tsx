import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { adminRequest } from "@/lib/api";

import { useAdminAuth } from "../auth-context";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, RoleBadge } from "../components";
import { actionLabel, eventTarget, formatDateTime } from "../format";
import type { AuditEvent, AuditEventPage } from "../types";

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const { handleApiError } = useAdminAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);

  // First page; reloads when the user retries.
  useEffect(() => {
    let cancelled = false;
    adminRequest<AuditEventPage>("GET", "/audit-events", { query: { limit: PAGE_SIZE } }).then(
      ({ data }) => {
        if (cancelled) return;
        setEvents(data.events);
        setNextBefore(data.next_before);
        setError(undefined);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(handleApiError(failure));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generation, handleApiError]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoading(true);
    try {
      const { data } = await adminRequest<AuditEventPage>("GET", "/audit-events", {
        query: { limit: PAGE_SIZE, before: nextBefore },
      });
      setEvents((current) => [...current, ...data.events]);
      setNextBefore(data.next_before);
      setError(undefined);
    } catch (failure) {
      setError(handleApiError(failure));
    } finally {
      setLoading(false);
    }
  }

  function retry() {
    setLoading(true);
    setEvents([]);
    setGeneration((value) => value + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every sign-in and change made through this dashboard, newest first."
      />
      <Panel>
        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-muted-foreground border-b text-xs">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Who
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Target
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((event) => (
                  <tr key={event.id} className="align-top">
                    <td className="text-muted-foreground px-4 py-3 whitespace-nowrap">
                      <time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all">{event.actor_email}</span>
                        <RoleBadge role={event.actor_role} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{actionLabel(event.action)}</div>
                      {Object.keys(event.details).length > 0 && (
                        <pre className="text-muted-foreground mt-1 max-w-md overflow-x-auto text-xs">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="text-muted-foreground px-4 py-3 break-all">
                      {eventTarget(event) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error ? (
          <ErrorState message={error} onRetry={events.length > 0 ? () => void loadMore() : retry} />
        ) : loading ? (
          <LoadingState />
        ) : events.length === 0 ? (
          <EmptyState>No activity yet.</EmptyState>
        ) : (
          nextBefore && (
            <div className="border-t p-3">
              <Button variant="outline" size="lg" onClick={() => void loadMore()}>
                Load older events
              </Button>
            </div>
          )
        )}
      </Panel>
    </div>
  );
}
