"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

const ESTILOS = {
  // Sobre la barra de tinta: como la barra lateral del panel local, el activo lleva la marca verde.
  header: {
    lista: "flex flex-wrap gap-x-1",
    base: "block border-b-[3px] px-3 py-2 text-sm hover:bg-ink-soft",
    activo: "border-accent font-medium text-white",
    inactivo: "border-transparent text-white/75",
  },
  // Pestañas sobre superficie blanca: el activo se marca en verde señal (contraste suficiente).
  tabs: {
    lista: "-mb-px flex gap-x-1 overflow-x-auto",
    base: "block whitespace-nowrap border-b-[3px] px-4 py-2.5 text-sm hover:bg-paper",
    activo: "border-signal font-medium text-text",
    inactivo: "border-transparent text-muted",
  },
} as const;

function estaActivo(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Navegación con el enlace de la página actual marcado (`aria-current="page"`). */
export default function NavLinks({
  items,
  label,
  variant,
}: {
  items: NavItem[];
  label: string;
  variant: keyof typeof ESTILOS;
}) {
  const pathname = usePathname();
  const estilo = ESTILOS[variant];
  return (
    <nav aria-label={label}>
      <ul className={estilo.lista}>
        {items.map((item) => {
          const activo = estaActivo(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={activo ? "page" : undefined}
                className={`${estilo.base} ${activo ? estilo.activo : estilo.inactivo}`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
