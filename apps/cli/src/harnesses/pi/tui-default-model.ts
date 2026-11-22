import type { TuiDefaultModelConfig } from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";
import { piOptionTokens } from "./setup/packages/invocation.ts";

/** Read by the tui-default-model and managed-config extensions; keep the names in sync. */
export const TUI_DEFAULT_MODEL_VARIABLES = Object.freeze({
  /** The parts the backend supplies, so /reload may update them: "model", "thinkingLevel". */
  managed: "PI_AXON_TUI_MODEL_MANAGED",
  provider: "PI_AXON_TUI_MODEL_PROVIDER",
  model: "PI_AXON_TUI_MODEL",
  thinkingLevel: "PI_AXON_TUI_THINKING_LEVEL",
});

export const TUI_DEFAULT_MODEL_REMOVALS: EnvironmentOverrides = Object.freeze(
  Object.fromEntries(Object.values(TUI_DEFAULT_MODEL_VARIABLES).map((name) => [name, undefined])),
);

const MODEL_SELECTION_FLAGS = ["--model", "--models", "--provider", "--thinking"];

/** The user chose the model or thinking level for this launch, so no TUI default applies. */
export function selectsPiModel(userArguments: readonly string[]): boolean {
  return piOptionTokens(userArguments).some((argument) =>
    MODEL_SELECTION_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
  );
}

function exported(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return value?.trim() ? value : undefined;
}

/**
 * The model new interactive (TUI) sessions start with while the user has no saved Pi default.
 *
 * Values the user exported win over the backend: PI_AXON_TUI_MODEL_PROVIDER with
 * PI_AXON_TUI_MODEL (both, or neither counts), and PI_AXON_TUI_THINKING_LEVEL on its own. Parts
 * the backend supplies are listed in PI_AXON_TUI_MODEL_MANAGED, even without a backend value, so a
 * /reload can update them. RPC, print, json and launches with model flags get none of these.
 */
export function createTuiDefaultModelOverrides(
  inheritedEnvironment: NodeJS.ProcessEnv,
  interactive: boolean,
  userArguments: readonly string[],
  config: TuiDefaultModelConfig | undefined,
): EnvironmentOverrides {
  if (!interactive || selectsPiModel(userArguments)) return TUI_DEFAULT_MODEL_REMOVALS;
  const names = TUI_DEFAULT_MODEL_VARIABLES;
  const managed: string[] = [];
  const userProvider = exported(inheritedEnvironment, names.provider);
  const userModel = exported(inheritedEnvironment, names.model);
  const userThinking = exported(inheritedEnvironment, names.thinkingLevel);
  const ownModel = userProvider !== undefined && userModel !== undefined;
  if (!ownModel) managed.push("model");
  if (userThinking === undefined) managed.push("thinkingLevel");
  return {
    [names.managed]: managed.length > 0 ? managed.join(",") : undefined,
    [names.provider]: ownModel ? userProvider : config?.provider,
    [names.model]: ownModel ? userModel : config?.model,
    [names.thinkingLevel]: userThinking ?? config?.thinkingLevel,
  };
}
