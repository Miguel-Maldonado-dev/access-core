"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import Notices, { type Notice } from "@/components/Notices";
import type { ActionResult } from "@/lib/actions";
import type { ApiKeyRow, CreatedApiKey } from "@/lib/api/keys";
import { DEFAULT_REQUESTS_PER_MINUTE, MENSAJE_LIMITE, parseRequestsPerMinute } from "@/lib/api/rate-limit";
import { formatSync } from "@/lib/panels/view";

interface Props {
  tenantId: string;
  keys: ApiKeyRow[];
  onCreate: (tenantId: string, name: string, requestsPerMinute: number) => Promise<ActionResult<CreatedApiKey>>;
  onRevoke: (tenantId: string, keyId: string) => Promise<ActionResult<void>>;
  onRotate: (tenantId: string, keyId: string) => Promise<ActionResult<CreatedApiKey>>;
  onUpdateLimit: (tenantId: string, keyId: string, requestsPerMinute: number) => Promise<ActionResult<ApiKeyRow>>;
}

/**
 * /t/[tenant]/api: crear, rotar y revocar llaves de la API pública. El secreto recién creado
 * o rotado vive solo en el estado de este componente: no se guarda en la URL, el navegador
 * ni el servidor, y desaparece al recargar.
 */
/** Número del campo, o `null` si no cumple 1–5000 (el mensaje lo pone `MENSAJE_LIMITE`). */
function leerLimite(texto: string): number | null {
  try {
    return parseRequestsPerMinute(texto);
  } catch {
    return null;
  }
}

export default function ApiKeysManager({ tenantId, keys, onCreate, onRevoke, onRotate, onUpdateLimit }: Props) {
  const [nombre, setNombre] = useState("");
  const [limite, setLimite] = useState(String(DEFAULT_REQUESTS_PER_MINUTE));
  const [errorLimite, setErrorLimite] = useState<string | null>(null);
  const [editando, setEditando] = useState<{ id: string; valor: string; error: string | null } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [secreto, setSecreto] = useState<{ name: string; secret: string } | null>(null);
  const [copia, setCopia] = useState<string | null>(null);
  const [pendiente, startTransition] = useTransition();
  const avisoSecreto = useRef<HTMLElement>(null);

  // Al crear o rotar, el foco pasa al aviso del secreto para que se lea de inmediato.
  useEffect(() => {
    if (secreto) avisoSecreto.current?.focus();
  }, [secreto]);

  function mostrar(r: ActionResult<CreatedApiKey>, aviso: string): boolean {
    if (!r.ok) {
      setNotice({ kind: "error", text: r.error });
      return false;
    }
    setSecreto({ name: r.data.key.name, secret: r.data.secret });
    setCopia(null);
    setNotice({ kind: "ok", text: aviso });
    return true;
  }

  function crear(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    const n = leerLimite(limite);
    if (n === null) {
      setErrorLimite(MENSAJE_LIMITE);
      return;
    }
    setErrorLimite(null);
    startTransition(async () => {
      if (mostrar(await onCreate(tenantId, nombre, n), "Llave creada.")) {
        setNombre("");
        setLimite(String(DEFAULT_REQUESTS_PER_MINUTE));
      }
    });
  }

  function guardarLimite(e: FormEvent, k: ApiKeyRow) {
    e.preventDefault();
    if (!editando) return;
    const n = leerLimite(editando.valor);
    if (n === null) {
      setEditando({ ...editando, error: MENSAJE_LIMITE });
      return;
    }
    setNotice(null);
    startTransition(async () => {
      const r = await onUpdateLimit(tenantId, k.id, n);
      if (r.ok) {
        setEditando(null);
        setNotice({ kind: "ok", text: `Límite de "${k.name}" actualizado a ${n} por minuto.` });
      } else {
        setEditando((actual) => (actual ? { ...actual, error: r.error } : actual));
      }
    });
  }

  function rotar(k: ApiKeyRow) {
    if (!window.confirm(`¿Rotar la llave "${k.name}"? La actual dejará de funcionar de inmediato.`)) return;
    setNotice(null);
    startTransition(async () => {
      mostrar(await onRotate(tenantId, k.id), `Llave "${k.name}" rotada.`);
    });
  }

  function revocar(k: ApiKeyRow) {
    if (!window.confirm(`¿Revocar la llave "${k.name}"? Las integraciones que la usen dejarán de funcionar.`)) return;
    setNotice(null);
    startTransition(async () => {
      const r = await onRevoke(tenantId, k.id);
      setNotice(r.ok ? { kind: "ok", text: `Llave "${k.name}" revocada.` } : { kind: "error", text: r.error });
    });
  }

  async function copiar() {
    if (!secreto) return;
    try {
      await navigator.clipboard.writeText(secreto.secret);
      setCopia("Copiada.");
    } catch {
      setCopia("Copia el texto manualmente.");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <form onSubmit={crear} noValidate className="panel" aria-labelledby="nueva-llave">
        <h2 id="nueva-llave" className="text-lg font-semibold">
          Nueva llave
        </h2>
        <p className="mt-1 text-sm text-muted">
          Las llaves dan acceso a la API pública de este tenant.{" "}
          <a className="underline" href="/docs/api" target="_blank" rel="noopener">
            Documentación de la API
          </a>
          {" · "}
          <a className="underline" href="/api/v1/openapi.json">
            Ver OpenAPI (openapi.json)
          </a>
        </p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="block flex-1 text-sm font-medium">
            Nombre
            <input
              className="field"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={60}
              autoComplete="off"
              required
            />
          </label>
          <label className="block text-sm font-medium sm:w-48">
            Peticiones por minuto
            <input
              className="field"
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={errorLimite !== null}
              aria-describedby={errorLimite ? "limite-error" : "limite-ayuda"}
              required
            />
          </label>
          <button type="submit" className="btn" disabled={pendiente}>
            Crear llave
          </button>
        </div>
        {errorLimite ? (
          <p id="limite-error" role="alert" className="mt-2 text-sm text-danger">
            {errorLimite}
          </p>
        ) : (
          <p id="limite-ayuda" className="mt-2 text-sm text-muted">
            De 1 a 5000 por minuto; 120 por omisión. Al pasarlo, la API responde 429.
          </p>
        )}
      </form>

      {secreto && (
        <section
          ref={avisoSecreto}
          className="panel"
          aria-labelledby="secreto-titulo"
          aria-live="polite"
          tabIndex={-1}
        >
          <h2 id="secreto-titulo" className="text-lg font-semibold">
            Secreto de &laquo;{secreto.name}&raquo;
          </h2>
          <p className="mt-1 text-sm font-medium">Guárdala ahora: no se volverá a mostrar.</p>
          <p className="mt-3">
            <code className="block rounded border border-line bg-paper px-3 py-2 text-sm [overflow-wrap:anywhere]">
              {secreto.secret}
            </code>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="btn" onClick={copiar}>
              Copiar
            </button>
            <button type="button" className="btn-quiet" onClick={() => setSecreto(null)}>
              Ya la guardé
            </button>
            <span className="text-sm text-muted" aria-live="polite">
              {copia}
            </span>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-3">
        <Notices notice={notice} />
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Nombre</th>
                <th scope="col" className="px-4 py-2 font-medium">Prefijo</th>
                <th scope="col" className="px-4 py-2 font-medium">Peticiones por minuto</th>
                <th scope="col" className="px-4 py-2 font-medium">Alta</th>
                <th scope="col" className="px-4 py-2 font-medium">Último uso</th>
                <th scope="col" className="px-4 py-2 font-medium">Estado</th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted">
                    Aún no hay llaves.
                  </td>
                </tr>
              )}
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{k.name}</td>
                  <td className="px-4 py-3 font-mono">{k.prefix}…</td>
                  <td className="px-4 py-3">
                    {editando?.id === k.id ? (
                      <form onSubmit={(e) => guardarLimite(e, k)} noValidate className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <input
                            className="field w-24"
                            aria-label={`Peticiones por minuto de ${k.name}`}
                            value={editando.valor}
                            onChange={(e) => setEditando({ ...editando, valor: e.target.value, error: null })}
                            inputMode="numeric"
                            autoComplete="off"
                            aria-invalid={editando.error !== null}
                          />
                          <button type="submit" className="link-action" disabled={pendiente}>
                            Guardar <span className="sr-only">límite de {k.name}</span>
                          </button>
                          <button type="button" className="link-action" onClick={() => setEditando(null)}>
                            Cancelar
                          </button>
                        </div>
                        {editando.error && (
                          <p role="alert" className="text-sm text-danger">
                            {editando.error}
                          </p>
                        )}
                      </form>
                    ) : (
                      <span className="flex items-center gap-3 whitespace-nowrap">
                        <span>{k.requests_per_minute}</span>
                        {!k.revoked_at && (
                          <button
                            type="button"
                            className="link-action"
                            disabled={pendiente}
                            onClick={() => setEditando({ id: k.id, valor: String(k.requests_per_minute), error: null })}
                          >
                            Editar <span className="sr-only">límite de {k.name}</span>
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">{formatSync(k.created_at)}</td>
                  <td className="px-4 py-3">{formatSync(k.last_used_at)}</td>
                  <td className="px-4 py-3">
                    <span className="tag">{k.revoked_at ? "Revocada" : "Activa"}</span>
                  </td>
                  <td className="px-4 py-3">
                    {!k.revoked_at && (
                      <div className="flex flex-col items-end gap-1 whitespace-nowrap sm:flex-row sm:justify-end sm:gap-4">
                        <button type="button" className="link-action" disabled={pendiente} onClick={() => rotar(k)}>
                          Rotar <span className="sr-only">{k.name}</span>
                        </button>
                        <button type="button" className="link-danger" disabled={pendiente} onClick={() => revocar(k)}>
                          Revocar <span className="sr-only">{k.name}</span>
                        </button>
                      </div>
                    )}
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
