import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listConflictsAs, markConflictReviewedAs } from "@/lib/conflicts";
import { HttpError } from "@/lib/errors";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Lista de conflictos y "Marcar como revisado" con RLS contra el Supabase local (N15). */
const CLAVE = "Clave-de-prueba-123";

async function fallo(promesa: Promise<unknown>): Promise<HttpError> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Se esperaba un HttpError y salió bien.");
}

describe("conflictos de sincronización (N15)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `n15c-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tecnicoAId: string;
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instA2: string;
  let instB: string;
  let panelA: string;
  let panelA2: string;
  let panelB: string;
  const ids: Record<string, number> = {};

  async function usuario(nombre: string, tenantId: string, role: "admin" | "tecnico") {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role });
    if (error) throw error;
    return { id, cliente: await signInLocal(correo(nombre), CLAVE) };
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
      .insert({ panel_code: codigo, panel_secret_hash: "a".repeat(64), installation_id: installationId, status: "active", device_token_hash: "b".repeat(64) })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    return data.id;
  }

  async function conflicto(clave: string, tenant: string, inst: string, p: string, extra: Record<string, unknown> = {}) {
    const { data, error } = await admin
      .from("sync_conflicts")
      .insert({
        tenant_id: tenant,
        installation_id: inst,
        panel_id: p,
        table_name: "cards",
        row_id: randomUUID(),
        kind: "lww",
        resolution: "Gana la nube: su versión es más reciente.",
        ...extra,
      })
      .select("id")
      .single();
    if (error) throw error;
    ids[clave] = data.id;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `N15c ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    adminA = (await usuario("admin-a", tenantA, "admin")).cliente;
    const t = await usuario("tec-a", tenantA, "tecnico");
    tecnicoA = t.cliente;
    tecnicoAId = t.id;
    adminB = (await usuario("admin-b", tenantB, "admin")).cliente;
    instA = await instalacion(tenantA, "Torre A");
    instA2 = await instalacion(tenantA, "Torre A2");
    instB = await instalacion(tenantB, "Torre B");
    panelA = await panel(instA);
    panelA2 = await panel(instA2);
    panelB = await panel(instB);
    await conflicto("viejo", tenantA, instA, panelA, { created_at: "2026-03-01T10:00:00Z", kind: "unique", resolution: "Rechazado: duplicado." });
    await conflicto("medio", tenantA, instA, panelA, { created_at: "2026-03-02T10:00:00Z" });
    await conflicto("nuevo", tenantA, instA, panelA, { created_at: "2026-03-03T10:00:00Z", kind: "skew", resolution: "Hora del panel adelantada: se usó la hora del servidor." });
    await conflicto("otraInst", tenantA, instA2, panelA2);
    await conflicto("tenantB", tenantB, instB, panelB);
  });

  afterAll(async () => {
    const borrado = async (que: string, consulta: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await consulta;
      if (error) throw new Error(`No se pudo limpiar ${que}: ${error.message}`);
    };
    await borrado("paneles", admin.from("panels").delete().in("id", paneles));
    await borrado("tenants", admin.from("tenants").delete().in("id", tenants));
    for (const u of usuarios) {
      const { error } = await admin.auth.admin.deleteUser(u);
      if (error) throw new Error(`No se pudo borrar el usuario ${u}: ${error.message}`);
    }
  });

  it("lista los de la instalación, del más reciente al más viejo, con el código del panel", async () => {
    const r = await listConflictsAs(tecnicoA, tenantA, instA, 1);
    expect(r.rows.map((c) => c.id)).toEqual([ids.nuevo, ids.medio, ids.viejo]);
    expect(r.total).toBe(3);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(50);
    expect(r.rows[2]).toMatchObject({ kind: "unique", table_name: "cards", resolution: "Rechazado: duplicado.", reviewed_at: null });
    expect(r.rows[0].panel_code).toMatch(/^PNL-/);
  });

  it("pagina de 50 con orden total y una página fuera de rango queda vacía", async () => {
    const inst = await instalacion(tenantA, "Muchos");
    const p = await panel(inst);
    const { error } = await admin.from("sync_conflicts").insert(
      Array.from({ length: 120 }, (_, i) => ({
        tenant_id: tenantA,
        installation_id: inst,
        panel_id: p,
        table_name: "cards",
        row_id: randomUUID(),
        kind: "lww",
        resolution: "x",
        created_at: new Date(Date.parse("2026-05-01T00:00:00Z") + Math.floor(i / 4) * 1000).toISOString(),
      })),
    );
    if (error) throw error;
    const paginas = [];
    for (const n of [1, 2, 3]) paginas.push(await listConflictsAs(adminA, tenantA, inst, n));
    expect(paginas.map((x) => x.rows.length)).toEqual([50, 50, 20]);
    expect(new Set(paginas.flatMap((x) => x.rows.map((c) => c.id))).size).toBe(120);
    const fuera = await listConflictsAs(adminA, tenantA, inst, 9);
    expect(fuera).toMatchObject({ rows: [], total: 120, page: 9 });
  });

  it("un técnico lo marca como revisado: queda en la lista con fecha y autor del servidor, y es idempotente", async () => {
    await markConflictReviewedAs(tecnicoA, tenantA, instA, ids.medio);
    const r = await listConflictsAs(adminA, tenantA, instA, 1);
    const medio = r.rows.find((c) => c.id === ids.medio)!;
    expect(medio.reviewed_at).not.toBeNull();
    expect(Date.now() - Date.parse(medio.reviewed_at!)).toBeLessThan(60_000);
    expect(r.rows.map((c) => c.id)).toEqual([ids.nuevo, ids.medio, ids.viejo]);
    const { data } = await admin.from("sync_conflicts").select("reviewed_by").eq("id", ids.medio).single();
    expect(data!.reviewed_by).toBe(tecnicoAId);

    // Repetir (otro administrador) no cambia la fecha ni el autor.
    await markConflictReviewedAs(adminA, tenantA, instA, ids.medio);
    const otra = await listConflictsAs(adminA, tenantA, instA, 1);
    expect(otra.rows.find((c) => c.id === ids.medio)!.reviewed_at).toBe(medio.reviewed_at);
    const { data: despues } = await admin.from("sync_conflicts").select("reviewed_by").eq("id", ids.medio).single();
    expect(despues!.reviewed_by).toBe(tecnicoAId);
  });

  it("un admin también puede marcar", async () => {
    await markConflictReviewedAs(adminA, tenantA, instA, ids.viejo);
    const { data } = await admin.from("sync_conflicts").select("reviewed_at").eq("id", ids.viejo).single();
    expect(data!.reviewed_at).not.toBeNull();
  });

  it("no marca el de otro tenant ni el de otra instalación, ni lo lista", async () => {
    expect((await fallo(markConflictReviewedAs(adminB, tenantA, instA, ids.nuevo))).status).toBe(403);
    expect((await fallo(markConflictReviewedAs(tecnicoA, tenantA, instB, ids.nuevo))).status).toBe(404);
    // Conflicto del tenant B pedido con el tenant y la instalación de A.
    expect((await fallo(markConflictReviewedAs(tecnicoA, tenantA, instA, ids.tenantB))).status).toBe(404);
    // Conflicto de otra instalación del mismo tenant.
    expect((await fallo(markConflictReviewedAs(tecnicoA, tenantA, instA, ids.otraInst))).status).toBe(404);
    const { data } = await admin.from("sync_conflicts").select("id, reviewed_at").in("id", [ids.nuevo, ids.tenantB, ids.otraInst]);
    expect(data!.every((c) => c.reviewed_at === null)).toBe(true);
    expect((await fallo(listConflictsAs(adminB, tenantA, instA, 1))).status).toBe(403);
    expect((await fallo(listConflictsAs(tecnicoA, tenantA, instB, 1))).status).toBe(404);
  });

  it("un id inexistente o inválido da 404", async () => {
    for (const malo of [999999999, 0, -3, 1.5, Number.NaN]) {
      expect((await fallo(markConflictReviewedAs(tecnicoA, tenantA, instA, malo))).status).toBe(404);
    }
  });
});
