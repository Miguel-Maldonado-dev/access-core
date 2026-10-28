import NavLinks from "@/components/NavLinks";
import { getInstallationForPage } from "@/lib/installations";

export const instant = false;

/** Pestañas de una instalación; las que aún no existen las agregan las tareas siguientes. */
const TABS = [
  { segment: "paneles", label: "Paneles" },
  { segment: "titulares", label: "Titulares" },
  { segment: "tarjetas", label: "Tarjetas" },
  { segment: "controles", label: "Controles" },
  { segment: "perfiles", label: "Perfiles" },
  { segment: "salidas", label: "Salidas" },
  { segment: "logs", label: "Logs" },
  { segment: "conflictos", label: "Conflictos" },
];

/**
 * Marco de una instalación (`[id]`): comprueba que sea del tenant de la URL (si no, 404) y
 * muestra su nombre y sus pestañas.
 */
export default async function InstallationLayout({
  params,
  children,
}: LayoutProps<"/t/[tenant]/installations/[id]">) {
  const { tenant, id } = await params;
  const instalacion = await getInstallationForPage(tenant, id);
  const items = TABS.map((t) => ({ href: `/t/${tenant}/installations/${id}/${t.segment}`, label: t.label }));

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="border-b border-line">
        <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{instalacion.name}</h1>
        <div className="mt-2">
          <NavLinks items={items} label="Secciones de la instalación" variant="tabs" />
        </div>
      </div>
      {children}
    </div>
  );
}
