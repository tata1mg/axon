export interface RelayHttpError {
  readonly errorType: "HTTPError" | "CloudflareError";
  readonly errorCode: string;
}

/** Classify HTTP failures from headers only; never buffer or inspect response streams. */
export function relayHttpError(status: number, headers?: Headers): RelayHttpError | undefined {
  if (status < 400) return undefined;
  if (headers?.get("cf-mitigated")?.trim().toLowerCase() === "challenge") {
    return { errorType: "CloudflareError", errorCode: "CLOUDFLARE_CHALLENGE" };
  }
  // A CF Ray alone is not a denial: normal backend responses also pass through CF.
  // Treat only HTML 403s carrying both edge headers as a likely edge denial page.
  if (
    status === 403 &&
    /^text\/html(?:\s*;|\s*$)/i.test(headers?.get("content-type") ?? "") &&
    headers?.get("server")?.trim().toLowerCase() === "cloudflare" &&
    headers.get("cf-ray")?.trim()
  ) {
    return { errorType: "CloudflareError", errorCode: "CLOUDFLARE_HTML_DENIAL" };
  }
  return { errorType: "HTTPError", errorCode: `HTTP_${status}` };
}
