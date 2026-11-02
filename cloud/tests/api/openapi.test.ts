import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/openapi.json/route";
import { openapi } from "@/lib/api/openapi";

// El documento OpenAPI debe cubrir cada ruta de `src/app/api/v1` (salvo el propio openapi.json).

const RAIZ = join(__dirname, "../../src/app/api/v1");
const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function rutas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return rutas(ruta);
    return e.name === "route.ts" ? [ruta] : [];
  });
}

function parejas(): { ruta: string; metodo: string }[] {
  return rutas(RAIZ)
    .map((archivo) => ({ archivo, ruta: "/" + relative(RAIZ, archivo).split(sep).slice(0, -1).join("/") }))
    .filter(({ ruta }) => ruta !== "/openapi.json")
    .flatMap(({ archivo, ruta }) => {
      const fuente = readFileSync(archivo, "utf8");
      const openapiRuta = ruta.replace(/\[(\w+)\]/g, "{$1}");
      return METODOS.filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(fuente)).map((metodo) => ({
        ruta: openapiRuta,
        metodo,
      }));
    });
}

describe("documento OpenAPI", () => {
  const doc = openapi as {
    openapi: string;
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
  };

  it("es OpenAPI 3.1.0 y JSON válido", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(() => JSON.parse(JSON.stringify(openapi))).not.toThrow();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.components.schemas.Error).toBeDefined();
  });

  it("describe cada pareja (ruta, método) de las rutas", () => {
    const todas = parejas();
    expect(todas.length).toBeGreaterThan(20);
    for (const { ruta, metodo } of todas) {
      expect(doc.paths[ruta]?.[metodo.toLowerCase()], `${metodo} ${ruta}`).toBeDefined();
    }
  });

  it("no describe parejas que no existen", () => {
    const reales = new Set(parejas().map((p) => `${p.metodo.toLowerCase()} ${p.ruta}`));
    for (const [ruta, ops] of Object.entries(doc.paths)) {
      for (const metodo of Object.keys(ops)) expect(reales.has(`${metodo} ${ruta}`), `${metodo} ${ruta}`).toBe(true);
    }
  });

  it("GET /api/v1/openapi.json es público y devuelve el documento", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(openapi)));
  });

  it("todo $ref resuelve", () => {
    const refs: string[] = [];
    const recorre = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(recorre);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (k === "$ref" && typeof val === "string") refs.push(val);
          else recorre(val);
        }
      }
    };
    recorre(openapi);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of refs) {
      const partes = r.replace(/^#\//, "").split("/");
      let nodo: unknown = openapi;
      for (const p of partes) nodo = (nodo as Record<string, unknown> | undefined)?.[p];
      expect(nodo, r).toBeDefined();
    }
  });

  it("cada POST declara 201", () => {
    for (const [ruta, ops] of Object.entries(doc.paths)) {
      if (ops.post) expect(ops.post.responses["201"], `POST ${ruta}`).toBeDefined();
    }
  });

  it("toda operación bajo /installations/{installationId} declara 404", () => {
    const rutas = Object.entries(doc.paths).filter(([ruta]) => ruta.startsWith("/installations/{installationId}"));
    expect(rutas.length).toBeGreaterThan(5);
    for (const [ruta, ops] of rutas) {
      for (const [metodo, o] of Object.entries(ops)) {
        expect(o.responses["404"], `${metodo.toUpperCase()} ${ruta}`).toBeDefined();
      }
    }
  });

  it("PUT y DELETE de PIN no declaran Idempotency-Key", () => {
    const ops = doc.paths["/installations/{installationId}/holders/{holderId}/pin"];
    for (const m of ["put", "delete"]) {
      const params = ((ops[m] as { parameters?: { $ref?: string; name?: string }[] }).parameters ?? []).map(
        (p) => p.$ref ?? p.name,
      );
      expect(params.some((p) => /idempotency/i.test(String(p))), m).toBe(false);
    }
  });
});
