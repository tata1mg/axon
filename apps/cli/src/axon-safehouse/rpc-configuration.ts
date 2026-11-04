import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { z } from "zod";

import { type AxonSafehouseMenuUI, runAxonSafehouseMenu } from "../cli/commands/axon-safehouse.ts";
import type { AxonSafehouseResumeSession, AxonSafehouseSession } from "../launcher/contracts.ts";
import type { AxonPaths } from "../product/paths.ts";
import { validateAxonSafehouseResumeSession } from "./configuration-relay.ts";

const DIALOG_PREFIX = "axon-safehouse-dialog-";
const MAX_RECORD_BYTES = 50 * 1024 * 1024;
const READ_COMMANDS = new Set([
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "get_messages",
  "get_commands",
]);
const DIALOG_METHODS = new Set(["select", "input", "confirm", "editor"]);
const stateSchema = z.object({
  sessionId: z.uuid(),
  sessionFile: z.string().optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  model: z.object({ provider: z.string(), id: z.string() }).optional(),
  thinkingLevel: z.string(),
  steeringMode: z.enum(["all", "one-at-a-time"]),
  followUpMode: z.enum(["all", "one-at-a-time"]),
  autoCompactionEnabled: z.boolean(),
});
type RpcState = z.infer<typeof stateSchema>;
type RpcRecord = Record<string, unknown>;

export interface AxonSafehouseRpcTransport {
  attach(input: Bun.FileSink, output: ReadableStream<Uint8Array>): void;
  detach(restarting: boolean): Promise<void>;
  dispose(): void;
}

function parseRecord(line: string): RpcRecord {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("RPC commands must be JSON objects");
  return value as RpcRecord;
}

/** Strict LF-only framing: Unicode separators inside JSON strings are not record boundaries. */
function lineReceiver(consume: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error("RPC record is too large");
      if (line.trim()) consume(line);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > MAX_RECORD_BYTES) throw new Error("RPC record is too large");
  };
}

/**
 * The parent owns both the editor and its response IDs. Child code never receives an approval
 * capability: even a compromised extension can neither submit grants nor approve its own dialog.
 * Keeping stdin/stdout here also keeps Paseo connected while a revoked Pi child is replaced.
 */
export function createAxonSafehouseRpcTransport(options: {
  readonly paths: AxonPaths;
  readonly cwd: string;
  readonly axonSafehouse: AxonSafehouseSession;
  readonly prepareRestart: (session: AxonSafehouseResumeSession) => () => void;
}): AxonSafehouseRpcTransport {
  const lifetime = new AbortController();
  const forwarded = new Map<string, RpcRecord>();
  const privateRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const childDialogs = new Set<string>();
  const waitingReads: RpcRecord[] = [];
  let input: Bun.FileSink | undefined;
  let outputDone = Promise.resolve();
  let editing = false;
  let restoring = false;
  let restartState: RpcState | undefined;
  let dialog: { id: string; resolve: (response: RpcRecord) => void } | undefined;
  let editor: AbortController | undefined;
  let listening = false;

  const emit = (record: RpcRecord): void => {
    if (lifetime.signal.aborted || process.stdout.destroyed) return;
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  const notify = (message: string, notifyType = "info"): void => {
    emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType });
  };
  const respond = (command: RpcRecord, error?: string): void => {
    emit({
      id: command["id"],
      type: "response",
      command: command["type"],
      success: error === undefined,
      ...(error === undefined ? { data: { disposition: "handled" } } : { error }),
    });
  };
  const send = (record: RpcRecord): void => {
    if (!input || lifetime.signal.aborted) throw new Error("Pi RPC is restarting or closed");
    input.write(`${JSON.stringify(record)}\n`);
    void Promise.resolve(input.flush()).catch(() => {});
  };
  const request = (command: RpcRecord): Promise<unknown> => {
    const id = `axon-control-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        privateRequests.delete(id);
        reject(new Error("Pi RPC did not respond; no Axon Safehouse changes were applied"));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timeout);
        privateRequests.delete(id);
      };
      privateRequests.set(id, {
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject(error) {
          cleanup();
          reject(error);
        },
      });
      try {
        send({ ...command, id });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  };
  const readIdleState = async (): Promise<RpcState> => {
    const state = stateSchema.parse(await request({ type: "get_state" }));
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0)
      throw new Error(
        "Wait for the current turn and queued messages to finish, then run /safehouse",
      );
    return state;
  };
  const ask = (record: RpcRecord, signal: AbortSignal): Promise<RpcRecord> => {
    signal.throwIfAborted();
    const id = `${DIALOG_PREFIX}${randomUUID()}`;
    return new Promise((resolve) => {
      const finish = (response: RpcRecord) => {
        signal.removeEventListener("abort", cancel);
        if (dialog?.id === id) dialog = undefined;
        resolve(response);
      };
      const cancel = () => finish({ cancelled: true });
      dialog = { id, resolve: finish };
      signal.addEventListener("abort", cancel, { once: true });
      emit({ ...record, type: "extension_ui_request", id });
    });
  };
  const menuUI = (signal: AbortSignal): AxonSafehouseMenuUI => {
    const notes: string[] = [];
    const title = (message: string) => {
      const value = stripVTControlCharacters([...notes, message].join("\n\n"));
      notes.length = 0;
      return value;
    };
    const select: AxonSafehouseMenuUI["select"] = async (settings) => {
      // Map exact displayed choices back to parent-owned values; free-text replies cannot grant access.
      const choices = settings.options.map((option) =>
        stripVTControlCharacters(
          `${option.label ?? String(option.value)}${option.hint ? ` · ${option.hint}` : ""}`,
        ),
      );
      const response = await ask(
        { method: "select", title: title(settings.message), options: choices },
        signal,
      );
      const value = response["value"];
      const index = typeof value === "string" ? choices.indexOf(value) : -1;
      if (response["cancelled"] === true || index === -1) return CANCEL_SYMBOL;
      return settings.options[index]?.value ?? CANCEL_SYMBOL;
    };
    return {
      select,
      async autocomplete(settings) {
        if (!Array.isArray(settings.options))
          throw new Error("RPC Axon Safehouse choices must be supplied by the parent");
        return select({ ...settings, options: settings.options });
      },
      async text(settings) {
        const response = await ask(
          { method: "input", title: title(settings.message), placeholder: settings.placeholder },
          signal,
        );
        if (response["cancelled"] === true) return CANCEL_SYMBOL;
        const value = response["value"];
        if (typeof value !== "string" || value.length > 4096)
          throw new Error("Enter a directory/file of at most 4096 characters");
        return value;
      },
      intro(message) {
        if (message) notes.push(message);
      },
      note(message, heading) {
        notes.push([heading, message].filter(Boolean).join("\n"));
      },
      outro(message) {
        if (message) notify(stripVTControlCharacters(message));
      },
      cancel(message) {
        if (message) notify(stripVTControlCharacters(message));
      },
    };
  };

  const edit = async (): Promise<void> => {
    const controller = new AbortController();
    editor = controller;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    let finishRestart: (() => void) | undefined;
    let checkpointed = false;
    let saved = false;
    try {
      const initial = await readIdleState();
      // Refuse signed-out, expired or changed backend policies before opening the editor.
      await options.axonSafehouse.configurationPolicy();
      signal.throwIfAborted();
      await request({ type: "prompt", message: "/safehouse" });
      checkpointed = true;
      const checkpoint = await readIdleState();
      if (checkpoint.sessionId !== initial.sessionId)
        throw new Error("The active chat changed; run /safehouse again");
      const resume = await validateAxonSafehouseResumeSession(options.paths, {
        sessionId: checkpoint.sessionId,
        ...(checkpoint.messageCount > 0 ? { sessionFile: checkpoint.sessionFile } : {}),
      });
      if (checkpoint.messageCount > 0 && !resume.sessionFile)
        throw new Error(
          "An in-memory chat cannot survive an Axon Safehouse restart; save it first",
        );
      saved = await runAxonSafehouseMenu(options.paths, options.cwd, menuUI(signal), {
        signal,
        requireTerminal: false,
        authorize: () => options.axonSafehouse.configurationPolicy(),
        async beforeSave() {
          signal.throwIfAborted();
          const current = await readIdleState();
          if (
            current.sessionId !== checkpoint.sessionId ||
            current.sessionFile !== checkpoint.sessionFile
          )
            throw new Error("The active chat changed; reopen the Axon Safehouse editor");
          await validateAxonSafehouseResumeSession(options.paths, resume);
          signal.throwIfAborted();
          finishRestart?.();
          finishRestart = options.prepareRestart(resume);
          restartState = current;
        },
      });
    } catch (error) {
      if (!lifetime.signal.aborted)
        notify(
          error instanceof Error ? error.message : "Could not configure Axon Safehouse permissions",
          "warning",
        );
    } finally {
      finishRestart?.();
      if (!saved) {
        restartState = undefined;
        if (checkpointed && input && !lifetime.signal.aborted)
          await request({ type: "prompt", message: "/safehouse --rpc-close" }).catch(() => {});
        editing = false;
      }
      if (editor === controller) editor = undefined;
    }
  };

  const forward = (command: RpcRecord): void => {
    const id = `axon-forward-${randomUUID()}`;
    forwarded.set(id, command);
    try {
      send({ ...command, id });
    } catch (error) {
      forwarded.delete(id);
      respond(command, error instanceof Error ? error.message : "Pi RPC is unavailable");
    }
  };
  const consumeInput = (line: string): void => {
    let command: RpcRecord;
    try {
      command = parseRecord(line);
    } catch {
      respond({ type: "parse" }, "Invalid RPC JSON command");
      return;
    }
    const type = command["type"];
    if (type === "extension_ui_response") {
      const id = command["id"];
      if (typeof id === "string" && id.startsWith(DIALOG_PREFIX)) {
        if (dialog?.id === id) dialog.resolve(command);
        return; // Late, duplicate and fabricated approvals must never reach the child.
      }
      if (typeof id === "string") childDialogs.delete(id);
      if (input) send(command);
      return;
    }
    if (typeof type !== "string") {
      respond(command, "RPC command type must be a string");
      return;
    }
    if (type === "abort" && editing && !restoring) {
      editor?.abort();
      emit({ id: command["id"], type: "response", command: type, success: true });
      return;
    }
    const safehouseCommand =
      type === "prompt" &&
      typeof command["message"] === "string" &&
      /^\/safehouse(?:\s|$)/.test(command["message"]);
    if (safehouseCommand) {
      if (command["message"] !== "/safehouse" || command["images"] !== undefined) {
        respond(command, "Use /safehouse without arguments or attachments");
        return;
      }
      if (editing || restoring || !input) {
        respond(command, "The Axon Safehouse editor or restart is already active");
        return;
      }
      if (
        childDialogs.size > 0 ||
        [...forwarded.values()].some((pending) => !READ_COMMANDS.has(String(pending["type"])))
      ) {
        respond(command, "Finish the current command or approval dialog, then run /safehouse");
        return;
      }
      editing = true;
      // Acknowledge before opening dialogs: clients must not time out a long human review.
      respond(command);
      void edit();
      return;
    }
    if ((editing || restoring) && !READ_COMMANDS.has(type)) {
      respond(command, "Finish or cancel Axon Safehouse settings before sending another command");
      return;
    }
    if (!input || restoring) {
      if (READ_COMMANDS.has(type) && waitingReads.length < 100) waitingReads.push(command);
      else respond(command, "Pi RPC is restarting; retry when Axon Safehouse settings are applied");
      return;
    }
    forward(command);
  };
  const receiveInput = lineReceiver(consumeInput);
  const inputDecoder = new StringDecoder("utf8");
  const onInput = (chunk: Buffer | string): void => {
    try {
      receiveInput(typeof chunk === "string" ? chunk : inputDecoder.write(chunk));
    } catch {
      notify(
        "RPC input exceeded its limits; closing the agent without applying further changes",
        "error",
      );
      closeInput();
    }
  };
  const closeInput = (): void => {
    lifetime.abort();
    editor?.abort();
    dialog?.resolve({ cancelled: true });
    for (const pending of privateRequests.values())
      pending.reject(new Error("RPC client disconnected"));
    try {
      void Promise.resolve(input?.end()).catch(() => {});
    } catch {
      // A disconnected client or an already-reaped child has no pipe left to close.
    }
  };

  const consumeOutput = (line: string): void => {
    const record = parseRecord(line);
    const id = record["id"];
    if (typeof id === "string" && id.startsWith(DIALOG_PREFIX)) return;
    // Streaming shell updates use the request ID too, not just the final response.
    const streamingCommand = typeof id === "string" ? forwarded.get(id) : undefined;
    if (record["type"] !== "response" && streamingCommand) {
      emit({ ...record, id: streamingCommand["id"] });
      return;
    }
    if (record["type"] === "response" && typeof id === "string") {
      const pending = privateRequests.get(id);
      if (pending) {
        if (record["success"] === true) pending.resolve(record["data"]);
        else pending.reject(new Error(String(record["error"] ?? "Pi RPC command failed")));
        return;
      }
      const original = forwarded.get(id);
      if (original) {
        forwarded.delete(id);
        emit({ ...record, id: original["id"] });
        return;
      }
      if (id.startsWith("axon-control-") || id.startsWith("axon-forward-")) return;
    }
    if (
      record["type"] === "extension_ui_request" &&
      typeof id === "string" &&
      DIALOG_METHODS.has(String(record["method"]))
    ) {
      if (editing || restoring) {
        if (input) send({ type: "extension_ui_response", id, cancelled: true });
        return;
      }
      childDialogs.add(id);
    }
    emit(record);
  };

  return {
    attach(childInput, childOutput) {
      lifetime.signal.throwIfAborted();
      input = childInput;
      const receiveOutput = lineReceiver(consumeOutput);
      outputDone = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of childOutput) {
          receiveOutput(decoder.decode(chunk, { stream: true }));
          if (process.stdout.writableNeedDrain) await once(process.stdout, "drain");
        }
        receiveOutput(`${decoder.decode()}\n`);
      })();
      // If framing fails, EOF asks Pi to shut down; no malformed output can trigger an approval.
      void outputDone.catch(() => closeInput());
      if (!listening) {
        listening = true;
        process.stdin.on("data", onInput);
        process.stdin.on("end", closeInput);
        process.stdin.on("error", closeInput);
        process.stdout.on("error", closeInput);
        if (process.stdin.readableEnded) closeInput();
      }
      const previous = restartState;
      if (previous) {
        restoring = true;
        void (async () => {
          const resumed = await readIdleState();
          if (resumed.sessionId !== previous.sessionId)
            throw new Error("Pi resumed a different chat");
          // Native resume usually restores the model/thinking level already. Do not reselect
          // unchanged models: selection also writes global defaults and requires a fresh catalog.
          if (
            previous.model &&
            (resumed.model?.provider !== previous.model.provider ||
              resumed.model.id !== previous.model.id)
          )
            await request({
              type: "set_model",
              provider: previous.model.provider,
              modelId: previous.model.id,
            });
          for (const [changed, command] of [
            [
              resumed.thinkingLevel !== previous.thinkingLevel,
              { type: "set_thinking_level", level: previous.thinkingLevel },
            ],
            [
              resumed.steeringMode !== previous.steeringMode,
              { type: "set_steering_mode", mode: previous.steeringMode },
            ],
            [
              resumed.followUpMode !== previous.followUpMode,
              { type: "set_follow_up_mode", mode: previous.followUpMode },
            ],
            [
              resumed.autoCompactionEnabled !== previous.autoCompactionEnabled,
              { type: "set_auto_compaction", enabled: previous.autoCompactionEnabled },
            ],
          ] as const) {
            if (changed) await request(command);
          }
          restartState = undefined;
          restoring = false;
          editing = false;
          notify("Axon Safehouse permissions applied. Your chat has resumed under the new rules.");
          for (const command of waitingReads.splice(0)) forward(command);
        })().catch((error: unknown) => {
          notify(error instanceof Error ? error.message : "Axon Safehouse restart failed", "error");
          // Do not accept work if restoring the approved session failed.
          closeInput();
        });
      } else {
        for (const command of waitingReads.splice(0)) forward(command);
      }
    },
    async detach(restarting) {
      input = undefined;
      await outputDone.catch(() => {});
      const error = new Error("Pi RPC restarted or closed; retry the command");
      for (const pending of privateRequests.values()) pending.reject(error);
      for (const command of forwarded.values()) respond(command, error.message);
      forwarded.clear();
      childDialogs.clear();
      if (restarting) restoring = true;
      else {
        editor?.abort();
        dialog?.resolve({ cancelled: true });
      }
    },
    dispose() {
      closeInput();
      process.stdin.off("data", onInput);
      process.stdin.off("end", closeInput);
      process.stdin.off("error", closeInput);
      process.stdout.off("error", closeInput);
      process.stdin.pause();
      for (const command of waitingReads.splice(0)) respond(command, "Pi RPC is closed");
    },
  };
}