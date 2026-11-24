"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";

interface Props {
  /** Solo el admin del tenant la ve (el servidor también lo exige). */
  canDelete: boolean;
  /** Nombre de la instalación: hay que escribirlo igual para confirmar. */
  installationName: string;
  /** A dónde ir tras eliminarla (la lista de instalaciones). */
  listPath: string;
  onDelete: (confirmName: string) => Promise<ActionResult>;
}

/**
 * Zona de peligro "Eliminar instalación" (solo admin): confirma en un `<dialog>` escribiendo el
 * nombre de la instalación y, al terminar, regresa a la lista de instalaciones.
 */
export default function DeleteInstallationButton({ canDelete, installationName, listPath, onDelete }: Props) {
  const router = useRouter();
  const dialogo = useRef<HTMLDialogElement>(null);
  const [texto, setTexto] = useState("");
  const [error, setError] = useState("");
  const [pendiente, startTransition] = useTransition();

  function abrir() {
    setTexto("");
    setError("");
    dialogo.current?.showModal();
  }

  function cerrar() {
    dialogo.current?.close();
  }

  function confirmar() {
    setError("");
    startTransition(async () => {
      const r = await onDelete(texto.trim());
      if (!r.ok) return setError(r.error);
      cerrar();
      router.replace(listPath);
    });
  }

  const coincide = texto.trim() === installationName;
  if (!canDelete) return null;

  return (
    <section
      aria-labelledby="zona-peligro-titulo"
      className="grid gap-3 rounded-lg border border-danger/40 p-4 sm:grid-cols-[1fr_auto] sm:items-center"
    >
      <div className="grid gap-1">
        <h2 id="zona-peligro-titulo" className="font-semibold text-danger">
          Zona de peligro
        </h2>
        <p className="text-sm">
          Eliminar la instalación borra todos sus datos de la nube. No se puede deshacer.
        </p>
      </div>
      <button type="button" className="btn-danger justify-self-start" onClick={abrir}>
        Eliminar instalación
      </button>
      <dialog
        ref={dialogo}
        aria-labelledby="eliminar-instalacion-titulo"
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
          <h3 id="eliminar-instalacion-titulo" className="text-lg font-semibold">
            Eliminar instalación
          </h3>
          <p className="text-sm">
            Se borrarán todos los datos de la instalación en la nube. Los paneles se desvinculan y siguen
            funcionando con sus datos locales.
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
            <button type="submit" className="btn-danger" disabled={!coincide || pendiente}>
              {pendiente ? "Eliminando…" : "Eliminar instalación"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
