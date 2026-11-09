"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";

interface Props {
  /** Nombre de la instalación: hay que escribirlo igual para confirmar. */
  installationName: string;
  onPurge: (confirmName: string) => Promise<ActionResult<{ deleted: number }>>;
}

/** "Borrar logs" (solo admin): confirma en un `<dialog>` escribiendo el nombre de la instalación. */
export default function PurgeLogsButton({ installationName, onPurge }: Props) {
  const router = useRouter();
  const dialogo = useRef<HTMLDialogElement>(null);
  const [texto, setTexto] = useState("");
  const [error, setError] = useState("");
  const [resultado, setResultado] = useState("");
  const [pendiente, startTransition] = useTransition();

  function abrir() {
    setTexto("");
    setError("");
    setResultado("");
    dialogo.current?.showModal();
  }

  function cerrar() {
    dialogo.current?.close();
  }

  function confirmar() {
    setError("");
    startTransition(async () => {
      const r = await onPurge(texto.trim());
      if (!r.ok) return setError(r.error);
      cerrar();
      setResultado(
        `Se borraron ${r.data.deleted} logs de la nube. Los paneles borran los suyos al sincronizar.`,
      );
      router.refresh();
    });
  }

  const coincide = texto.trim() === installationName;

  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <button type="button" className="btn-quiet" onClick={abrir}>
        Borrar logs
      </button>
      <p role="status" className="max-w-xs text-sm font-medium text-signal sm:text-right">
        {resultado}
      </p>
      <dialog
        ref={dialogo}
        aria-labelledby="borrar-logs-titulo"
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-5 text-text backdrop:bg-black/40"
      >
        <form
          method="dialog"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (coincide && !pendiente) confirmar();
          }}
        >
          <h3 id="borrar-logs-titulo" className="text-lg font-semibold">
            Borrar logs
          </h3>
          <p className="text-sm">
            Se borrarán todos los logs de acceso de la nube de esta instalación. No se puede deshacer.
          </p>
          <label className="text-sm font-medium">
            Escribe el nombre de la instalación para confirmar.
            <input
              className="field"
              value={texto}
              autoComplete="off"
              placeholder={installationName}
              onChange={(e) => setTexto(e.target.value)}
            />
          </label>
          <p role="alert" className="min-h-5 text-sm font-medium text-danger">
            {error}
          </p>
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-quiet" onClick={cerrar} disabled={pendiente}>
              Cancelar
            </button>
            <button
              type="submit"
              className="btn-danger"
              disabled={!coincide || pendiente}
            >
              {pendiente ? "Borrando…" : "Borrar logs"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
