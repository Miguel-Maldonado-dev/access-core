import { batchRoute } from "@/lib/api/batch";
import { operacionesTelefonos } from "@/lib/api/phones";

/** Un lote de 200 tarda ~1–2,5 s en local; se da margen en Vercel (ver cloud/docs/api.md). */
export const maxDuration = 60;

type Contexto = { params: Promise<{ installationId: string }> };

/** POST .../phones/batch: hasta 200 operaciones de teléfonos (create, update, delete) con un resultado por elemento. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return batchRoute(req, installationId, { operaciones: operacionesTelefonos, metodoUpdate: "PATCH" });
}
