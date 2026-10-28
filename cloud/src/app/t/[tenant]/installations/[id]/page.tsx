import { redirect } from "next/navigation";

export const instant = false;

/** /t/[tenant]/installations/[id] abre la pestaña Paneles. */
export default async function InstallationPage({ params }: PageProps<"/t/[tenant]/installations/[id]">) {
  const { tenant, id } = await params;
  redirect(`/t/${tenant}/installations/${id}/paneles`);
}
