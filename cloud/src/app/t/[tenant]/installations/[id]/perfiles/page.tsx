import type { Metadata } from "next";
import ProfilesManager from "@/components/access/ProfilesManager";
import { guardPage } from "@/lib/auth/guards";
import { getInstallationForPage } from "@/lib/installations";
import { listOutputsAs } from "@/lib/outputs";
import { listPanelsAs } from "@/lib/panels/list";
import { isLinkedPanel } from "@/lib/profile-view";
import { listHolderOptionsAs, listProfilesAs } from "@/lib/profiles";
import { createServerSupabase } from "@/lib/supabase/server";
import { createProfile, deleteProfile, renameProfile, saveProfileRules, setProfileHolders } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Perfiles" };

/** Pestaña Perfiles: perfiles de acceso, reglas por panel y a quién se asignan. */
export default async function ProfilesPage({ params }: PageProps<"/t/[tenant]/installations/[id]/perfiles">) {
  const { tenant, id } = await params;
  const supabase = await createServerSupabase();
  const [instalacion, perfiles, titulares, paneles, salidas] = await Promise.all([
    getInstallationForPage(tenant, id),
    guardPage(listProfilesAs(supabase, tenant, id)),
    guardPage(listHolderOptionsAs(supabase, tenant, id)),
    guardPage(listPanelsAs(supabase, id)),
    guardPage(listOutputsAs(supabase, tenant, id)),
  ]);

  return (
    <ProfilesManager
      profiles={perfiles}
      holders={titulares}
      panels={paneles.filter(isLinkedPanel).map((p) => ({ id: p.id, panel_code: p.panel_code }))}
      outputs={salidas}
      onCreate={createProfile.bind(null, tenant, instalacion.id)}
      onRename={renameProfile.bind(null, tenant, instalacion.id)}
      onDelete={deleteProfile.bind(null, tenant, instalacion.id)}
      onSaveRules={saveProfileRules.bind(null, tenant, instalacion.id)}
      onSetHolders={setProfileHolders.bind(null, tenant, instalacion.id)}
    />
  );
}
