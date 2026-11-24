import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import DocsApiPage, { metadata } from "@/app/docs/api/page";
import { documentoParaVisor } from "@/lib/api/docs";
import { openapi } from "@/lib/api/openapi";
import { proxy } from "@/proxy";

/** Documentación pública de la API en /docs/api. */
describe("/docs/api", () => {
  it("el proxy la deja pasar sin sesión (sin redirigir a /login ni tocar Supabase)", async () => {
    for (const url of ["http://localhost:3000/docs/api", "http://localhost:3000/docs/api/"]) {
      const r = await proxy(new NextRequest(url));
      expect(r.status, url).toBe(200);
      expect(r.headers.get("location"), url).toBeNull();
    }
  });

  it("el resto de las páginas sigue protegido", async () => {
    // Sin cookies de sesión y con Supabase inalcanzable, cualquier otra ruta no es pública.
    const previo = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "x";
    try {
      const r = await proxy(new NextRequest("http://localhost:3000/docs/otra"));
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname).toBe("/login");
    } finally {
      if (previo === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
  });

  it("la página tiene el título y entrega al visor solo el documento", () => {
    expect(metadata.title).toBe("Documentación de la API");
    const el = DocsApiPage() as { props: { spec: object } };
    expect(el.props.spec).toEqual(documentoParaVisor());
  });

  it("el OpenAPI del visor incluye la guía de docs/api.md y conserva las rutas", () => {
    const doc = documentoParaVisor() as { info: { title: string; description: string }; paths: object };
    const md = readFileSync(join(__dirname, "../../docs/api.md"), "utf8");
    expect(doc.info.title).toBe("API pública de Access Core");
    expect(doc.info.description).toContain("## Crear una llave");
    expect(doc.info.description).toContain("## Lotes");
    expect(doc.info.description.startsWith("# ")).toBe(false);
    expect(doc.info.description.length).toBeGreaterThan(md.length * 0.9);
    expect(doc.paths).toEqual((openapi as { paths: object }).paths);
  });

  it("no modifica el documento de /api/v1/openapi.json", () => {
    documentoParaVisor();
    expect((openapi as { info: { description: string } }).info.description).not.toContain("## Crear una llave");
  });
});
