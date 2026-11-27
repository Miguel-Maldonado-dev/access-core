import "server-only";
import { z } from "zod";
import { ApiError, parseApiBody } from "@/lib/api/http";
import type { ResultadoOperacion } from "@/lib/api/cards";
import type { ApiActor } from "@/lib/auth/guards";
import { createQrCodeAs, getQrCodeAs, QR_LABEL_MAX, QR_MAX_USES } from "@/lib/qr-codes";

export const FECHA_SIN_ZONA = "Las fechas deben llevar zona horaria (ISO 8601).";

/** Cuerpo de `POST .../qr-codes`: la validación fina (titular, vigencia) vive en `qr-codes.ts`. */
export const cuerpoCrearQr = z.strictObject({
  holder_id: z.string(),
  label: z.string().max(QR_LABEL_MAX).optional(),
  valid_from: z.string(),
  valid_until: z.string(),
  max_uses: z.int().min(1).max(QR_MAX_USES).optional(),
});

const fechaConZona = z.iso.datetime({ offset: true });

/** Operaciones de QR de la API pública. La respuesta trae solo el `code`, nunca imagen. */
export const operacionesQr = {
  async create(actor: ApiActor, installationId: string, json: unknown): Promise<ResultadoOperacion> {
    const cuerpo = parseApiBody(json, cuerpoCrearQr);
    if (!fechaConZona.safeParse(cuerpo.valid_from).success || !fechaConZona.safeParse(cuerpo.valid_until).success) {
      throw new ApiError(400, "bad_request", FECHA_SIN_ZONA);
    }
    const { id } = await createQrCodeAs(actor, actor.tenantId, installationId, cuerpo);
    return { status: 201, id, data: await getQrCodeAs(actor, actor.tenantId, installationId, id) };
  },
};
