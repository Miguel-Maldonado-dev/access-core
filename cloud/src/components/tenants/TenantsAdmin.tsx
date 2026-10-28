"use client";

import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import PasswordFields, { passwordMismatch } from "@/components/PasswordFields";
import type { ActionResult } from "@/lib/actions";
import type { CreatedTenant, TenantSummary } from "@/lib/tenants/admin";
import type { AccountResult } from "@/lib/tenants/members";

interface Props {
  tenants: TenantSummary[];
  onCreate: (name: string, adminEmail: string, password: string) => Promise<ActionResult<CreatedTenant>>;
  onSetSuspended: (tenantId: string, suspended: boolean) => Promise<ActionResult>;
  onAddAdmin: (tenantId: string, email: string, password: string) => Promise<ActionResult<AccountResult>>;
}

const CUENTA_EXISTENTE = "Ese correo ya tenía cuenta: se agregó como administrador y conserva su contraseña.";

/** /admin/tenants: alta de tenants con su primer administrador, lista, suspensión y altas de administradores. */
export default function TenantsAdmin({ tenants, onCreate, onSetSuspended, onAddAdmin }: Props) {
  const [notice, setNotice] = useState<Notice>(null);
  const [agregando, setAgregando] = useState<TenantSummary | null>(null);
  const [pendiente, startTransition] = useTransition();

  function cambiarSuspension(t: TenantSummary) {
    const suspender = t.suspendedAt === null;
    if (
      suspender &&
      !window.confirm(
        `¿Suspender «${t.name}»? Sus usuarios dejarán de verlo hasta que lo reactives. Los datos se conservan.`,
      )
    ) {
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onSetSuspended(t.id, suspender);
      setNotice(
        r.ok
          ? { kind: "ok", text: suspender ? `Se suspendió «${t.name}».` : `Se reactivó «${t.name}».` }
          : { kind: "error", text: r.error },
      );
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <NewTenantForm onCreate={onCreate} onNotice={setNotice} />

      {agregando && (
        <AddAdminForm
          key={agregando.id}
          tenant={agregando}
          onAddAdmin={onAddAdmin}
          onNotice={setNotice}
          onClose={() => setAgregando(null)}
        />
      )}

      {/* El aviso va junto a la tabla: vacío, apenas ocupa espacio. */}
      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Tenant</th>
                <th scope="col" className="px-4 py-2 font-medium">Administradores</th>
                <th scope="col" className="px-4 py-2 font-medium">Estado</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 font-medium">{t.name}</td>
                  <td className="px-4 py-3">
                    {t.admins.length === 0 ? (
                      <span className="text-muted">Sin administradores</span>
                    ) : (
                      <ul className="grid gap-1">
                        {t.admins.map((a) => (
                          <li key={a.userId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="[overflow-wrap:anywhere]">{a.email}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {t.suspendedAt === null ? (
                      <span className="tag text-signal">Activo</span>
                    ) : (
                      <span className="tag text-warn">Suspendido</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-end gap-1 whitespace-nowrap sm:flex-row sm:justify-end sm:gap-4">
                      <button
                        type="button"
                        className="link-action"
                        disabled={pendiente}
                        onClick={() => {
                          setNotice(null);
                          setAgregando(t);
                        }}
                      >
                        Agregar administrador <span className="sr-only">a {t.name}</span>
                      </button>
                      <button
                        type="button"
                        className={t.suspendedAt === null ? "link-danger" : "link-action"}
                        disabled={pendiente}
                        onClick={() => cambiarSuspension(t)}
                      >
                        {t.suspendedAt === null ? "Suspender" : "Reactivar"}{" "}
                        <span className="sr-only">{t.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    Aún no hay tenants. Crea el primero con el formulario de arriba.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NewTenantForm({
  onCreate,
  onNotice,
}: {
  onCreate: Props["onCreate"];
  onNotice: (notice: Notice) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [clave, setClave] = useState("");
  const [repetida, setRepetida] = useState("");
  const [pendiente, startTransition] = useTransition();

  function enviar(e: FormEvent) {
    e.preventDefault();
    const distintas = passwordMismatch(clave, repetida);
    if (distintas) {
      onNotice({ kind: "error", text: distintas });
      return;
    }
    onNotice(null);
    startTransition(async () => {
      const r = await onCreate(nombre, correo, clave);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      const creado = nombre.trim();
      const email = correo.trim().toLowerCase();
      onNotice({
        kind: "ok",
        text: r.data.existingAccount
          ? `Se creó el tenant ${creado}. ${CUENTA_EXISTENTE}`
          : `Se creó el tenant ${creado}. ${email} ya puede iniciar sesión.`,
      });
      setNombre("");
      setCorreo("");
      setClave("");
      setRepetida("");
    });
  }

  return (
    <form onSubmit={enviar} noValidate className="panel" aria-labelledby="nuevo-tenant">
      <h2 id="nuevo-tenant" className="text-lg font-semibold">
        Nuevo tenant
      </h2>
      <p className="mt-1 text-sm text-muted">
        Se crea la cuenta del administrador con esa contraseña, sin enviar ningún correo. Si el correo ya tiene
        cuenta, se conserva su contraseña.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 md:items-end">
        <label className="block text-sm font-medium">
          Nombre del tenant
          <input
            className="field"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            maxLength={100}
            autoComplete="organization"
            required
          />
        </label>
        <label className="block text-sm font-medium">
          Correo del administrador
          <input
            className="field"
            type="email"
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <PasswordFields
          label="Contraseña del administrador"
          confirmationLabel="Repite la contraseña del administrador"
          password={clave}
          confirmation={repetida}
          onPassword={setClave}
          onConfirmation={setRepetida}
        />
        <button type="submit" className="btn md:col-span-2 md:justify-self-start" disabled={pendiente}>
          {pendiente ? "Creando…" : "Crear tenant"}
        </button>
      </div>
    </form>
  );
}

function AddAdminForm({
  tenant,
  onAddAdmin,
  onNotice,
  onClose,
}: {
  tenant: TenantSummary;
  onAddAdmin: Props["onAddAdmin"];
  onNotice: (notice: Notice) => void;
  onClose: () => void;
}) {
  const [correo, setCorreo] = useState("");
  const [clave, setClave] = useState("");
  const [repetida, setRepetida] = useState("");
  const [pendiente, startTransition] = useTransition();

  function enviar(e: FormEvent) {
    e.preventDefault();
    const distintas = passwordMismatch(clave, repetida);
    if (distintas) {
      onNotice({ kind: "error", text: distintas });
      return;
    }
    onNotice(null);
    startTransition(async () => {
      const r = await onAddAdmin(tenant.id, correo, clave);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      const email = correo.trim().toLowerCase();
      onNotice({
        kind: "ok",
        text: r.data.existingAccount
          ? CUENTA_EXISTENTE
          : `${email} ya puede iniciar sesión como administrador de «${tenant.name}».`,
      });
      onClose();
    });
  }

  return (
    <form onSubmit={enviar} noValidate className="panel" aria-labelledby="agregar-admin">
      <h2 id="agregar-admin" className="text-lg font-semibold">
        Agregar administrador a «{tenant.name}»
      </h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2 md:items-end">
        <label className="block text-sm font-medium md:col-span-2">
          Correo del nuevo administrador
          <input
            className="field"
            type="email"
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            autoComplete="off"
            autoFocus
            required
          />
        </label>
        <PasswordFields
          label="Contraseña del nuevo administrador"
          confirmationLabel="Repite la contraseña del nuevo administrador"
          password={clave}
          confirmation={repetida}
          onPassword={setClave}
          onConfirmation={setRepetida}
        />
        <div className="flex gap-3 md:col-span-2">
          <button type="submit" className="btn" disabled={pendiente}>
            {pendiente ? "Agregando…" : "Agregar administrador"}
          </button>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </form>
  );
}
