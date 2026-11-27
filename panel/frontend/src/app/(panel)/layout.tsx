"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ClockBadge from "@/components/ClockBadge";
import { apiFetch } from "@/lib/api";
import type { CallSettings } from "@/lib/types";
import { CALLS_CHANGED_EVENT } from "@/lib/calls";

const SECTIONS = [
  { href: "/titulares/", label: "Titulares" },
  { href: "/tarjetas/", label: "Tarjetas" },
  { href: "/qr/", label: "QR" },
  { href: "/telefonos/", label: "Teléfonos", needsCalls: true },
  { href: "/controles/", label: "Controles" },
  { href: "/permisos/", label: "Permisos" },
  { href: "/llamadas/", label: "Llamadas" },
  { href: "/salidas/", label: "Salidas" },
  { href: "/logs/", label: "Logs" },
  { href: "/nube/", label: "Nube" },
];

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [callsEnabled, setCallsEnabled] = useState(false);

  useEffect(() => {
    // Se consulta al cambiar de página y al guardar en Llamadas (evento CALLS_CHANGED_EVENT).
    // Si no se puede consultar, el módulo se trata como desactivado.
    let ignore = false;
    const load = () =>
      apiFetch<CallSettings>("/api/calls/settings").then(
        (c) => !ignore && setCallsEnabled(c.enabled),
        () => !ignore && setCallsEnabled(false),
      );
    void load();
    window.addEventListener(CALLS_CHANGED_EVENT, load);
    return () => {
      ignore = true;
      window.removeEventListener(CALLS_CHANGED_EVENT, load);
    };
  }, [pathname]);

  async function logout() {
    try {
      await apiFetch("/api/logout", { method: "POST" });
    } finally {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navegación completa a propósito
      window.location.assign("/login/");
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-[13rem_1fr]">
      <aside className="flex flex-col bg-ink text-white">
        <p className="px-5 py-5 text-lg font-semibold tracking-tight">Control de acceso</p>
        <nav aria-label="Secciones" className="flex-1">
          <ul>
            {SECTIONS.filter((s) => !s.needsCalls || callsEnabled).map((s) => {
              const active = pathname === s.href || pathname === s.href.slice(0, -1);
              return (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      "block border-l-4 px-5 py-2.5 hover:bg-ink-soft " +
                      (active ? "border-[#5fd1b8] bg-ink-soft font-medium" : "border-transparent text-white/75")
                    }
                  >
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <button
          type="button"
          onClick={logout}
          className="m-4 rounded border border-white/30 px-3 py-2 text-sm hover:bg-ink-soft"
        >
          Cerrar sesión
        </button>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex min-h-16 items-center justify-end border-b border-line bg-surface px-6 py-2">
          <ClockBadge />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
