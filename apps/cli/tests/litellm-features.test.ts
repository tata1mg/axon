import { describe, expect, test } from "bun:test";

import {
  createLiteLLMFeatureOverrides,
  LITELLM_MANAGED_FEATURES_VARIABLE,
} from "../src/harnesses/pi/litellm-features.ts";

const features = { mcp: true, skills: false, budget: true };

describe("LiteLLM feature switches", () => {
  test("project backend litellmFeatures as LITELLM_ENABLE_* and mark them managed", () => {
    expect(createLiteLLMFeatureOverrides({}, features)).toEqual({
      LITELLM_ENABLE_MCP: "1",
      LITELLM_ENABLE_SKILLS: "0",
      LITELLM_ENABLE_BUDGET: "1",
      [LITELLM_MANAGED_FEATURES_VARIABLE]: "mcp,skills,budget",
    });
  });

  test("turn every feature off without backend values", () => {
    expect(createLiteLLMFeatureOverrides({}, undefined)).toEqual({
      LITELLM_ENABLE_MCP: "0",
      LITELLM_ENABLE_SKILLS: "0",
      LITELLM_ENABLE_BUDGET: "0",
      [LITELLM_MANAGED_FEATURES_VARIABLE]: "mcp,skills,budget",
    });
  });

  test("leave a user's own non-blank values for the provider and replace blank ones", () => {
    const inherited = {
      LITELLM_ENABLE_MCP: "0",
      LITELLM_ENABLE_SKILLS: "true",
      LITELLM_ENABLE_BUDGET: "  ",
    };
    expect(createLiteLLMFeatureOverrides(inherited, features)).toEqual({
      LITELLM_ENABLE_BUDGET: "1",
      [LITELLM_MANAGED_FEATURES_VARIABLE]: "budget",
    });
    const all = { LITELLM_ENABLE_MCP: "1", LITELLM_ENABLE_SKILLS: "0", LITELLM_ENABLE_BUDGET: "0" };
    expect(createLiteLLMFeatureOverrides(all, features)).toEqual({
      [LITELLM_MANAGED_FEATURES_VARIABLE]: undefined,
    });
  });
});
