import Link from "next/link";
import { signOut } from "@/app/(auth)/actions";
import BrandMark from "@/components/BrandMark";
import NavLinks, { type NavItem } from "@/components/NavLinks";
import type { Viewer } from "@/lib/auth/viewer";

/**
 * Barra superior de las páginas con sesión: marca, navegación general, cuenta y
 * "Cerrar sesión". En móvil la navegación pasa a su propia fila.
 */
export default function AppHeader({ viewer }: { viewer: Viewer }) {
  const items: NavItem[] = [{ href: "/", label: "Inicio" }];
  if (viewer.isPlatformAdmin) items.push({ href: "/admin/tenants", label: "Tenants" });

  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 pt-2 md:px-6">
        <Link href="/" className="flex items-center gap-2.5 py-2 text-lg font-semibold tracking-tight">
          <BrandMark />
          Access Core
        </Link>
        <div className="order-last w-full md:order-none md:w-auto md:flex-1">
          <NavLinks items={items} label="Principal" variant="header" />
        </div>
        <div className="ml-auto flex items-center gap-3 py-2">
          <span className="hidden max-w-56 truncate text-sm text-white/75 sm:inline" title={viewer.email}>
            {viewer.email}
          </span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded border border-white/30 px-3 py-1.5 text-sm hover:bg-ink-soft"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
