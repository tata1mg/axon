import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, errorMessage, isRequestError } from "../api.ts";
import { useHub } from "../hub-context.ts";
import type { CatalogView } from "./model.ts";

interface CatalogState {
  readonly view?: CatalogView;
  readonly error?: string;
  readonly loading: boolean;
}

interface Catalog extends CatalogState {
  /** Ask the hub, which asks the backend, for the published catalog again. */
  readonly load: () => Promise<void>;
  /** An install returns the refreshed view; keep it without another round trip. */
  readonly replace: (view: CatalogView) => void;
}

const CatalogContext = createContext<Catalog | null>(null);

export function useCatalog(): Catalog {
  const catalog = useContext(CatalogContext);
  if (!catalog) throw new Error("useCatalog needs a <CatalogProvider>.");
  return catalog;
}

/** Kept above the tabs, so switching away from Discover and back doesn’t refetch. */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const { endSession } = useHub();
  const [state, setState] = useState<CatalogState>({ loading: false });
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((current) => ({ ...current, loading: true }));
    try {
      setState({ view: await api<CatalogView>("/catalog"), loading: false });
    } catch (error) {
      if (isRequestError(error) && error.status === 401) endSession();
      else setState((current) => ({ ...current, error: errorMessage(error), loading: false }));
    } finally {
      inFlight.current = false;
    }
  }, [endSession]);

  const replace = useCallback((view: CatalogView) => setState({ view, loading: false }), []);
  const value = useMemo(() => ({ ...state, load, replace }), [state, load, replace]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}
