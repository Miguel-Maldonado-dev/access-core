"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { logsUploadStatusAs, requestLogsUploadAs, type LogsUploadRequest } from "@/lib/panel-commands";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Server actions de "Actualizar logs": envoltorios delgados de `@/lib/panel-commands`.
 * No refrescan la vista: la página se refresca desde el cliente cuando terminan de llegar
 * los logs (o se acaba la espera).
 */

const texto = z.string();

export async function requestLogsUpload(tenantId: string, installationId: string): Promise<ActionResult<LogsUploadRequest>> {
  if (!z.tuple([texto, texto]).safeParse([tenantId, installationId]).success) return INVALID_DATA;
  return runAction(async () => requestLogsUploadAs(await createServerSupabase(), tenantId, installationId), {
    refresh: false,
  });
}

/** Paneles avisados que aún no suben logs desde `since` (la `requestedAt` de la petición). */
export async function logsUploadStatus(
  tenantId: string,
  installationId: string,
  since: string,
): Promise<ActionResult<{ pending: string[] }>> {
  if (!z.tuple([texto, texto, texto]).safeParse([tenantId, installationId, since]).success) return INVALID_DATA;
  return runAction(async () => logsUploadStatusAs(await createServerSupabase(), tenantId, installationId, since), {
    refresh: false,
  });
}
