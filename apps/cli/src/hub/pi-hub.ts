import { openBrowser } from "../launcher/browser.ts";
import type { AxonPaths } from "../product/paths.ts";
import { type LocalHub, startLocalHub } from "./server.ts";

export interface PiHub {
  /** Return a private link only when the system browser could not be opened. */
  open(): Promise<string | undefined>;
  dispose(): void;
}

/** Owned by the launcher, so the Hub survives Pi's /reload but not Pi's exit. */
export function createPiHub(
  paths: AxonPaths,
  options: { readonly offline: boolean; readonly openBrowser?: typeof openBrowser },
): PiHub {
  const lifetime = new AbortController();
  const open = options.openBrowser ?? openBrowser;
  let hub: LocalHub | undefined;
  let opening: Promise<string | undefined> | undefined;

  async function launch(): Promise<string | undefined> {
    // Each invocation needs a fresh one-use link. Replace the old listener rather
    // than keep stale sessions (or accumulate ports) on repeated invocations.
    await hub?.stop();
    lifetime.signal.throwIfAborted();
    const next = startLocalHub(paths, { catalogEnabled: !options.offline });
    hub = next;
    try {
      await open(next.launchUrl, AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]));
    } catch {
      lifetime.signal.throwIfAborted();
      return next.launchUrl;
    }
    return undefined;
  }

  return {
    open() {
      opening ??= launch().finally(() => {
        opening = undefined;
      });
      return opening;
    },
    dispose() {
      lifetime.abort();
      const current = hub;
      hub = undefined;
      void current?.stop().catch(() => {});
    },
  };
}
