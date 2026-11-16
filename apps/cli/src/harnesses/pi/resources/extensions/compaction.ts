import {
  compact,
  type ExtensionAPI,
  type ExtensionContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Launch environment compaction overrides, read on use. Axon applies explicitly supplied
 * backend fields at authenticated online startup, ahead of inherited local values.
 * Backend changes require a new launch, not /reload; this extension never fetches config.
 *   PI_COMPACTION_MODEL=litellm/your-summary-model (provider/model ID)
 *   PI_COMPACTION_THRESHOLD_TOKENS=80000
 *   PI_COMPACTION_MAX_OUTPUT_TOKENS=8192 (optional output cap)
 *   PI_COMPACTION_TIMEOUT_MS=120000
 *   PI_COMPACTION_ENABLED=false bypasses overrides, not native Pi compaction.
 *
 * Threshold requests run once the agent is idle, never midway through tools.
 * Retention, split turns, summary updates, and storage remain native to Pi.
 * No active model, settings files, model limits, or usage counters are mutated.
 */
type CompactionPreparation = Parameters<typeof compact>[0];
type SummaryModel = NonNullable<ExtensionContext["model"]>;

interface CompactionConfig {
  readonly enabled: boolean;
  readonly model: string | undefined;
  readonly thresholdTokens: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly timeoutMs: number | undefined;
}

const FAILURE_COOLDOWN_MS = 30_000;
// Keep this bus contract in sync with request-context.ts; this extension ships standalone.
const REQUEST_CONTEXT_CHANNEL = "axon:request-context";
const REQUEST_CONTEXT_READY_CHANNEL = "axon:request-context-ready";

interface RequestContext {
  tags(callKind: "compaction"): string;
  metadata(callKind: "compaction"): Readonly<Record<string, string>>;
  traceHeaders(): Readonly<Record<string, string>>;
}

function isRequestContext(value: unknown): value is RequestContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "tags") === "function" &&
    typeof Reflect.get(value, "metadata") === "function" &&
    typeof Reflect.get(value, "traceHeaders") === "function"
  );
}

const SESSION_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/**
 * Pi's header hook never runs for this request, so tag it here. Only LiteLLM receives the context.
 * pi-provider-litellm sets x-litellm-session-id in that hook, so set it here too; without it
 * Langfuse files the summary outside the session's other requests.
 */
function requestHeaders(
  context: RequestContext | undefined,
  model: SummaryModel,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (model.provider !== "litellm") return undefined;
  const headers: Record<string, string> = {
    ...(sessionId !== undefined && SESSION_ID.test(sessionId)
      ? { "x-litellm-session-id": sessionId }
      : {}),
    ...(context === undefined
      ? {}
      : {
          "x-litellm-tags": context.tags("compaction"),
          "x-litellm-spend-logs-metadata": JSON.stringify(context.metadata("compaction")),
          ...context.traceHeaders(),
        }),
  };
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function setting(name: string): string | undefined {
  return process.env[`PI_COMPACTION_${name}`]?.trim() || undefined;
}

function integerSetting(name: string): number | undefined {
  const raw = setting(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`PI_COMPACTION_${name} must be an integer between 1 and 2147483647`);
  }
  return value;
}

function readConfig(): CompactionConfig {
  const enabled = setting("ENABLED")?.toLowerCase();
  if (
    enabled !== undefined &&
    !["true", "1", "yes", "on", "false", "0", "no", "off"].includes(enabled)
  ) {
    throw new Error("PI_COMPACTION_ENABLED must be a boolean");
  }
  // Disabling the extension also bypasses validation of unused overrides.
  if (enabled !== undefined && ["false", "0", "no", "off"].includes(enabled)) {
    return {
      enabled: false,
      model: undefined,
      thresholdTokens: undefined,
      maxOutputTokens: undefined,
      timeoutMs: undefined,
    };
  }
  const model = setting("MODEL");
  if (model !== undefined && (model.indexOf("/") < 1 || model.endsWith("/"))) {
    throw new Error("PI_COMPACTION_MODEL must use provider/model-id format");
  }
  return {
    enabled: true,
    model,
    thresholdTokens: integerSetting("THRESHOLD_TOKENS"),
    maxOutputTokens: integerSetting("MAX_OUTPUT_TOKENS"),
    timeoutMs: integerSetting("TIMEOUT_MS"),
  };
}

function hasOverrides(config: CompactionConfig): boolean {
  return (
    config.enabled &&
    (config.model !== undefined ||
      config.thresholdTokens !== undefined ||
      config.maxOutputTokens !== undefined ||
      config.timeoutMs !== undefined)
  );
}

function summaryModel(ctx: ExtensionContext, config: CompactionConfig): SummaryModel {
  if (config.model === undefined) {
    if (!ctx.model) throw new Error("No active model is available for compaction");
    return ctx.model;
  }
  // IDs may contain slashes; only the first slash separates the provider.
  const separator = config.model.indexOf("/");
  const model = ctx.modelRegistry.find(
    config.model.slice(0, separator),
    config.model.slice(separator + 1),
  );
  if (!model) throw new Error(`Compaction model is not registered: ${config.model}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Compaction model has no configured authentication: ${config.model}`);
  }
  return model;
}

async function summarize(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: CompactionConfig,
  model: SummaryModel,
  preparation: CompactionPreparation,
  signal: AbortSignal,
  headers: Record<string, string> | undefined,
  customInstructions?: string,
) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 120_000)]);
  // Pi's extractor skips file metadata from hook-provided compactions. Restore
  // it explicitly so repeated custom summaries keep tracking previous files.
  const previousCompaction = ctx.sessionManager
    .getBranch()
    .findLast(
      (entry) => entry.type === "compaction" && entry.summary === preparation.previousSummary,
    );
  if (previousCompaction?.type === "compaction") {
    const details = previousCompaction.details as
      | { readFiles?: unknown; modifiedFiles?: unknown }
      | undefined;
    for (const filename of Array.isArray(details?.readFiles) ? details.readFiles : []) {
      if (typeof filename === "string") preparation.fileOps.read.add(filename);
    }
    for (const filename of Array.isArray(details?.modifiedFiles) ? details.modifiedFiles : []) {
      if (typeof filename === "string") preparation.fileOps.edited.add(filename);
    }
  }
  const result = await compact(
    preparation,
    model,
    undefined,
    headers,
    customInstructions,
    requestSignal,
    ctx.thinkingLevel ?? "off",
    (requestModel, context, options) => {
      // Resolve request-time auth through the chosen registered provider,
      // including LiteLLM's relay; never borrow another provider's credentials.
      // Pi 1.4 leaves maxTokens unset; clamp explicit caps to the model limit too.
      const stream = ctx.modelRegistry.streamSimple(requestModel, context, {
        ...options,
        ...(config.maxOutputTokens === undefined
          ? {}
          : {
              maxTokens: Math.min(
                options?.maxTokens ?? Number.POSITIVE_INFINITY,
                config.maxOutputTokens,
                requestModel.maxTokens > 0 ? requestModel.maxTokens : Number.POSITIVE_INFINITY,
              ),
            }),
      });
      const response = stream.result.bind(stream);
      stream.result = async () => {
        const message = await response();
        if (
          message.stopReason === "stop" &&
          !message.content.some((block) => block.type === "text" && block.text.trim().length > 0)
        ) {
          throw new Error("Compaction model returned an empty summary");
        }
        return message;
      };
      return stream;
    },
    undefined,
    SettingsManager.inMemory(pi.getSettings()).getRetrySettings(),
  ).catch((error: unknown) => {
    // Providers may wrap an abort in a generic error. Preserve our actual timeout/cancellation.
    requestSignal.throwIfAborted();
    throw error;
  });
  requestSignal.throwIfAborted();
  return result;
}

export default function compactionExtension(pi: ExtensionAPI): void {
  let summarizing = false;
  let thresholdRequestPending = false;
  let lastFailureAt = 0;
  let lastRequestedLeaf: string | null | undefined;
  let lastOutcome: "completed" | "aborted" | "error" | undefined;
  let summaryOutcome: "success" | "failed" | "skipped" | "cancelled" | undefined;
  let summaryReason: string | undefined;
  let requestContext: RequestContext | undefined;
  let readyRequestContext: (() => Promise<RequestContext>) | undefined;
  const warnings = new Set<string>();

  pi.events.on(REQUEST_CONTEXT_CHANNEL, (data) => {
    if (isRequestContext(data)) requestContext = data;
  });
  pi.events.on(REQUEST_CONTEXT_READY_CHANNEL, (data) => {
    if (typeof data === "function") readyRequestContext = data as () => Promise<RequestContext>;
  });

  // Match the recommender's content-free product-event contract. Never send summaries,
  // custom instructions, file metadata, credentials, or raw exception text.
  const emit = (stage: string, outcome: string, details: Record<string, unknown> = {}): void => {
    try {
      pi.events.emit("axon:telemetry", { category: "compaction", stage, outcome, ...details });
    } catch {
      /* Observability must never affect compaction or native history retention. */
    }
  };

  const warn = (ctx: ExtensionContext, message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  };

  const configFor = (ctx: ExtensionContext): CompactionConfig | undefined => {
    try {
      return readConfig();
    } catch (error) {
      // Configuration validation boundary: report invalid overrides and cancel, never fall back.
      warn(ctx, error instanceof Error ? error.message : "Invalid compaction configuration");
      return undefined;
    }
  };

  pi.on("session_start", () => {
    summarizing = false;
    thresholdRequestPending = false;
    lastFailureAt = 0;
    lastRequestedLeaf = undefined;
    lastOutcome = undefined;
    summaryOutcome = undefined;
    summaryReason = undefined;
    warnings.clear();
  });

  pi.on("turn_end", (event) => {
    lastOutcome = event.outcome;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const trigger =
      thresholdRequestPending && event.reason === "manual" ? "extension_threshold" : event.reason;
    const startedAt = Date.now();
    let modelId: string | undefined;
    summaryOutcome = undefined;
    summaryReason = undefined;
    const finish = (
      outcome: "success" | "failed" | "skipped" | "cancelled",
      reason?: string,
    ): void => {
      summaryOutcome = outcome;
      summaryReason = reason;
      emit("summarize", outcome, {
        trigger,
        reason,
        model: modelId,
        durationMs: Date.now() - startedAt,
      });
    };
    const config = configFor(ctx);
    // Fail closed: invalid overrides must not silently use an unintended model.
    if (!config) {
      finish("failed", "validation");
      return { cancel: true };
    }
    if (!hasOverrides(config)) return;
    if (
      event.reason === "threshold" &&
      config.thresholdTokens !== undefined &&
      event.preparation.tokensBefore < config.thresholdTokens
    ) {
      finish("skipped", "below_threshold");
      return { cancel: true };
    }
    if (summarizing) {
      finish("skipped", "busy");
      return { cancel: true };
    }
    if (event.reason === "threshold" && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
      finish("skipped", "cooldown");
      return { cancel: true };
    }
    summarizing = true;
    try {
      const model = summaryModel(ctx, config);
      modelId = `${model.provider}/${model.id}`;
      emit("summarize", "pending", { trigger, model: modelId });
      // RPC can compact a resumed session before the initial Git read has published a snapshot.
      const context =
        model.provider === "litellm" && readyRequestContext
          ? await readyRequestContext()
          : requestContext;
      event.signal.throwIfAborted();
      const compaction = await summarize(
        pi,
        ctx,
        config,
        model,
        event.preparation,
        event.signal,
        requestHeaders(context, model, ctx.sessionManager.getSessionId()),
        event.customInstructions,
      );
      // Native session_compact remains authoritative for durable completion and usage.
      finish("success");
      return { compaction };
    } catch (error: unknown) {
      // Compaction boundary: context/model/provider failures and cancellation keep history intact.
      // Return an explicit cancellation rather than sending an unattributed request or falling back.
      lastFailureAt = Date.now();
      finish(
        event.signal.aborted ? "cancelled" : "failed",
        event.signal.aborted
          ? "cancelled"
          : error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "unavailable",
      );
      if (!event.signal.aborted) {
        warn(
          ctx,
          "Configured compaction failed. History was kept; check /compaction-config and use /compact to retry.",
        );
      }
      return { cancel: true };
    } finally {
      summarizing = false;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const config = configFor(ctx);
    if (
      !config?.enabled ||
      config.thresholdTokens === undefined ||
      thresholdRequestPending ||
      summarizing ||
      lastOutcome !== "completed" ||
      ctx.signal?.aborted ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      pi.getSettings().compaction?.enabled === false ||
      Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    const tokens = ctx.getContextUsage()?.tokens;
    // Usage is unknown just after native compaction; don't use stale assistant usage.
    if (tokens === undefined || tokens === null || tokens < config.thresholdTokens) return;
    const leaf = ctx.sessionManager.getLeafId();
    if (leaf === lastRequestedLeaf) return;
    lastRequestedLeaf = leaf;
    thresholdRequestPending = true;
    // This request preserves native preparation/storage and backup/telemetry hooks.
    // Only await callbacks after isIdle(): awaiting during a tool/agent run would
    // deadlock its abort. Waiting here lets print/JSON sessions persist before exit.
    // Pi labels extension-requested compaction as manual, even for this trigger.
    // Publish the marker before requesting it so telemetry can distinguish automation.
    const startedAt = Date.now();
    summaryOutcome = undefined;
    summaryReason = undefined;
    emit("trigger", "auto_selected", { trigger: "extension_threshold" });
    await new Promise<void>((resolve) => {
      let completed = false;
      const finish = (succeeded: boolean): void => {
        if (completed) return;
        completed = true;
        thresholdRequestPending = false;
        const outcome = succeeded
          ? "success"
          : summaryOutcome === "success"
            ? "failed"
            : (summaryOutcome ?? "failed");
        emit("trigger", outcome, {
          trigger: "extension_threshold",
          ...(succeeded ? {} : { reason: summaryReason ?? "unavailable" }),
          durationMs: Date.now() - startedAt,
        });
        resolve();
        if (!succeeded) {
          lastFailureAt = Date.now();
          warn(
            ctx,
            "Threshold compaction could not complete. History was kept; use /compact to retry.",
          );
        }
      };
      try {
        ctx.compact({ onComplete: () => finish(true), onError: () => finish(false) });
      } catch {
        // Also clear the marker if the host cannot even enqueue the request.
        finish(false);
      }
    });
  });

  pi.registerCommand("compaction-config", {
    description: "Show compaction model and token threshold overrides (PI_COMPACTION_*)",
    handler: async (_args, ctx) => {
      const config = configFor(ctx);
      if (!config) return;
      const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
      let model = "active chat model";
      try {
        const resolved = summaryModel(ctx, config);
        model = `${resolved.provider}/${resolved.id}`;
      } catch (error) {
        // Diagnostic-command boundary: render model lookup/auth failures as status, not a request.
        model = error instanceof Error ? error.message : "Unavailable";
      }
      ctx.ui.notify(
        [
          `Compaction overrides: ${hasOverrides(config) ? "enabled" : "off (native Pi behavior)"}`,
          `Summary model: ${model}`,
          `Automatic compaction: ${settings.enabled ? "enabled" : "disabled in Pi settings"}`,
          `Trigger: ${config.thresholdTokens ?? "native Pi threshold"} tokens (checked when idle)`,
          `Keep recent: ${settings.keepRecentTokens} tokens (Pi settings)`,
          `Summary output cap: ${config.maxOutputTokens ?? "native Pi budget"} tokens`,
          `Timeout: ${config.timeoutMs ?? 120_000} ms for custom summaries`,
          "Configure backend COMPACTION or local PI_COMPACTION_* before launching Pi; backend fields win.",
          "Context-overflow recovery is not suppressed by the custom threshold.",
        ].join("\n"),
        "info",
      );
    },
  });
}
