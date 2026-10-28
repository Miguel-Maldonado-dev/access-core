"use client";

import { useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import PasswordFields, { passwordMismatch } from "@/components/PasswordFields";
import type { ActionResult } from "@/lib/actions";
import type { TenantRole } from "@/lib/auth/guards";
import { ROLE_LABEL } from "@/lib/roles";
import type { AccountResult, MemberChange, TenantMember } from "@/lib/tenants/members";

interface Props {
  tenantId: string;
  currentUserId: string;
  members: TenantMember[];
  onAdd: (tenantId: string, email: string, password: string, role: TenantRole) => Promise<ActionResult<AccountResult>>;
  onChangeRole: (tenantId: string, userId: string, role: TenantRole) => Promise<ActionResult<MemberChange>>;
  onRemove: (tenantId: string, userId: string) => Promise<ActionResult<MemberChange>>;
}

/**
 * /t/[tenant]/users: agregar usuarios con su cuenta, cambiar de rol y quitar miembros. La regla de "al menos un
 * administrador" la aplica la base; aquí se muestra su mensaje.
 */
export default function MembersManager({
  tenantId,
  currentUserId,
  members,
  onAdd,
  onChangeRole,
  onRemove,
}: Props) {
  const [notice, setNotice] = useState<Notice>(null);
  const [pendiente, startTransition] = useTransition();

  function cambiarRol(m: TenantMember) {
    const nuevo: TenantRole = m.role === "admin" ? "tecnico" : "admin";
    const propio = m.userId === currentUserId;
    if (
      propio &&
      nuevo === "tecnico" &&
      !window.confirm("¿Dejar de ser administrador? Ya no podrás administrar a los usuarios de este tenant.")
    ) {
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onChangeRole(tenantId, m.userId, nuevo);
      setNotice(
        r.ok
          ? { kind: "ok", text: `${m.email} ahora es ${ROLE_LABEL[nuevo].toLowerCase()}.` }
          : { kind: "error", text: r.error },
      );
    });
  }

  function quitar(m: TenantMember) {
    const pregunta =
      m.userId === currentUserId
        ? "¿Salir de este tenant? Perderás el acceso a sus instalaciones."
        : `¿Quitar a ${m.email} del tenant? Perderá el acceso a sus instalaciones.`;
    if (!window.confirm(pregunta)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onRemove(tenantId, m.userId);
      setNotice(r.ok ? { kind: "ok", text: `Se quitó a ${m.email} del tenant.` } : { kind: "error", text: r.error });
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <AddMemberForm tenantId={tenantId} onAdd={onAdd} onNotice={setNotice} />

      {/* El aviso va junto a la tabla: vacío, apenas ocupa espacio. */}
      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Correo</th>
                <th scope="col" className="px-4 py-2 font-medium">Rol</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium [overflow-wrap:anywhere]">{m.email}</span>
                      {m.userId === currentUserId && <span className="tag text-muted">Tú</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3">{ROLE_LABEL[m.role]}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-end gap-1 whitespace-nowrap sm:flex-row sm:justify-end sm:gap-4">
                      <button
                        type="button"
                        className="link-action"
                        disabled={pendiente}
                        onClick={() => cambiarRol(m)}
                      >
                        {m.role === "admin" ? "Hacer técnico" : "Hacer administrador"}{" "}
                        <span className="sr-only">a {m.email}</span>
                      </button>
                      <button type="button" className="link-danger" disabled={pendiente} onClick={() => quitar(m)}>
                        Quitar <span className="sr-only">a {m.email}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AddMemberForm({
  tenantId,
  onAdd,
  onNotice,
}: {
  tenantId: string;
  onAdd: Props["onAdd"];
  onNotice: (notice: Notice) => void;
}) {
  const [correo, setCorreo] = useState("");
  const [rol, setRol] = useState<TenantRole>("tecnico");
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
      const r = await onAdd(tenantId, correo, clave, rol);
      if (!r.ok) {
        onNotice({ kind: "error", text: r.error });
        return;
      }
      const email = correo.trim().toLowerCase();
      onNotice({
        kind: "ok",
        text: r.data.existingAccount
          ? "Ese correo ya tenía cuenta: se agregó al tenant y conserva su contraseña."
          : `${email} ya puede iniciar sesión.`,
      });
      setCorreo("");
      setClave("");
      setRepetida("");
    });
  }

  return (
    <form onSubmit={enviar} noValidate className="panel" aria-labelledby="agregar-usuario">
      <h2 id="agregar-usuario" className="text-lg font-semibold">
        Agregar usuario
      </h2>
      <p className="mt-1 text-sm text-muted">
        Un técnico consulta y edita las instalaciones y sus paneles; un administrador, además, gestiona a
        los usuarios. Se crea la cuenta con esa contraseña, sin enviar ningún correo. Si el correo ya tiene
        cuenta, se conserva su contraseña.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:items-end">
        <label className="block text-sm font-medium">
          Correo
          <input
            className="field"
            type="email"
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label className="block text-sm font-medium">
          Rol
          <select className="field" value={rol} onChange={(e) => setRol(e.target.value as TenantRole)}>
            <option value="tecnico">{ROLE_LABEL.tecnico}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </select>
        </label>
        <PasswordFields
          label="Contraseña"
          confirmationLabel="Repite la contraseña"
          password={clave}
          confirmation={repetida}
          onPassword={setClave}
          onConfirmation={setRepetida}
        />
        <button type="submit" className="btn sm:col-span-2 sm:justify-self-start" disabled={pendiente}>
          {pendiente ? "Agregando…" : "Agregar usuario"}
        </button>
      </div>
    </form>
  );
}
