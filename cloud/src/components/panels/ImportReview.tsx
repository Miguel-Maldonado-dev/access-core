"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import { NO_PENDING_IMPORT_MESSAGE } from "@/lib/device/import-messages";
import type {
  ConfirmImportResult,
  ImportButtonSummary,
  ImportConflict,
  ImportDiff,
  ImportItem,
} from "@/lib/device/imports";

interface Props {
  panelId: string;
  panelCode: string;
  /** Pestaña Paneles, a donde volver. */
  backHref: string;
  diff: ImportDiff;
  /** `admin` del tenant: un técnico solo ve la lista. */
  canImport: boolean;
  onConfirm: (panelId: string, selectedIds: string[]) => Promise<ActionResult<ConfirmImportResult>>;
}

const BOTON_RF = (b: ImportButtonSummary) => `Botón ${b.button + 1} · RF ${b.rf_code}`;

function describir(item: ImportItem): { titulo: string; detalle: ReactNode } {
  switch (item.type) {
    case "holder": {
      const partes = [
        item.kind === "domicilio" ? "Domicilio" : "Persona",
        ...(item.department ? [item.department] : []),
        ...(item.has_pin ? ["Con PIN"] : []),
      ];
      return {
        titulo: item.name,
        detalle: (
          <>
            <span className="block text-muted">{partes.join(", ")}</span>
            {(item.cards.length > 0 || item.controls.length > 0) && (
              <ul className="mt-1 list-disc pl-5 text-muted">
                {item.cards.map((k) => (
                  <li key={k.id}>
                    Tarjeta {k.card_code}
                    {k.description && ` (${k.description})`}
                  </li>
                ))}
                {item.controls.map((c) => (
                  <li key={c.id}>
                    {c.description || "Control"}
                    {c.buttons.length > 0 && `: ${c.buttons.map((b) => `RF ${b.rf_code}`).join(", ")}`}
                  </li>
                ))}
              </ul>
            )}
          </>
        ),
      };
    }
    case "card":
      return {
        titulo: `Tarjeta ${item.card_code}`,
        detalle: <span className="block text-muted">Para {item.holder_name}</span>,
      };
    case "control":
      return {
        titulo: item.description || "Control",
        detalle: (
          <span className="block text-muted">
            Para {item.holder_name}
            {item.buttons.length > 0 && `: ${item.buttons.map((b) => `RF ${b.rf_code}`).join(", ")}`}
          </span>
        ),
      };
    case "button":
      return {
        titulo: `${BOTON_RF(item)}`,
        detalle: (
          <span className="block text-muted">
            Nuevo en {item.control_description || "el control"} de {item.holder_name}
          </span>
        ),
      };
    case "pin":
      return {
        titulo: `PIN de ${item.holder_name}`,
        detalle: <span className="block text-muted">El titular ya existe; se agrega su PIN.</span>,
      };
  }
}

function describirConflicto(c: ImportConflict): string {
  switch (c.type) {
    case "pin":
      return `PIN de ${c.holder_name}`;
    case "card":
      return `Tarjeta ${c.card_code} de ${c.holder_name}`;
    case "control_button":
      return `RF ${c.rf_code} de ${c.holder_name}`;
    case "permission":
      return `Perfil ${c.name}`;
  }
}

/**
 * Revisión de la importación de un panel (`awaiting_review`): lo que solo tiene el panel,
 * con casillas, y lo que choca con la nube, en solo lectura. Nunca muestra PIN.
 */
export default function ImportReview({ panelId, panelCode, backHref, diff, canImport, onConfirm }: Props) {
  const router = useRouter();
  const idBase = useId();
  const [marcados, setMarcados] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  function alternar(id: string) {
    setMarcados((previo) => {
      const siguiente = new Set(previo);
      if (!siguiente.delete(id)) siguiente.add(id);
      return siguiente;
    });
  }

  function importar() {
    setNotice(null);
    startTransition(async () => {
      const r = await onConfirm(panelId, [...marcados]);
      if (r.ok) {
        router.push(backHref);
        return;
      }
      if (r.status === 409 && r.error === NO_PENDING_IMPORT_MESSAGE) {
        // Otro administrador ya resolvió la importación: la pantalla ya no tiene sentido.
        router.push(`${backHref}?aviso=sin-importacion`);
        return;
      }
      if (r.status === 409) {
        // La instalación cambió: se recarga el diff.
        setMarcados(new Set());
        setNotice({ kind: "error", text: `${r.error} Se recargó la lista; revisa y marca de nuevo.` });
        router.refresh();
        return;
      }
      setNotice({ kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <Link href={backHref} className="link-action text-sm">
          Volver a Paneles
        </Link>
        <h2 className="mt-2 text-xl font-semibold">
          Revisar importación de <span className="font-mono">{panelCode}</span>
        </h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          La instalación ya tiene datos. Marca lo que quieras traer de este panel; lo demás se queda solo en el
          panel. Al importar, el panel pasa a estar activo y sincroniza con la nube.
        </p>
      </div>

      <section aria-labelledby={`${idBase}-solo`} className="panel">
        <h3 id={`${idBase}-solo`} className="text-lg font-semibold">
          Solo en el panel ({diff.onlyInPanel.length})
        </h3>
        {diff.onlyInPanel.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No hay nada nuevo que importar.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {diff.onlyInPanel.map((item) => {
              const { titulo, detalle } = describir(item);
              const idCasilla = `${idBase}-${item.id}`;
              return (
                <li key={item.id} className="flex gap-3 py-3 text-sm">
                  <input
                    id={idCasilla}
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-signal"
                    checked={marcados.has(item.id)}
                    disabled={!canImport || pendiente}
                    onChange={() => alternar(item.id)}
                    aria-labelledby={`${idCasilla}-t`}
                  />
                  <div>
                    <label htmlFor={idCasilla} id={`${idCasilla}-t`} className="font-medium">
                      {titulo}
                    </label>
                    {detalle}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {diff.conflicts.length > 0 && (
        <section aria-labelledby={`${idBase}-conf`} className="panel">
          <h3 id={`${idBase}-conf`} className="text-lg font-semibold">
            Conflictos ({diff.conflicts.length})
          </h3>
          <p className="mt-1 text-sm text-muted">Estos no se importan: la nube ya tiene un dato que choca.</p>
          <ul className="mt-3 divide-y divide-line">
            {diff.conflicts.map((c) => (
              <li key={`${c.type}-${c.id}`} className="py-3 text-sm">
                <span className="font-medium">{describirConflicto(c)}</span>
                <span className="block text-warn">{c.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        {canImport && (
          <div>
            <button type="button" className="btn" disabled={pendiente} onClick={importar}>
              {pendiente ? "Importando…" : "Importar seleccionados"}
            </button>
            <span className="ml-3 text-sm text-muted">
              {marcados.size === 0 ? "Sin selección: solo se activa el panel." : `${marcados.size} marcados`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
