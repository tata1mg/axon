import { createContext, useContext } from "react";
import type { HubSession } from "./api.ts";

export interface Hub {
  readonly session: HubSession;
  /** Replaces the page with the restart instructions after a 401. */
  readonly endSession: () => void;
}

export const HubContext = createContext<Hub | null>(null);

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error("useHub needs a connected <App>.");
  return hub;
}
