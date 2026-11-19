import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { navigate, usePath } from "@/lib/router";

import { AdminAuthProvider } from "./AdminAuthProvider";
import { AdminLayout } from "./AdminLayout";
import { useAdminAuth } from "./auth-context";
import { ErrorState, LoadingState } from "./components";
import { LoginPage } from "./LoginPage";
import { ADMIN_SECTIONS, sectionMatches } from "./sections";
import { roleIncludes } from "./types";

export function AdminApp() {
  return (
    <AdminAuthProvider>
      <AdminGate />
    </AdminAuthProvider>
  );
}

function AdminGate() {
  const { state, refresh } = useAdminAuth();

  if (state.status === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <LoadingState />
      </div>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <div className="bg-card w-full max-w-sm rounded-xl border">
          <ErrorState message={state.message} onRetry={refresh} />
        </div>
      </div>
    );
  }
  if (state.status === "signed_out") return <LoginPage notice={state.notice} />;
  return <AdminRoutes />;
}

function AdminRoutes() {
  const path = usePath();
  const { state } = useAdminAuth();
  const role = state.status === "signed_in" ? state.session.user.role : "viewer";
  const sections = ADMIN_SECTIONS.filter((section) => roleIncludes(role, section.minRole));
  const known = ADMIN_SECTIONS.find((section) => sectionMatches(section, path));
  const active = sections.find((section) => sectionMatches(section, path));

  // Unknown admin paths go to the overview; known-but-forbidden ones show a notice.
  useEffect(() => {
    if (!known) navigate("/admin", { replace: true });
  }, [known]);

  const Page = active?.component;
  return (
    <AdminLayout sections={sections} activePath={known?.path ?? path}>
      {Page ? (
        <Page />
      ) : known ? (
        <div className="space-y-3">
          <p className="text-sm">Your role does not include access to {known.label}.</p>
          <Button variant="outline" size="lg" onClick={() => navigate("/admin")}>
            Back to overview
          </Button>
        </div>
      ) : null}
    </AdminLayout>
  );
}
