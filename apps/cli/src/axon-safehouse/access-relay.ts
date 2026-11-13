import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { z } from "zod";

import type { AxonSafehouseMenuUI } from "../cli/commands/axon-safehouse.ts";
import type { AxonPaths } from "../product/paths.ts";
import { hasFilesystemAccessRequest, runFilesystemAccessPrompt } from "./access-requests.ts";
import type { AxonSafehousePolicy } from "./policy.ts";

type AccessReviewer = (id: string, signal: AbortSignal) => Promise<boolean>;
const rpcReviewers = new Map<string, AccessReviewer>();
const accessSchema = z.strictObject({ accessRequest: z.uuid() });

/** Only the parent RPC transport can register an approval UI and receive its response IDs. */
export function registerFilesystemAccessReviewer(
  paths: AxonPaths,
  reviewer: AccessReviewer,
): () => void {
  rpcReviewers.set(paths.home, reviewer);
  return () => {
    if (rpcReviewers.get(paths.home) === reviewer) rpcReviewers.delete(paths.home);
  };
}

/**
 * The child can request a review and render its state, but cannot submit a choice. TUI choices
 * come directly from the parent's terminal; RPC choices come from the parent-owned transport.
 */
export function createFilesystemAccessRelay(
  paths: AxonPaths,
  cwd: string,
  authorize: () => Promise<AxonSafehousePolicy>,
) {
  const lifetime = new AbortController();
  let busy = false;
  return {
    get isReviewing(): boolean {
      return busy;
    },
    async handle(request: Request): Promise<Response> {
      const reply = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
      try {
        if (lifetime.signal.aborted) return reply({ error: "Safehouse review is closed" }, 503);
        const body = await request.text();
        if (Buffer.byteLength(body) > 1024)
          return reply({ error: "Access request is too large" }, 413);
        const { accessRequest } = accessSchema.parse(JSON.parse(body));
        if (!hasFilesystemAccessRequest(paths, accessRequest))
          return reply({ error: "This filesystem access request expired" }, 410);
        if (busy) return reply({ error: "A filesystem access review is already active" }, 409);
        const signal = AbortSignal.any([
          request.signal,
          lifetime.signal,
          AbortSignal.timeout(10 * 60_000),
        ]);
        const reviewer = rpcReviewers.get(paths.home);
        if (reviewer) {
          busy = true;
          try {
            return reply({ saved: await reviewer(accessRequest, signal) });
          } finally {
            busy = false;
          }
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          return reply({ error: "Interactive filesystem approval is unavailable" }, 404);
        busy = true;
        const streamLifetime = new AbortController();
        const reviewSignal = AbortSignal.any([signal, streamLifetime.signal]);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: unknown) => {
              if (!streamLifetime.signal.aborted)
                controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
            };
            const notes: string[] = [];
            const select: AxonSafehouseMenuUI["select"] = async (settings) => {
              const title = stripVTControlCharacters([...notes, settings.message].join("\n\n"));
              const choices = settings.options.map((option) =>
                stripVTControlCharacters(
                  `${option.label ?? String(option.value)}${option.hint ? ` · ${option.hint}` : ""}`,
                ),
              );
              let selected = 0; // Denial is the safe default, including dismissal or timeout.
              const render = () => send({ type: "dialog", title, choices, selected });
              reviewSignal.throwIfAborted();
              return new Promise((resolve) => {
                let settled = false;
                let pasting = false;
                const wasRaw = process.stdin.isRaw;
                const finish = (
                  value: (typeof settings.options)[number]["value"] | typeof CANCEL_SYMBOL,
                ) => {
                  if (settled) return;
                  settled = true;
                  process.stdin.off("keypress", onKey);
                  process.stdin.off("end", cancel);
                  process.stdin.off("error", cancel);
                  reviewSignal.removeEventListener("abort", cancel);
                  process.stdin.pause();
                  process.stdin.setRawMode(wasRaw);
                  resolve(value);
                };
                const cancel = () => finish(CANCEL_SYMBOL);
                const onKey = (_text: string | undefined, key: Key) => {
                  // Bracketed paste must never be interpreted as a human approval.
                  if (key.sequence === "\x1b[200~") {
                    pasting = true;
                    return;
                  }
                  if (key.sequence === "\x1b[201~") {
                    pasting = false;
                    return;
                  }
                  if (pasting) return;
                  if (key.name === "escape" || (key.ctrl && key.name === "c")) cancel();
                  else if (key.name === "up" || key.name === "down") {
                    selected =
                      (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
                    render();
                  } else if (key.name === "return") {
                    finish(settings.options[selected]?.value ?? CANCEL_SYMBOL);
                  }
                };
                emitKeypressEvents(process.stdin);
                process.stdin.setRawMode(true);
                process.stdout.write("\x1b[?2004h");
                process.stdin.on("keypress", onKey);
                process.stdin.once("end", cancel);
                process.stdin.once("error", cancel);
                reviewSignal.addEventListener("abort", cancel, { once: true });
                render();
                process.stdin.resume();
              });
            };
            const ui: AxonSafehouseMenuUI = {
              select,
              async autocomplete() {
                throw new Error("Filesystem approval does not accept arbitrary paths");
              },
              async text() {
                throw new Error("Filesystem approval does not accept arbitrary paths");
              },
              intro(message) {
                if (message) notes.push(message);
              },
              note(message, heading) {
                notes.push([heading, message].filter(Boolean).join("\n"));
              },
              outro() {},
              cancel() {},
            };
            void (async () => {
              try {
                const saved = await runFilesystemAccessPrompt(paths, cwd, accessRequest, ui, {
                  signal: reviewSignal,
                  authorize,
                  liveGrant: true,
                  source: "tui",
                });
                send({ type: "complete", saved });
              } catch {
                send({ type: "complete", saved: false });
              } finally {
                busy = false;
                if (!streamLifetime.signal.aborted) controller.close();
              }
            })();
          },
          cancel() {
            streamLifetime.abort();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
        });
      } catch {
        return reply({ error: "Could not review this filesystem access request" }, 400);
      }
    },
    dispose() {
      lifetime.abort();
    },
  };
}
