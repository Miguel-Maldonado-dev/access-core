import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/openapi.json/route";
import { openapi } from "@/lib/api/openapi";
import { SOURCE_OPTIONS } from "@/lib/log-view";

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

  it("cada POST de alta declara 201; la apertura remota (no es alta) declara 200", () => {
    const apertura = "/installations/{installationId}/outputs/{outputId}/open";
    for (const [ruta, ops] of Object.entries(doc.paths)) {
      if (!ops.post) continue;
      if (ruta === apertura) {
        expect(ops.post.responses["200"], `POST ${ruta}`).toBeDefined();
        expect(ops.post.responses["201"], `POST ${ruta}`).toBeUndefined();
      } else {
        expect(ops.post.responses["201"], `POST ${ruta}`).toBeDefined();
      }
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

  it("allow_remote es obligatorio en la regla de respuesta y opcional en la de entrada; el log admite origen 4", () => {
    const esquemas = (doc as unknown as { components: { schemas: Record<string, { required: string[]; properties: Record<string, { enum?: number[]; maximum?: number }> }> } }).components.schemas;
    expect(esquemas.Regla.required).toContain("allow_remote");
    expect(esquemas.ReglaEntrada.required).not.toContain("allow_remote");
    expect(esquemas.ReglaEntrada.properties.allow_remote).toBeDefined();
    expect(esquemas.Log.properties.source.enum).toEqual([0, 1, 2, 3, 4, 5]);
    expect(esquemas.Log.properties.reason.maximum).toBe(11);
    const params = doc.paths["/installations/{installationId}/logs"].get as unknown as { parameters: { name?: string; schema?: { enum?: string[] } }[] };
    const origen = params.parameters.find((p) => p.name === "origen");
    expect(origen?.schema?.enum).toEqual(SOURCE_OPTIONS.map(String));
    expect(esquemas.Log.properties.source.enum).toEqual([...SOURCE_OPTIONS]);
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
