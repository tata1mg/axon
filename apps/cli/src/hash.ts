import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256, the one digest format Axon pins, keys and compares.
 * node:crypto, not Bun.CryptoHasher: Node-targeted Pi extension bundles import this too.
 */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
