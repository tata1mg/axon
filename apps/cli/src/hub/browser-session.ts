import { randomBytes, timingSafeEqual } from "node:crypto";

import { HubError } from "./errors.ts";

const BOOTSTRAP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

function secret(): string {
  return randomBytes(32).toString("hex");
}

function equal(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hub-only credentials, independent of Axon authentication and the model relay. */
export class HubBrowserSession {
  readonly bootstrapToken = secret();
  private readonly cookieName = `axon_hub_${secret().slice(0, 16)}`;
  private readonly sessionToken = secret();
  private readonly csrfToken = secret();
  private readonly createdAt: number;
  private expiresAt = 0;
  private used = false;

  constructor(private readonly now: () => number = Date.now) {
    this.createdAt = now();
  }

  exchange(value: unknown): { cookie: string; csrfToken: string } {
    if (
      this.used ||
      this.now() - this.createdAt >= BOOTSTRAP_TTL_MS ||
      typeof value !== "string" ||
      !equal(value, this.bootstrapToken)
    )
      throw new HubError(
        401,
        "This hub link is invalid or expired. Restart axon hub for a new link.",
      );
    this.used = true;
    this.expiresAt = this.now() + SESSION_TTL_MS;
    return {
      cookie: `${this.cookieName}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/_axon/hub; Max-Age=${SESSION_TTL_MS / 1000}`,
      csrfToken: this.csrfToken,
    };
  }

  authenticate(request: Request, mutation: boolean): string {
    const cookies = (request.headers.get("cookie") ?? "").split(";");
    const cookie = cookies.find((part) => part.trim().startsWith(`${this.cookieName}=`));
    const token = cookie?.trim().slice(this.cookieName.length + 1);
    if (!this.used || this.now() >= this.expiresAt || !equal(token, this.sessionToken))
      throw new HubError(401, "Your hub session has expired. Restart axon hub to reconnect.");
    if (request.headers.get("x-axon-hub") !== "1")
      throw new HubError(403, "A same-origin hub request is required.");
    if (mutation && !equal(request.headers.get("x-axon-hub-csrf") ?? undefined, this.csrfToken))
      throw new HubError(403, "The hub request could not be verified. Refresh this page.");
    return this.csrfToken;
  }

  close(): void {
    this.expiresAt = 0;
  }
}
