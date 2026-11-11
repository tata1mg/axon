import { isAbsolute } from "node:path";

import { createHarnessEnvironment } from "../launcher/environment.ts";

const PASSTHROUGH = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  // Pi uses these non-secret markers to copy to the client clipboard over OSC 52.
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "MOSH_CONNECTION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
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
  "PI_AXON_SAFEHOUSE_OPERATIONS",
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

/** Sessions retain application/MCP credentials; installers and probes inherit only essentials. */
export function axonSafehouseEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  temporary: string,
  proxyUrl: string | undefined,
  inheritApplicationEnvironment = false,
): NodeJS.ProcessEnv {
  // MCP env/header templates and credential commands can use arbitrary variable names.
  // Keep the normal launcher filtering instead of maintaining an MCP credential allowlist.
  const environment: NodeJS.ProcessEnv = inheritApplicationEnvironment
    ? createHarnessEnvironment(source)
    : {};
  for (const name of PASSTHROUGH) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  // Preserve normal Git identity, transport, config and credential-helper settings.
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("GIT_") && value !== undefined) environment[name] = value;
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
  environment["UV_CACHE_DIR"] = `${temporary}/uv-cache`;
  environment["UV_PYTHON_INSTALL_DIR"] = `${temporary}/uv-python`;
  // An empty user blocklist leaves networking untouched, including corporate proxies.
  // Opt-in filtering is best-effort: clients that bypass HTTP proxies remain unrestricted.
  if (proxyUrl) {
    environment["HTTP_PROXY"] = proxyUrl;
    environment["HTTPS_PROXY"] = proxyUrl;
    environment["http_proxy"] = proxyUrl;
    environment["https_proxy"] = proxyUrl;
    // Do not automatically exempt localhost or private services from user blocks.
    environment["NO_PROXY"] = "";
    environment["no_proxy"] = "";
    delete environment["ALL_PROXY"];
    delete environment["all_proxy"];
  }
  environment["PI_AXON_SAFEHOUSE"] = "safehouse";
  return environment;
}
