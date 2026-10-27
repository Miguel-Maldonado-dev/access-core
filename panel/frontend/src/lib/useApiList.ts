"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}

/** Carga un recurso; solo la petición más reciente escribe el estado. `initial` debe ser estable. */
export function useApiResource<R>(path: string, initial: R) {
  const [data, setData] = useState<R>(initial);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let ignore = false;
    apiFetch<R>(path).then(
      (result) => {
        if (ignore) return;
        setData(result);
        setError("");
        setLoaded(true);
      },
      (err) => {
        if (ignore) return;
        setError(errorMessage(err));
        setLoaded(true);
      },
    );
    return () => {
      ignore = true;
    };
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, setError, loaded, reload };
}

const NO_ITEMS: never[] = [];

/** Carga una lista; solo la petición más reciente escribe el estado. */
export function useApiList<T>(path: string) {
  const { data, ...rest } = useApiResource<T[]>(path, NO_ITEMS);
  return { items: data, ...rest };
}
