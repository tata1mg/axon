import { isAbsolute } from "node:path";

const PASSTHROUGH = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  // Pi uses these non-secret markers to copy to the client clipboard over OSC 52.
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "MOSH_CONNECTION",
  "PI_CLIPBOARD_OSC52",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "COLUMNS",
  "LINES",
  "SDKROOT",
  "DEVELOPER_DIR",
  // Non-secret RPC client markers are needed for dialog recovery and model selection.
  "PASEO_AGENT_ID",
  "PI_MODEL_RECOMMENDER_RPC",
  "PI_AXON_CLI_VERSION",
  "PI_AXON_LAUNCH_STARTED_AT",
  "PI_AXON_STARTUP_TIP",
  "PI_CODING_AGENT_DIR",
  "PI_AXON_GIT_AI_BIN",
  "PI_AXON_AUTH_RELAY_URL",
  "PI_AXON_AUTH_RELAY_KEY",
  "PI_AXON_CONFIG_REFRESH_ENABLED",
  "PI_AXON_SANDBOX_OPERATIONS",
  "PI_TERMINAL_MANAGED_CONFIG",
  "PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS",
  "PI_TERMINAL_BLOCKED_COMMANDS",
  "PI_TERMINAL_APPROVAL_TIMEOUT_MS",
  "PI_SKIP_VERSION_CHECK",
  "PI_COMPACTION_ENABLED",
  "PI_COMPACTION_MODEL",
  "PI_COMPACTION_THRESHOLD_TOKENS",
  "PI_COMPACTION_MAX_OUTPUT_TOKENS",
  "PI_COMPACTION_TIMEOUT_MS",
  "PI_MODEL_RECOMMENDER_API_KEY",
  "PI_MODEL_RECOMMENDER_URL",
  "PI_MODEL_RECOMMENDER_DISABLED",
  "PI_MODEL_RECOMMENDER_TIMEOUT_MS",
  "PI_MODEL_RECOMMENDER_AUTO_SELECT_MS",
  "LITELLM_API_KEY",
  "LITELLM_BASE_URL",
  "LITELLM_DISPLAY_NAME",
  "LITELLM_DISCOVERY_TIMEOUT_MS",
  "LITELLM_DEFAULT_CONTEXT_WINDOW",
  "PI_WEB_SEARCH_URL",
  "PI_WEB_SEARCH_API_KEY",
  "PI_WEB_SEARCH_ENABLED",
  "PI_WEB_SEARCH_MODEL",
  "PI_WEB_SEARCH_TEMPERATURE",
  "PI_WEB_SEARCH_THINKING_LEVEL",
  "PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE",
  "PI_WEB_SEARCH_USE_URL_CONTEXT",
  "PI_WEB_SEARCH_REQUIRE_GROUNDING",
  "PI_WEB_SEARCH_TIMEOUT_MS",
  "PI_WEB_SEARCH_MAX_QUERY_CHARACTERS",
  "PI_WEB_SEARCH_MAX_RESULT_CHARACTERS",
  "PI_WEB_SEARCH_MAX_OUTPUT_TOKENS",
  "PI_WEB_SEARCH_MAX_SOURCES",
  "PI_ORG_OTEL_ENABLED",
  "PI_ORG_OTEL_MANAGED_ENDPOINT",
  "PI_ORG_OTEL_MANAGED_HOME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTEL_METRIC_EXPORT_INTERVAL",
] as const;

/** Build from nothing: ambient tokens, shell hooks, injection variables and Safehouse flags stay out. */
export function sandboxEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  temporary: string,
  proxyUrl: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  environment["HOME"] = home;
  environment["PATH"] = (source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    .split(":")
    .filter((entry) => isAbsolute(entry))
    .join(":");
  environment["SHELL"] = "/bin/sh";
  environment["TMPDIR"] = temporary;
  environment["TMP"] = temporary;
  environment["TEMP"] = temporary;
  environment["XDG_CACHE_HOME"] = `${temporary}/cache`;
  environment["npm_config_cache"] = `${temporary}/npm-cache`;
  environment["PIP_CACHE_DIR"] = `${temporary}/pip-cache`;
  environment["BUN_INSTALL_CACHE_DIR"] = `${temporary}/bun-cache`;
  environment["HTTP_PROXY"] = proxyUrl;
  environment["HTTPS_PROXY"] = proxyUrl;
  environment["http_proxy"] = proxyUrl;
  environment["https_proxy"] = proxyUrl;
  environment["NO_PROXY"] = "127.0.0.1";
  environment["no_proxy"] = "127.0.0.1";
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["PI_AXON_SANDBOX"] = "safehouse";
  return environment;
}
