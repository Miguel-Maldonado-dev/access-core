import type { Metadata } from "next";
import ApiKeysManager from "@/components/api/ApiKeysManager";
import { guardPage } from "@/lib/auth/guards";
import { listApiKeysAs } from "@/lib/api/keys";
import { createServerSupabase } from "@/lib/supabase/server";
import { createApiKey, revokeApiKey, rotateApiKey } from "./actions";

export const instant = false;
export const metadata: Metadata = { title: "API" };

/** Llaves de la API pública: solo para el `admin` del tenant (a un técnico, 403). */
export default async function ApiPage({ params }: PageProps<"/t/[tenant]/api">) {
  const { tenant } = await params;
  const llaves = await guardPage(listApiKeysAs(await createServerSupabase(), tenant));

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">API</h1>
      <ApiKeysManager
        tenantId={tenant}
        keys={llaves}
        onCreate={createApiKey}
        onRevoke={revokeApiKey}
        onRotate={rotateApiKey}
      />
    </div>
  );
}
