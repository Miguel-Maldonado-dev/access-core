"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { ClaimedPanel } from "@/lib/panels/claim";
import { PANEL_STATUS_LABEL, TABLE_LABEL, formatSync, isBehind, type PanelRow } from "@/lib/panels/view";

interface Props {
  installationId: string;
  /** /t/[tenant]/installations/[id]/paneles, base de la pantalla de importación. */
  basePath: string;
  installationRevision: number;
  panels: PanelRow[];
  /** Aviso con que se abre la pestaña (p. ej., al volver de una importación ya resuelta). */
  initialNotice?: Notice;
  /** `admin` del tenant: solo él ve las acciones de escritura (las acciones ya dan 403 a un técnico). */
  canAdmin: boolean;
  onClaim: (installationId: string, panelCode: string, claimCode: string) => Promise<ActionResult<ClaimedPanel>>;
  onRevoke: (panelId: string) => Promise<ActionResult>;
  onConfirmDeletions: (panelId: string) => Promise<ActionResult>;
}

/** Pestaña Paneles: vincular, monitorear, revocar y confirmar borrados masivos. */
export default function PanelsManager({
  installationId,
  basePath,
  installationRevision,
  panels,
  canAdmin,
  initialNotice = null,
  onClaim,
  onRevoke,
  onConfirmDeletions,
}: Props) {
  const [notice, setNotice] = useState<Notice>(initialNotice);
  const [pendiente, startTransition] = useTransition();

  function revocar(p: PanelRow) {
    if (
      !window.confirm(
        `¿Revocar ${p.panel_code}? El panel deja de sincronizar con la nube y vuelve a modo local; podrá vincularse de nuevo con un código nuevo.`,
      )
    ) {
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onRevoke(p.id);
      setNotice(r.ok ? { kind: "ok", text: `Se revocó ${p.panel_code}.` } : { kind: "error", text: r.error });
    });
  }

  function confirmarBorrados(p: PanelRow) {
    setNotice(null);
    startTransition(async () => {
      const r = await onConfirmDeletions(p.id);
      setNotice(
        r.ok
          ? { kind: "ok", text: `Borrados confirmados para ${p.panel_code}: el panel podrá aplicarlos durante una hora.` }
          : { kind: "error", text: r.error },
      );
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      {canAdmin && <ClaimForm installationId={installationId} onClaim={onClaim} onNotice={setNotice} />}

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        {panels.length === 0 ? (
          <p className="panel text-muted">
            Esta instalación aún no tiene paneles.
            {canAdmin
              ? " Escribe arriba el código del panel y el código de vinculación que muestra su pantalla Nube."
              : " Un administrador del tenant puede vincular uno."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-paper text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Panel</th>
                  <th scope="col" className="px-4 py-2 font-medium">Estado</th>
                  <th scope="col" className="px-4 py-2 font-medium">Conexión</th>
                  <th scope="col" className="px-4 py-2 font-medium">Última sincronización</th>
                  <th scope="col" className="px-4 py-2 font-medium">Revisión</th>
                  <th scope="col" className="px-4 py-2 font-medium">Versión</th>
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {panels.map((p) => (
                  <tr key={p.id} className="border-b border-line align-top last:border-0">
                    <th scope="row" className="px-4 py-3 font-mono font-medium whitespace-nowrap">
                      {p.panel_code}
                    </th>
                    <td className="px-4 py-3">
                      <span className="block">{PANEL_STATUS_LABEL[p.status]}</span>
                      {p.sync_blocked && (
                        <span className="mt-1 block max-w-64 text-warn">
                          Borrado masivo detenido: borraría {p.sync_blocked.would_delete} de {p.sync_blocked.total}{" "}
                          {TABLE_LABEL[p.sync_blocked.table] ?? p.sync_blocked.table}.
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {p.online ? (
                        <span className="tag text-signal">En línea</span>
                      ) : (
                        <span className="tag text-muted">Fuera de línea</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{formatSync(p.last_sync_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {p.synced_revision} de {installationRevision}{" "}
                      {isBehind(p, installationRevision) && <span className="tag text-warn">Atrasado</span>}
                    </td>
                    <td className="px-4 py-3">{p.software_version ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-end gap-1 whitespace-nowrap sm:flex-row sm:justify-end sm:gap-4">
                        {p.status === "awaiting_review" && (
                          <Link href={`${basePath}/${p.id}/importacion`} className="link-action">
                            Revisar importación <span className="sr-only">de {p.panel_code}</span>
                          </Link>
                        )}
                        {canAdmin && p.sync_blocked && (
                          <button
                            type="button"
                            className="link-action"
                            disabled={pendiente}
                            onClick={() => confirmarBorrados(p)}
                          >
                            Confirmar borrados <span className="sr-only">de {p.panel_code}</span>
                          </button>
                        )}
                        {canAdmin && p.status !== "revoked" && (
                          <button type="button" className="link-danger" disabled={pendiente} onClick={() => revocar(p)}>
                            Revocar <span className="sr-only">{p.panel_code}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ClaimForm({
  installationId,
  onClaim,
  onNotice,
}: {
  installationId: string;
  onClaim: Props["onClaim"];
  onNotice: (notice: Notice) => void;
}) {
  const [codigo, setCodigo] = useState("");
  const [vinculacion, setVinculacion] = useState("");
  const [pendiente, startTransition] = useTransition();

  function enviar(e: FormEvent) {
    e.preventDefault();
    onNotice(null);
    startTransition(async () => {
      const r = await onClaim(installationId, codigo, vinculacion);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      onNotice({
        kind: "ok",
        text: `Se vinculó ${r.data.panel_code}. El panel empezará a sincronizar en unos minutos.`,
      });
      setCodigo("");
      setVinculacion("");
    });
  }

  return (
    <form onSubmit={enviar} noValidate className="panel" aria-labelledby="vincular-panel">
      <h2 id="vincular-panel" className="text-lg font-semibold">
        Vincular panel
      </h2>
      <p className="mt-1 text-sm text-muted">
        Los dos códigos aparecen en la pantalla Nube del panel, con la forma PNL-XXXX-XXXX y 8 caracteres.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="block text-sm font-medium">
          Código del panel
          <input
            className="field font-mono uppercase"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="PNL-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <label className="block text-sm font-medium">
          Código de vinculación
          <input
            className="field font-mono uppercase"
            value={vinculacion}
            onChange={(e) => setVinculacion(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <button type="submit" className="btn" disabled={pendiente}>
          {pendiente ? "Vinculando…" : "Vincular panel"}
        </button>
      </div>
    </form>
  );
}
