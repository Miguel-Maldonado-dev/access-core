import { z } from "zod";
import { safeEqualHex } from "@/lib/crypto";
import { PANEL_CODE_RE, SHA256_HEX_RE } from "@/lib/device/auth";
import { texto } from "@/lib/device/contract";
import { DeviceApiError, deviceJson, deviceRoute, readJsonBody } from "@/lib/device/http";
import { createAdminSupabase } from "@/lib/supabase/admin";

const esquema = z.object({
  panel_code: z.string().regex(PANEL_CODE_RE),
  claim_code_hash: z.string().regex(SHA256_HEX_RE),
  panel_secret_hash: z.string().regex(SHA256_HEX_RE),
  software_version: texto.trim().min(1).max(64),
  schema_version: z.number().int().min(0).max(32767),
});

type EstadoPanel = "pending" | "claimed" | "staging" | "awaiting_review" | "active" | "revoked";

/**
 * POST /api/device/v1/register (sin autenticación).
 * - Panel nuevo: 201 `{status:"pending"}`.
 * - Mismo `panel_secret_hash`: si está `pending` actualiza el código de vinculación; si
 *   está `revoked` vuelve a `pending` sin instalación (con el estado de sincronización
 *   en cero); en otro estado no cambia nada. Responde 200 `{status}`.
 * - Otro secreto: 409 `panel_code_taken`.
 */
export async function POST(req: Request) {
  return deviceRoute(async () => {
    const cuerpo = await readJsonBody(req, esquema);
    const admin = createAdminSupabase();
    const versiones = {
      software_version: cuerpo.software_version,
      schema_version: cuerpo.schema_version,
    };

    const { data: creado, error } = await admin
      .from("panels")
      .upsert(
        {
          panel_code: cuerpo.panel_code,
          claim_code_hash: cuerpo.claim_code_hash,
          panel_secret_hash: cuerpo.panel_secret_hash,
          status: "pending",
          ...versiones,
        },
        { onConflict: "panel_code", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    if (creado.length > 0) return deviceJson({ status: "pending" }, 201);

    const { data: panel, error: errorLectura } = await admin
      .from("panels")
      .select("id, status, panel_secret_hash")
      .eq("panel_code", cuerpo.panel_code)
      .single<{ id: string; status: EstadoPanel; panel_secret_hash: string }>();
    if (errorLectura) throw errorLectura;
    if (!safeEqualHex(cuerpo.panel_secret_hash, panel.panel_secret_hash)) {
      throw new DeviceApiError(
        409,
        "panel_code_taken",
        "Ese panel_code ya está registrado con otro secreto.",
      );
    }

    let cambios: Record<string, unknown> | null = null;
    if (panel.status === "pending") {
      cambios = { claim_code_hash: cuerpo.claim_code_hash, ...versiones };
    } else if (panel.status === "revoked") {
      cambios = {
        status: "pending",
        installation_id: null,
        claim_code_hash: cuerpo.claim_code_hash,
        device_token_hash: null,
        online: false,
        synced_revision: 0,
        last_sync_at: null,
        sync_blocked: null,
        confirm_deletions_until: null,
        ...versiones,
      };
    }
    if (!cambios) return deviceJson({ status: panel.status });

    // Solo si sigue en el estado leído (p. ej. no lo reclamaron mientras tanto).
    const { data: actualizado, error: errorCambio } = await admin
      .from("panels")
      .update(cambios)
      .eq("id", panel.id)
      .eq("status", panel.status)
      .select("status");
    if (errorCambio) throw errorCambio;
    if (actualizado.length > 0) return deviceJson({ status: "pending" });

    const { data: actual, error: errorActual } = await admin
      .from("panels")
      .select("status")
      .eq("id", panel.id)
      .single<{ status: EstadoPanel }>();
    if (errorActual) throw errorActual;
    return deviceJson({ status: actual.status });
  });
}
