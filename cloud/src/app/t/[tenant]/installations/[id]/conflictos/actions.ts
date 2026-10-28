"use server";

import { z } from "zod";
import { INVALID_DATA, runAction, type ActionResult } from "@/lib/actions";
import { markConflictReviewedAs } from "@/lib/conflicts";
import { createServerSupabase } from "@/lib/supabase/server";

/** Server action de la pestaña Conflictos: envoltorio delgado de `@/lib/conflicts`. */

export async function markConflictReviewed(
  tenantId: string,
  installationId: string,
  conflictId: number,
): Promise<ActionResult> {
  if (!z.tuple([z.string(), z.string(), z.number()]).safeParse([tenantId, installationId, conflictId]).success) {
    return INVALID_DATA;
  }
  return runAction(async () => markConflictReviewedAs(await createServerSupabase(), tenantId, installationId, conflictId));
}
