import { useCallback, useEffect, useState } from "react";

import { adminRequest } from "@/lib/api";

import { useAdminAuth } from "./auth-context";

export interface AdminQuery<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** GET an admin endpoint; a 401 signs the dashboard out via handleApiError. */
export function useAdminQuery<T>(path: string): AdminQuery<T> {
  const { handleApiError } = useAdminAuth();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    adminRequest<T>("GET", path).then(
      ({ data: result }) => {
        if (cancelled) return;
        setData(result);
        setError(undefined);
        setLoading(false);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(handleApiError(failure));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, generation, handleApiError]);

  const reload = useCallback(() => {
    setLoading(true);
    setGeneration((value) => value + 1);
  }, []);

  return { data, error, loading, reload };
}
