import { openapi } from "@/lib/api/openapi";

/** GET /api/v1/openapi.json: el documento OpenAPI 3.1. Público, no necesita llave. */
export async function GET() {
  return Response.json(openapi, { headers: { "cache-control": "public, max-age=300" } });
}
