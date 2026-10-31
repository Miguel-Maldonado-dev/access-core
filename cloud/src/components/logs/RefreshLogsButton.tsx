"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import type { LogsUploadRequest } from "@/lib/panel-commands";

interface Props {
  /** Avisa a los paneles en línea que suban sus logs pendientes. */
  onRequest: () => Promise<ActionResult<LogsUploadRequest>>;
  /** Paneles avisados que aún no suben logs desde `since`. */
  onStatus: (since: string) => Promise<ActionResult<{ pending: string[] }>>;
}

/** Cada cuánto se pregunta si ya llegaron los logs. */
const CONSULTA_MS = 2_000;
/** Espera máxima: pasado este tiempo se muestra lo último recibido. */
const ESPERA_MS = 15_000;

/** Si una acción lanza en vez de devolver un ActionResult (red o base de datos). */
const FALLO_INESPERADO = "No se pudo consultar el panel. Intenta de nuevo.";

const esperar = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * "Actualizar logs": pide a los paneles en línea que suban sus logs, espera a que lleguen
 * (hasta 15 s) y refresca la página. Los paneles sin conexión se nombran: de ellos se
 * muestra lo último que se recibió.
 */
export default function RefreshLogsButton({ onRequest, onStatus }: Props) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [sinConexion, setSinConexion] = useState<string[]>([]);
  /** Aviso de tiempo agotado: paneles en línea que no subieron sus logs a tiempo. */
  const [sinRespuesta, setSinRespuesta] = useState("");
  // Estado propio y no `useTransition`: React entrelaza las transiciones asíncronas en curso
  // y esta espera larga dejaría "pendiente" cualquier otra acción de la página.
  const [sincronizando, setSincronizando] = useState(false);
  // Si se sale de la página a media espera, deja de consultar.
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  async function actualizar() {
    setError("");
    setSinConexion([]);
    setSinRespuesta("");
    setSincronizando(true);
    try {
      await sincronizar();
    } catch {
      // Error de red o de la base: se avisa y se muestra lo que haya llegado.
      if (montado.current) {
        setError(FALLO_INESPERADO);
        router.refresh();
      }
    } finally {
      if (montado.current) setSincronizando(false);
    }
  }

  async function sincronizar() {
    const r = await onRequest();
    if (!montado.current) return;
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const { requestedAt, panels } = r.data;
    setSinConexion(panels.filter((p) => !p.online).map((p) => p.panel_code));

    let pendientes = panels.filter((p) => p.online).map((p) => p.id);
    const fin = Date.now() + ESPERA_MS;
    while (pendientes.length > 0 && Date.now() < fin) {
      await esperar(Math.min(CONSULTA_MS, fin - Date.now()));
      if (!montado.current) return;
      const estado = await onStatus(requestedAt);
      if (!montado.current) return;
      if (!estado.ok) {
        // Se deja de esperar, pero se muestra lo que haya llegado.
        setError(estado.error);
        router.refresh();
        return;
      }
      pendientes = estado.data.pending;
    }

    router.refresh();
    if (pendientes.length > 0) {
      const codigos = panels.filter((p) => pendientes.includes(p.id)).map((p) => p.panel_code);
      setSinRespuesta(`Sin respuesta de ${codigos.join(", ")}: se muestra lo último recibido.`);
    }
  }

  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <button type="button" className="btn-quiet" onClick={actualizar} disabled={sincronizando}>
        {sincronizando ? "Sincronizando…" : "Actualizar logs"}
      </button>
      {error !== "" && (
        <p role="alert" className="notice-error">
          {error}
        </p>
      )}
      {/* Advertencias (paneles sin conexión y tiempo agotado): la región existe siempre para
          que los lectores de pantalla anuncien lo que aparezca en ella. */}
      <div role="status" className="grid gap-1 text-sm font-medium text-warn">
        {sinConexion.length > 0 && (
          <ul className="grid gap-1">
            {sinConexion.map((codigo) => (
              <li key={codigo}>{`Panel ${codigo} sin conexión`}</li>
            ))}
          </ul>
        )}
        {sinRespuesta !== "" && <p>{sinRespuesta}</p>}
      </div>
    </div>
  );
}
