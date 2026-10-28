"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { CloudState, CloudStatus } from "@/lib/types";

const REFRESH_MS = 10_000;

const STATE_LABEL: Record<CloudState, string> = {
  unlinked: "Sin vincular",
  staging: "Importando datos a la plataforma",
  awaiting_review: "En revisión en la plataforma",
  active: "Vinculado",
};

const REVIEW_WARNING =
  "La importación está en revisión en la plataforma. Los cambios que hagas aquí mientras tanto se perderán al adoptar los datos de la nube.";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line px-4 py-3 last:border-0 sm:grid-cols-[14rem_1fr]">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function ClaimCode({ code }: { code: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted">Código de vinculación</p>
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-mono text-2xl font-semibold tracking-widest tabular-nums" aria-live="polite">
          {shown ? code : "••••••••"}
        </p>
        <button type="button" className="btn-quiet" onClick={() => setShown((v) => !v)}>
          {shown ? "Ocultar" : "Mostrar"}
        </button>
      </div>
    </div>
  );
}

export default function CloudPage() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiFetch<CloudStatus>("/api/cloud/status").then(
        (s) => {
          if (!alive) return;
          setStatus(s);
          setError("");
        },
        (err) => alive && setError(err instanceof Error ? err.message : "Ocurrió un error inesperado."),
      );
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Nube</h1>
      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {status && status.panel_code === null && (
        <p className="panel text-muted">El servicio de nube aún no ha generado la identidad del panel.</p>
      )}
      {status && status.panel_code !== null && (
        <>
          <section className="panel grid gap-5" aria-label="Identidad del panel">
            <div className="grid gap-1">
              <p className="text-sm text-muted">Identificador del panel</p>
              <p className="font-mono text-4xl font-semibold tracking-wider">{status.panel_code}</p>
            </div>
            {status.claim_code !== null && (
              <>
                <ClaimCode code={status.claim_code} />
                <p className="text-sm">Captura estos dos datos en la plataforma, en Instalación → Paneles → Vincular panel.</p>
              </>
            )}
          </section>

          {(status.state === "staging" || status.state === "awaiting_review") && (
            <p role="status" className="rounded border border-warn/40 bg-surface px-4 py-3 text-sm font-medium text-warn">
              {REVIEW_WARNING}
            </p>
          )}

          <dl className="overflow-hidden rounded-lg border border-line bg-surface">
            <Row label="Vinculación">{STATE_LABEL[status.state] ?? status.state}</Row>
            <Row label="Instalación">{status.installation_name ?? "—"}</Row>
            <Row label="Última sincronización">
              {status.last_sync_at ? formatDateTime(status.last_sync_at) : "Aún no sincroniza"}
            </Row>
            <Row label="Cambios pendientes">
              <span className="tabular-nums">{status.pending_changes}</span>
            </Row>
            <Row label="Último error">
              {status.last_error ? <span className="text-danger">{status.last_error}</span> : "Sin errores"}
            </Row>
          </dl>
        </>
      )}
    </div>
  );
}
