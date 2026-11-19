import { useSyncExternalStore } from "react";

/**
 * Minimal history router for the console. Paths are app-relative ("/admin/audit");
 * the Vite base path (for example "/axon/") is added and removed here only.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const NAVIGATE_EVENT = "console:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

function currentPath(): string {
  const { pathname } = window.location;
  const path = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return path.replace(/\/+$/, "") || "/";
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}

export function href(path: string): string {
  return `${BASE}${path}`;
}

export function navigate(path: string, { replace = false } = {}): void {
  const target = href(path);
  if (replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
