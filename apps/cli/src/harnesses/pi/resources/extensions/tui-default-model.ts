import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

// Keep in sync with tui-default-model.ts in the launcher; each extension ships standalone.
const MANAGED = "PI_AXON_TUI_MODEL_MANAGED";
const PROVIDER = "PI_AXON_TUI_MODEL_PROVIDER";
const MODEL = "PI_AXON_TUI_MODEL";
const THINKING_LEVEL = "PI_AXON_TUI_THINKING_LEVEL";
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Starts new TUI sessions on the organization's model while the user has no saved Pi default.
 *
 * Without a saved default Pi picks the first available model, which for LiteLLM is alphabetical.
 * The launcher passes the model only to interactive launches without --model, --models,
 * --provider or --thinking; values the user exported win over the backend's. A resumed, forked or
 * reloaded session keeps its own model, and a model scope (enabledModels or --models) keeps Pi's
 * choice. Nothing is saved: once the user picks a model with /model, Pi saves it as their default
 * and this stops applying. A model that is not available to the user is skipped.
 *
 * Thinking level: one the user exported always applies. The backend's yields to a thinking level
 * the user saved, globally or for this model.
 */
export default function tuiDefaultModel(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    if (ctx.mode !== "tui") return;
    const provider = process.env[PROVIDER];
    const modelId = process.env[MODEL];
    if (!provider || !modelId) return;

    const settings = pi.getSettings();
    // Pi only uses a saved default when both are set.
    if (settings.defaultProvider && settings.defaultModel) return;
    if (ctx.scopedModels.length > 0) return;
    if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;

    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
    if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
      if (!(await pi.setModel(model))) return;
    }

    // Pi clamps the level to what the model supports.
    const level = process.env[THINKING_LEVEL];
    if (!level || !THINKING_LEVELS.has(level)) return;
    const fromBackend = process.env[MANAGED]?.split(",").includes("thinkingLevel") ?? false;
    const saved =
      settings.defaultThinkingLevel !== undefined ||
      settings.modelThinkingLevels?.[`${model.provider}/${model.id}`] !== undefined;
    if (!fromBackend || !saved) pi.setThinkingLevel(level as ThinkingLevel);
  });
}
