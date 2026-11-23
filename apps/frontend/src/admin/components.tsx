import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

import type { AdminRole } from "./types";

export function PageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="space-y-1">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
    </header>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-card rounded-xl border", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          {title && <h2 className="text-sm font-medium">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function RoleBadge({ role }: { role: AdminRole | null }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        role === "admin" ? "bg-primary text-primary-foreground border-transparent" : "bg-muted",
      )}
    >
      {role ?? "none"}
    </span>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      {label}
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 p-4 text-sm">
      <CircleAlert aria-hidden className="text-destructive size-4" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** An in-app link: a normal click navigates without reloading; modified clicks open a tab. */
export function AppLink({ to, onClick, ...props }: { to: string } & ComponentProps<"a">) {
  return (
    <a
      href={href(to)}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground p-4 text-sm">{children}</p>;
}
