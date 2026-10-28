import AppHeader from "@/components/AppHeader";
import { getViewer } from "@/lib/auth/viewer";

export const instant = false;

/**
 * Páginas del súper administrador. El layout solo pone el encabezado: cada página y cada
 * server action comprueba el rol con `requirePlatformAdmin` (los layouts no se vuelven a
 * ejecutar al navegar entre páginas hermanas).
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const viewer = await getViewer();
  return (
    <>
      <AppHeader viewer={viewer} />
      <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</main>
    </>
  );
}
