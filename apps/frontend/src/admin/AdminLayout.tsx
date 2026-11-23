import { LogOut, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { href, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

import { useAdminAuth, useAdminSession } from "./auth-context";
import { RoleBadge } from "./components";
import type { AdminSection } from "./sections";

export function AdminLayout({
  sections,
  activePath,
  children,
}: {
  sections: readonly AdminSection[];
  activePath: string;
  children: ReactNode;
}) {
  const { signOut } = useAdminAuth();
  const { user } = useAdminSession();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(undefined);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign-out failed.");
      setSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col border-b md:sticky md:top-0 md:h-svh md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-4">
          <ShieldCheck aria-hidden className="size-5" />
          <span className="font-heading font-semibold">Axon admin</span>
        </div>
        <nav aria-label="Admin sections" className="px-2 pb-2 md:flex-1">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {sections.map((section) => {
              const active = section.path === activePath;
              const Icon = section.icon;
              return (
                <li key={section.path}>
                  <a
                    href={href(section.path)}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                        return;
                      event.preventDefault();
                      navigate(section.path);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "hover:bg-sidebar-accent/60",
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {section.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-sidebar-border hidden space-y-3 border-t p-4 md:block">
          <div className="space-y-1">
            <p className="truncate text-sm font-medium" title={user.email}>
              {user.name ?? user.email}
            </p>
            <RoleBadge role={user.role} />
          </div>
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            <LogOut aria-hidden data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2 md:hidden">
          <span className="truncate text-sm">{user.email}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            <LogOut aria-hidden data-icon="inline-start" />
            Sign out
          </Button>
        </div>
        {signOutError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex items-start justify-between gap-3 border-b px-4 py-2 text-sm"
          >
            <p>{signOutError}</p>
            <Button variant="ghost" size="sm" onClick={() => setSignOutError(undefined)}>
              Dismiss
            </Button>
          </div>
        )}
        <main className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
