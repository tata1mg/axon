import type { LiteLLMFeaturesConfig } from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";

/** pi-provider-litellm (4.9.0+) reads these before its settings.json feature blocks. */
export const LITELLM_FEATURE_VARIABLES = Object.freeze({
  mcp: "LITELLM_ENABLE_MCP",
  skills: "LITELLM_ENABLE_SKILLS",
  budget: "LITELLM_ENABLE_BUDGET",
});

export type LiteLLMFeature = keyof typeof LITELLM_FEATURE_VARIABLES;
export type LiteLLMFeatureStates = Readonly<Record<LiteLLMFeature, boolean>>;

/** Features whose variable Axon set, so a reload may update them without touching the user's own. */
export const LITELLM_MANAGED_FEATURES_VARIABLE = "PI_AXON_LITELLM_MANAGED_FEATURES";

/** Without backend values (offline, failed fetch, no litellmFeatures section) every feature is off. */
export function litellmFeatureStates(
  features: LiteLLMFeaturesConfig | undefined,
): LiteLLMFeatureStates {
  return {
    mcp: features?.mcp ?? false,
    skills: features?.skills ?? false,
    budget: features?.budget ?? false,
  };
}

/**
 * Backend switches for the provider's optional features. A non-blank value already in the user's
 * environment wins, so automated pipelines can turn features on or off; the provider treats a
 * blank value as unset, so Axon replaces it.
 */
export function createLiteLLMFeatureOverrides(
  inheritedEnvironment: NodeJS.ProcessEnv,
  features: LiteLLMFeaturesConfig | undefined,
): EnvironmentOverrides {
  const states = litellmFeatureStates(features);
  const overrides: Record<string, string | undefined> = {};
  const managed: LiteLLMFeature[] = [];
  for (const [feature, name] of Object.entries(LITELLM_FEATURE_VARIABLES) as [
    LiteLLMFeature,
    string,
  ][]) {
    if (inheritedEnvironment[name]?.trim()) continue;
    overrides[name] = states[feature] ? "1" : "0";
    managed.push(feature);
  }
  overrides[LITELLM_MANAGED_FEATURES_VARIABLE] = managed.length ? managed.join(",") : undefined;
  return overrides;
}
