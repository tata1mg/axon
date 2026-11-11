import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";

/** Accept hostnames/IPs only, not URLs, ports, wildcards or proxy credentials. */
export function normalizeNetworkHost(value: string): string {
  const trimmed = value.trim();
  const address = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(address) === 6) return new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (isIP(address) === 4) return address;
  if (/[:/@?#\\\s%[\]*]/.test(trimmed)) throw new Error("Enter a hostname or IP address only");
  const hostname = domainToASCII(trimmed.replace(/\.$/, "")).toLowerCase();
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Enter a valid hostname or IP address");
  // Canonicalize alternative IPv4 spellings in the same way HTTP URL parsing does.
  return new URL(`http://${hostname}`).hostname;
}

export const networkHostSchema = z
  .string()
  .min(1)
  .max(255)
  .transform((value, context) => {
    try {
      return normalizeNetworkHost(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid blocked host",
      });
      return z.NEVER;
    }
  });

export const blockedHostsSchema = z
  .array(networkHostSchema)
  .max(64)
  .transform((hosts) => [...new Set(hosts)]);

/** Domain entries cover the domain and its subdomains; IP entries match exactly. */
export function isBlockedNetworkHost(hostname: string, blockedHosts: readonly string[]): boolean {
  const normalized = normalizeNetworkHost(hostname);
  return blockedHosts.some(
    (blocked) => normalized === blocked || (!isIP(blocked) && normalized.endsWith(`.${blocked}`)),
  );
}
