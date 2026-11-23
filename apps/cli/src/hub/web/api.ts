// Hub API client. The CSRF token lives only in memory; the session cookie is HttpOnly.
const API = "/_axon/hub/api";

/** `status` is 0 when the hub could not be reached or did not answer in time. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isRequestError(error: unknown): error is RequestError {
  return error instanceof RequestError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Refresh and try again.";
}

let csrfToken: string | undefined;

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "x-axon-hub": "1",
        ...(csrfToken ? { "x-axon-hub-csrf": csrfToken } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new RequestError(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "The local hub didn’t respond in time. Try again."
        : "Can’t reach axon hub. Check that it’s still running in your terminal.",
      0,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new RequestError(
      `The local hub returned HTTP ${response.status}. Refresh before retrying.`,
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : "The local hub request failed.";
    throw new RequestError(message, response.status);
  }
  return result as T;
}

/**
 * Removes the single-use bootstrap secret from the address bar before anything else runs,
 * so it never reaches HTTP URLs, referrers, history, or storage.
 */
export function takeLaunchToken(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? undefined;
  window.history.replaceState(null, "", window.location.pathname);
  return token;
}

export interface HubSession {
  readonly schemaVersion: number;
  readonly features: Readonly<Record<string, boolean>>;
}

export async function connect(token: string | undefined): Promise<HubSession> {
  if (token) await api("/session", "POST", { token });
  const session = await api<HubSession & { csrfToken: string }>("/session");
  csrfToken = session.csrfToken;
  return { schemaVersion: session.schemaVersion, features: session.features };
}
