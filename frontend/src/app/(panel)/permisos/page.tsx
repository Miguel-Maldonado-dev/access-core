"use client";

import { useCallback, useEffect, useState } from "react";
import PermissionForm, { type PermissionPayload } from "@/components/PermissionForm";
import { apiFetch } from "@/lib/api";
import { outputLabel } from "@/lib/format";
import { fromMask } from "@/lib/masks";
import { minutesToHHMM } from "@/lib/time";
import type { Permission } from "@/lib/types";

type Editing = { permission?: Permission } | null;

const DAY_SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}

const readerLabel = (i: number) => `Reader${i + 1}`;

// Short names (S1, L2…) keep the table narrow; the full names stay in the tooltip.
function MaskCell({ mask, prefix, fullName, empty }: {
  mask: number;
  prefix: string;
  fullName: (i: number) => string;
  empty: string;
}) {
  const on = fromMask(mask, 4).flatMap((v, i) => (v ? [i] : []));
  return (
    <td className="px-4 py-2 whitespace-nowrap" title={on.length > 0 ? on.map(fullName).join(", ") : undefined}>
      {on.length > 0 ? on.map((i) => `${prefix}${i + 1}`).join(", ") : empty}
    </td>
  );
}

function daysText(mask: number): string {
  if (mask === 127) return "Todos los días";
  if (mask === 31) return "Lunes a viernes";
  const on = fromMask(mask, 7).flatMap((v, i) => (v ? [DAY_SHORT[i]] : []));
  return on.length > 0 ? on.join(", ") : "-";
}

function scheduleText(p: Permission): string {
  if (p.start_minute === p.end_minute) return "Todo el día";
  return `${minutesToHHMM(p.start_minute)} a ${minutesToHHMM(p.end_minute)}${p.start_minute > p.end_minute ? " (cruza medianoche)" : ""}`;
}

export default function PermissionsPage() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setPermissions(await apiFetch<Permission[]>("/api/permissions"));
    } catch (err) {
      setError(message(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    apiFetch<Permission[]>("/api/permissions")
      .then(setPermissions, (err) => setError(message(err)))
      .finally(() => setLoaded(true));
  }, []);

  async function save(payload: PermissionPayload) {
    const current = editing?.permission;
    try {
      await apiFetch(current ? `/api/permissions/${current.permission_id}` : "/api/permissions", {
        method: current ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setEditing(null);
      setError("");
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  async function remove(p: Permission) {
    if (!confirm(`¿Borrar el permiso ${p.permission_id} "${p.name}"? Se quitará de los titulares que lo tengan.`)) return;
    try {
      await apiFetch(`/api/permissions/${p.permission_id}`, { method: "DELETE" });
      setError("");
      await load();
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Permisos</h1>
        <button type="button" className="btn" onClick={() => setEditing({})}>
          Nuevo permiso
        </button>
      </div>

      {error !== "" && (
        <p role="alert" className="rounded border border-danger/40 bg-surface px-4 py-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {editing && (
        <section className="panel" aria-label={editing.permission ? "Editar permiso" : "Nuevo permiso"}>
          <h2 className="mb-4 text-lg font-semibold">{editing.permission ? "Editar permiso" : "Nuevo permiso"}</h2>
          <PermissionForm
            key={editing.permission?.permission_id ?? "nuevo"}
            permission={editing.permission}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-paper text-muted">
            <tr>
              <th className="px-4 py-2 text-right font-medium">Número</th>
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Salidas</th>
              <th className="px-4 py-2 font-medium">Tarjeta</th>
              <th className="px-4 py-2 font-medium">PIN</th>
              <th className="px-4 py-2 font-medium">RF</th>
              <th className="px-4 py-2 font-medium">Días</th>
              <th className="px-4 py-2 font-medium">Horario</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <tr key={p.permission_id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-right tabular-nums">{p.permission_id}</td>
                <td className="px-4 py-2 font-medium">{p.name}</td>
                <MaskCell mask={p.output_mask} prefix="S" fullName={outputLabel} empty="-" />
                <MaskCell mask={p.card_reader_mask} prefix="L" fullName={readerLabel} empty="—" />
                <MaskCell mask={p.pin_reader_mask} prefix="L" fullName={readerLabel} empty="—" />
                <td className="px-4 py-2">{p.allow_rf ? "Sí" : "—"}</td>
                <td className="px-4 py-2">{daysText(p.weekday_mask)}</td>
                <td className="px-4 py-2">{scheduleText(p)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <button type="button" className="mr-3 font-medium text-signal underline" onClick={() => setEditing({ permission: p })}>
                    Editar
                  </button>
                  <button type="button" className="font-medium text-danger underline" onClick={() => void remove(p)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
            {loaded && permissions.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-muted">
                  Aún no hay permisos. Crea el primero con Nuevo permiso.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="-mt-3 text-xs text-muted">S1–S4 = salidas (Relay1–Relay4) · L1–L4 = lectores (Reader1–Reader4)</p>
    </div>
  );
}
