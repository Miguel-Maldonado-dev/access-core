import type { Metadata } from "next";
import ApiReference from "@/components/api/ApiReference";
import { documentoParaVisor } from "@/lib/api/docs";

export const metadata: Metadata = { title: "Documentación de la API" };

/**
 * Documentación de la API pública. Pública: el proxy no pide sesión (src/proxy.ts) y solo
 * entrega el documento OpenAPI y la guía de `docs/api.md`; ningún dato de tenants.
 * Se genera al compilar. El visor (Scalar) carga solo en esta página.
 */
export default function DocsApiPage() {
  return <ApiReference spec={documentoParaVisor()} />;
}
