"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}

/** Carga una lista; solo la petición más reciente escribe el estado. */
export function useApiList<T>(path: string) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let ignore = false;
    apiFetch<T[]>(path).then(
      (data) => {
        if (ignore) return;
        setItems(data);
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
  return { items, error, setError, loaded, reload };
}
