import { batchRoute } from "@/lib/api/batch";
import { operacionesTarjetas } from "@/lib/api/cards";

/** Un lote de 200 tarda ~1–2,5 s en local; se da margen en Vercel (ver cloud/docs/api.md). */
export const maxDuration = 60;

type Contexto = { params: Promise<{ installationId: string }> };

/** POST .../cards/batch: hasta 200 operaciones de tarjetas (create, update, delete) con un resultado por elemento. */
export async function POST(req: Request, { params }: Contexto) {
  const { installationId } = await params;
  return batchRoute(req, installationId, { operaciones: operacionesTarjetas, metodoUpdate: "PATCH" });
}
