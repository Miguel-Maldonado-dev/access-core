"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Clock } from "@/lib/types";

const REFRESH_MS = 30_000;

export default function ClockBadge() {
  const [clock, setClock] = useState<Clock | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiFetch<Clock>("/api/system/clock")
        .then((c) => {
          if (!alive) return;
          setClock(c);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (failed && !clock) {
    return <p className="text-sm text-muted">Hora de la placa no disponible</p>;
  }
  if (!clock) return <p className="text-sm text-muted">Leyendo hora…</p>;

  return (
    <div className="text-right text-sm leading-snug">
      <p className="font-medium tabular-nums">{formatDateTime(clock.now)}</p>
      <p className="text-muted">{clock.timezone}</p>
      {clock.timezone !== "America/Mexico_City" && (
        <p role="status" className="max-w-sm text-warn">
          La placa está en la zona horaria {clock.timezone}; los horarios de los permisos se aplican en esa zona.
        </p>
      )}
      {clock.ntp_synchronized === false && (
        <p role="status" className="max-w-sm text-warn">
          La hora de la placa no está sincronizada; los horarios de los permisos pueden aplicarse mal.
        </p>
      )}
      {clock.ntp_synchronized === null && (
        <p role="status" className="text-muted">
          Sincronización desconocida
        </p>
      )}
    </div>
  );
}
