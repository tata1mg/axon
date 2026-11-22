import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REFRESH_TIMEOUT_MS = 2500;
const WARNING = "Axon could not refresh Pi defaults; keeping the current settings.";
// Keep in sync with litellm-features.ts; each extension ships standalone.
const LITELLM_FEATURE_VARIABLES: Readonly<Record<string, string>> = {
  mcp: "LITELLM_ENABLE_MCP",
  skills: "LITELLM_ENABLE_SKILLS",
  budget: "LITELLM_ENABLE_BUDGET",
};

/**
 * Update only the LITELLM_ENABLE_* variables the launcher set, before the provider reloads and
 * reads them. Variables the user exported themselves are never in the managed list.
 */
function applyLiteLLMFeatures(body: unknown): void {
  const features =
    body !== null && typeof body === "object"
      ? (body as { litellmFeatures?: unknown }).litellmFeatures
      : undefined;
  if (features === null || typeof features !== "object") return;
  const managed = process.env["PI_AXON_LITELLM_MANAGED_FEATURES"]?.split(",") ?? [];
  for (const feature of managed) {
    const name = LITELLM_FEATURE_VARIABLES[feature];
    const enabled = (features as Record<string, unknown>)[feature];
    if (name !== undefined && typeof enabled === "boolean") process.env[name] = enabled ? "1" : "0";
  }
}

// Keep in sync with tui-default-model.ts; each extension ships standalone.
const TUI_DEFAULT_MODEL_VARIABLES = {
  provider: "PI_AXON_TUI_MODEL_PROVIDER",
  model: "PI_AXON_TUI_MODEL",
  thinkingLevel: "PI_AXON_TUI_THINKING_LEVEL",
} as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Update the TUI default model for later /new sessions. Only the parts the launcher took from the
 * backend change; values the user exported stay. Null clears them; a malformed value keeps them.
 */
function applyTuiDefaultModel(body: unknown): void {
  const managed = process.env["PI_AXON_TUI_MODEL_MANAGED"]?.split(",") ?? [];
  if (body === null || typeof body !== "object" || !("tuiDefaultModel" in body)) return;
  const value = (body as { tuiDefaultModel: unknown }).tuiDefaultModel;
  if (value !== null && typeof value !== "object") return;
  const fields = (value ?? {}) as Record<string, unknown>;
  const provider = text(fields["provider"]);
  const model = text(fields["model"]);
  if (value !== null && (provider === undefined || model === undefined)) return;
  const set = (name: string, entry: string | undefined) => {
    if (entry === undefined) delete process.env[name];
    else process.env[name] = entry;
  };
  if (managed.includes("model")) {
    set(TUI_DEFAULT_MODEL_VARIABLES.provider, provider);
    set(TUI_DEFAULT_MODEL_VARIABLES.model, model);
  }
  if (managed.includes("thinkingLevel")) {
    set(TUI_DEFAULT_MODEL_VARIABLES.thinkingLevel, text(fields["thinkingLevel"]));
  }
}

/** Refresh before Pi rereads settings and reruns provider factories, not after session_start. */
export default function managedConfig(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload" || process.env["PI_AXON_CONFIG_REFRESH_ENABLED"] !== "true")
      return;
    const origin = process.env["PI_AXON_AUTH_RELAY_URL"];
    const capability = process.env["PI_AXON_AUTH_RELAY_KEY"];
    if (!origin || !capability) return;
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid managed relay origin");
      const response = await fetch(new URL("/_axon/pi-defaults/refresh", url), {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Managed config refresh failed");
      }
      const body: unknown = await response.json();
      applyLiteLLMFeatures(body);
      applyTuiDefaultModel(body);
    } catch {
      // Never log the response, credential, upstream error, or request URL.
      if (ctx.hasUI) ctx.ui.notify(WARNING, "warning");
      else process.stderr.write(`${WARNING}\n`);
    }
  });
}
