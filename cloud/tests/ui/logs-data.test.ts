import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { LOG_PAGE_SIZE, parseLogFilters } from "@/lib/log-view";
import { listLogFilterOptionsAs, listLogsAs } from "@/lib/logs";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Logs de acceso con RLS contra el Supabase local (N15): filtros, paginación, alias y aislamiento. */
const CLAVE = "Clave-de-prueba-123";
const AUTOR = { updated_by: "prueba", origin: "cloud" };

async function fallo(promesa: Promise<unknown>): Promise<HttpError> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Se esperaba un HttpError y salió bien.");
}

const filtros = (consulta: Record<string, string> = {}) => parseLogFilters(consulta);

describe("logs de acceso (N15)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `n15-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instP: string;
  let instB: string;
  let panelA1: string;
  let panelA2: string;
  let panelP: string;
  let panelB: string;
  let holderAna: string;
  let holderBeto: string;
  const urls: string[] = [];

  async function usuario(nombre: string, tenantId: string, role: "admin" | "tecnico", espia = false) {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role });
    if (error) throw error;
    if (!espia) return signInLocal(correo(nombre), CLAVE);
    // Mismo inicio de sesión, pero anotando las URL que se piden a la Data API.
    const cliente = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (entrada, init) => {
          urls.push(String(entrada));
          return fetch(entrada, init);
        },
      },
    });
    const { error: e2 } = await cliente.auth.signInWithPassword({ email: correo(nombre), password: CLAVE });
    if (e2) throw e2;
    return cliente;
  }

  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  let contadorPanel = 0;
  async function panel(installationId: string): Promise<string> {
    const n = ++contadorPanel;
    const hex = (n * 7919 + Number.parseInt(sufijo, 16)).toString(32).toUpperCase().replace(/[ILOU]/g, "X");
    const codigo = `PNL-${hex.padStart(8, "0").slice(0, 4)}-${hex.padStart(8, "0").slice(4, 8)}`;
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: codigo,
        panel_secret_hash: "a".repeat(64),
        installation_id: installationId,
        status: "active",
        device_token_hash: "b".repeat(64),
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    return data.id;
  }

  async function titular(installationId: string, name: string): Promise<string> {
    const { data, error } = await admin
      .from("holders")
      .insert({ installation_id: installationId, kind: "persona", name, ...AUTOR })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  let local = 0;
  type LogIn = {
    tenant: string;
    inst: string;
    panel: string;
    ts: string;
    allowed?: boolean;
    source?: number;
    reason?: number;
    holder_id?: string | null;
    holder_name?: string | null;
    code?: number | null;
    output_index?: number | null;
  };
  async function logs(filas: LogIn[]) {
    const { error } = await admin.from("access_logs").insert(
      filas.map((f) => ({
        tenant_id: f.tenant,
        installation_id: f.inst,
        panel_id: f.panel,
        local_log_id: ++local,
        ts: f.ts,
        allowed: f.allowed ?? true,
        source: f.source ?? 0,
        reason: f.reason ?? 0,
        holder_id: f.holder_id ?? null,
        holder_name: f.holder_name ?? null,
        code: f.code ?? null,
        output_index: f.output_index ?? null,
      })),
    );
    if (error) throw error;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `N15 ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    tecnicoA = await usuario("tec-a", tenantA, "tecnico", true);
    adminB = await usuario("admin-b", tenantB, "admin");
    instA = await instalacion(tenantA, "Torre A");
    instP = await instalacion(tenantA, "Paginación");
    instB = await instalacion(tenantB, "Torre B");
    panelA1 = await panel(instA);
    panelA2 = await panel(instA);
    panelP = await panel(instP);
    panelB = await panel(instB);
    holderAna = await titular(instA, "Ana Pérez");
    holderBeto = await titular(instA, "Beto Ruiz");
    // Salida 0 de A1 con alias; salida 1 con una fila borrada que tenía alias y otra viva sin alias.
    const salidas = (panelId: string, installationId: string, filas: Record<string, unknown>[]) =>
      filas.map((f) => ({ installation_id: installationId, panel_id: panelId, duration_ms: 3000, reader_mask: 1, enabled: true, ...AUTOR, ...f }));
    const { error } = await admin.from("outputs").insert(
      salidas(panelA1, instA, [
        { output_index: 0, alias: "Pluma vehicular" },
        { output_index: 1, alias: "Vieja", deleted_at: "2026-01-01T00:00:00Z" },
        { output_index: 1, alias: "" },
      ]),
    );
    if (error) throw error;
  });

  afterAll(async () => {
    const borrado = async (que: string, consulta: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await consulta;
      if (error) throw new Error(`No se pudo limpiar ${que}: ${error.message}`);
    };
    await borrado("outputs", admin.from("outputs").delete().in("panel_id", paneles));
    await borrado("paneles", admin.from("panels").delete().in("id", paneles));
    await borrado("tenants", admin.from("tenants").delete().in("id", tenants));
    for (const u of usuarios) {
      const { error } = await admin.auth.admin.deleteUser(u);
      if (error) throw new Error(`No se pudo borrar el usuario ${u}: ${error.message}`);
    }
  });

  describe("filtros", () => {
    beforeAll(async () => {
      const base = { tenant: tenantA, inst: instA };
      await logs([
        // Medio día local de México (UTC-6 en marzo de 2026).
        { ...base, panel: panelA1, ts: "2026-03-10T18:00:00Z", source: 0, code: 111, holder_id: holderAna, holder_name: "Ana Pérez", output_index: 0 },
        { ...base, panel: panelA1, ts: "2026-03-10T19:00:00Z", source: 3, reason: 0, holder_id: holderBeto, holder_name: "Beto Ruiz", output_index: 1 },
        { ...base, panel: panelA2, ts: "2026-03-11T19:00:00Z", source: 1, code: 222, allowed: false, reason: 5 },
        { ...base, panel: panelA2, ts: "2026-03-12T19:00:00Z", source: 2, output_index: 0 },
        // Frontera del día local: 23:59:59 del 9 y 00:00:00 del 10 (hora de México).
        { ...base, panel: panelA1, ts: "2026-03-10T05:59:59Z", source: 0, code: 333 },
        { ...base, panel: panelA1, ts: "2026-03-10T06:00:00Z", source: 0, code: 444 },
        // Último segundo del día local 10 y primero del 11.
        { ...base, panel: panelA1, ts: "2026-03-11T05:59:59Z", source: 0, code: 555 },
        { ...base, panel: panelA1, ts: "2026-03-11T06:00:00Z", source: 0, code: 666 },
      ]);
      // Otro tenant: nunca debe aparecer.
      await logs([{ tenant: tenantB, inst: instB, panel: panelB, ts: "2026-03-10T18:00:00Z", code: 999 }]);
    });

    it("sin filtros trae todos los de la instalación, del más reciente al más viejo", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instA, filtros());
      expect(r.total).toBe(8);
      expect(r.page).toBe(1);
      expect(r.pageSize).toBe(LOG_PAGE_SIZE);
      expect(r.pageSize).toBe(50);
      const marcas = r.rows.map((x) => x.ts);
      expect(marcas).toEqual([...marcas].sort().reverse());
      expect(r.rows.map((x) => x.code)).not.toContain(999);
    });

    it("el filtro Origen = PIN pide source=3 a la Data API y solo trae PIN, sin código", async () => {
      urls.length = 0;
      const r = await listLogsAs(tecnicoA, tenantA, instA, filtros({ origen: "3" }));
      const pedidas = urls.filter((u) => u.includes("/rest/v1/access_logs"));
      expect(pedidas.length).toBeGreaterThan(0);
      expect(pedidas.every((u) => u.includes("source=eq.3"))).toBe(true);
      expect(r.total).toBe(1);
      expect(r.rows[0]).toMatchObject({ source: 3, holder_name: "Beto Ruiz", code: null });
    });

    it("filtra por resultado, panel y titular", async () => {
      const denegados = await listLogsAs(tecnicoA, tenantA, instA, filtros({ resultado: "denegado" }));
      expect(denegados.rows.map((x) => x.code)).toEqual([222]);
      const permitidos = await listLogsAs(tecnicoA, tenantA, instA, filtros({ resultado: "permitido" }));
      expect(permitidos.total).toBe(7);

      const delPanel2 = await listLogsAs(tecnicoA, tenantA, instA, filtros({ panel: panelA2 }));
      expect(delPanel2.total).toBe(2);
      expect(new Set(delPanel2.rows.map((x) => x.panel_id))).toEqual(new Set([panelA2]));

      const deAna = await listLogsAs(tecnicoA, tenantA, instA, filtros({ titular: holderAna }));
      expect(deAna.rows.map((x) => x.holder_name)).toEqual(["Ana Pérez"]);
    });

    it("el rango de fechas usa el día local de México, con la frontera exacta", async () => {
      const dia10 = await listLogsAs(tecnicoA, tenantA, instA, filtros({ desde: "2026-03-10", hasta: "2026-03-10" }));
      expect(dia10.rows.map((x) => x.ts).sort()).toEqual([
        "2026-03-10T06:00:00+00:00",
        "2026-03-10T18:00:00+00:00",
        "2026-03-10T19:00:00+00:00",
        "2026-03-11T05:59:59+00:00",
      ]);
      const desde11 = await listLogsAs(tecnicoA, tenantA, instA, filtros({ desde: "2026-03-11" }));
      expect(desde11.total).toBe(3);
      const hasta9 = await listLogsAs(tecnicoA, tenantA, instA, filtros({ hasta: "2026-03-09" }));
      expect(hasta9.rows.map((x) => x.code)).toEqual([333]);
    });

    it("combina filtros", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instA, filtros({ panel: panelA1, origen: "0", desde: "2026-03-10", hasta: "2026-03-10" }));
      expect(r.rows.map((x) => x.code).sort()).toEqual([111, 444, 555]);
    });

    it("resuelve panel y alias de la salida entre filas vivas, sin alias queda null", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instA, filtros({ desde: "2026-03-10", hasta: "2026-03-10" }));
      const ana = r.rows.find((x) => x.code === 111)!;
      expect(ana.output_alias).toBe("Pluma vehicular");
      expect(ana.panel_code).toMatch(/^PNL-/);
      const beto = r.rows.find((x) => x.holder_name === "Beto Ruiz")!;
      expect(beto.output_index).toBe(1);
      expect(beto.output_alias).toBeNull();
      const sinSalida = r.rows.find((x) => x.code === 444)!;
      expect(sinSalida.output_index).toBeNull();
      expect(sinSalida.output_alias).toBeNull();
    });

    it("las opciones de filtro traen los paneles y los titulares vivos de la instalación", async () => {
      await admin.from("holders").update({ deleted_at: "2026-02-01T00:00:00Z" }).eq("id", holderBeto);
      try {
        const o = await listLogFilterOptionsAs(tecnicoA, tenantA, instA);
        expect(o.panels.map((p) => p.id).sort()).toEqual([panelA1, panelA2].sort());
        expect(o.holders).toEqual([{ id: holderAna, name: "Ana Pérez" }]);
      } finally {
        await admin.from("holders").update({ deleted_at: null }).eq("id", holderBeto);
      }
    });
  });

  describe("paginación", () => {
    beforeAll(async () => {
      // 120 logs; cada 3 comparten la misma marca de tiempo para probar el desempate por id.
      const base = Date.parse("2026-04-01T12:00:00Z");
      await logs(
        Array.from({ length: 120 }, (_, i) => ({
          tenant: tenantA,
          inst: instP,
          panel: panelP,
          ts: new Date(base + Math.floor(i / 3) * 60_000).toISOString(),
        })),
      );
    });

    it("páginas de 50 con el total, sin solaparse ni perder filas, en orden ts desc, id desc", async () => {
      const paginas = [];
      for (const pagina of ["1", "2", "3"]) paginas.push(await listLogsAs(tecnicoA, tenantA, instP, filtros({ pagina })));
      expect(paginas.map((p) => p.rows.length)).toEqual([50, 50, 20]);
      expect(paginas.every((p) => p.total === 120)).toBe(true);
      expect(paginas.map((p) => p.page)).toEqual([1, 2, 3]);
      const todas = paginas.flatMap((p) => p.rows);
      expect(new Set(todas.map((x) => x.id)).size).toBe(120);
      for (let i = 1; i < todas.length; i++) {
        const [a, b] = [todas[i - 1], todas[i]];
        expect(a.ts > b.ts || (a.ts === b.ts && a.id > b.id)).toBe(true);
      }
    });

    it("una página fuera de rango devuelve la lista vacía con el total, sin error", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instP, filtros({ pagina: "9" }));
      expect(r.rows).toEqual([]);
      expect(r.total).toBe(120);
      expect(r.page).toBe(9);
    });

    it("sin resultados da total 0", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instP, filtros({ origen: "3" }));
      expect(r).toMatchObject({ rows: [], total: 0 });
    });
  });

  describe("acceso", () => {
    it("un miembro de otro tenant recibe 403 y una instalación ajena da 404", async () => {
      expect((await fallo(listLogsAs(adminB, tenantA, instA, filtros()))).status).toBe(403);
      expect((await fallo(listLogsAs(tecnicoA, tenantA, instB, filtros()))).status).toBe(404);
      expect((await fallo(listLogsAs(tecnicoA, tenantA, "no-es-uuid", filtros()))).status).toBe(404);
      expect((await fallo(listLogFilterOptionsAs(adminB, tenantA, instA))).status).toBe(403);
      expect((await fallo(listLogFilterOptionsAs(tecnicoA, tenantA, instB))).status).toBe(404);
    });

    it("un filtro de panel o titular de otra instalación no trae nada", async () => {
      const r = await listLogsAs(tecnicoA, tenantA, instA, filtros({ panel: panelB }));
      expect(r.total).toBe(0);
      const holderB = await titular(instB, "Titular de B");
      await logs([{ tenant: tenantB, inst: instB, panel: panelB, ts: "2026-03-10T18:00:00Z", holder_id: holderB, holder_name: "Titular de B" }]);
      const t = await listLogsAs(tecnicoA, tenantA, instA, filtros({ titular: holderB }));
      expect(t.total).toBe(0);
    });
  });
});
