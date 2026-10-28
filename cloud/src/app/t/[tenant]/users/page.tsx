import type { Metadata } from "next";
import MembersManager from "@/components/members/MembersManager";
import { guardPage } from "@/lib/auth/guards";
import { getViewer } from "@/lib/auth/viewer";
import { listMembersAs } from "@/lib/tenants/members";
import { createServerSupabase } from "@/lib/supabase/server";
import { addMember, changeMemberRole, removeMember } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "Usuarios" };

/** Usuarios del tenant: solo para su `admin` (a un técnico, 403). */
export default async function UsersPage({ params }: PageProps<"/t/[tenant]/users">) {
  const { tenant } = await params;
  const [viewer, miembros] = await Promise.all([
    getViewer(),
    guardPage(listMembersAs(await createServerSupabase(), tenant)),
  ]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">Usuarios</h1>
      <MembersManager
        tenantId={tenant}
        currentUserId={viewer.userId}
        members={miembros}
        onAdd={addMember}
        onChangeRole={changeMemberRole}
        onRemove={removeMember}
      />
    </div>
  );
}
