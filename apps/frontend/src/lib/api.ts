import config from "@config";

/** An API failure. `detail` is the backend's user-safe message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Same-origin call to the backend's admin API.
 *
 * The session lives in an HttpOnly cookie that page code never sees. Every call sends
 * `X-Axon-Admin: 1`; the backend rejects admin requests without it, which (with
 * SameSite=Strict cookies) is the dashboard's CSRF protection.
 */
export async function adminRequest<T>(
  method: Method,
  path: string,
  options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<ApiResponse<T>> {
  const url = new URL(`${config.BASE_API_URL}/api/v1/admin${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "X-Axon-Admin": "1",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const detail =
      payload &&
      typeof payload === "object" &&
      "detail" in payload &&
      typeof payload.detail === "string"
        ? payload.detail
        : `Request failed (HTTP ${response.status})`;
    throw new ApiError(response.status, detail);
  }
  return { status: response.status, data: payload as T };
}
