import type { CaptureReason, PiResume } from "../../../sessions/contracts.ts";

/** Per-launch loopback capability only; no saved session or backend URL is read here. */
export class BackupRelayClient {
  constructor(
    private readonly origin: string,
    private readonly capability: string,
  ) {}

  private async request(action: string, body: unknown, signal?: AbortSignal): Promise<string> {
    const response = await fetch(new URL(`/_axon/backups/${action}`, this.origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error("Backup relay unavailable");
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("status" in result) ||
      typeof result.status !== "string"
    ) {
      throw new Error("Invalid backup relay response");
    }
    return result.status;
  }

  boundary(
    source: string | undefined,
    nativeId: string,
    resume: PiResume,
    reason: CaptureReason,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.request("capture", { source, nativeId, resume, reason }, signal);
  }

  async recordLeaf(source: string | undefined, nativeId: string, resume: PiResume): Promise<void> {
    await this.request("leaf", { source, nativeId, resume, reason: "manual" });
  }

  retry(): Promise<string> {
    return this.request("retry", {});
  }
  status(): Promise<string> {
    return this.request("status", {});
  }
}
