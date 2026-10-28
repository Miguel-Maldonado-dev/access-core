import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import {
  createInstallationAs,
  getInstallationAs,
  listInstallationsAs,
  renameInstallationAs,
} from "@/lib/installations";
import { listPanelsAs } from "@/lib/panels/list";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Instalaciones y lectura de paneles con RLS contra el Supabase local (N12). */
const CLAVE = "Clave-de-prueba-123";

async function fallo(promesa: Promise<unknown>): Promise<number> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  throw new Error("Se esperaba un HttpError y salió bien.");
}

describe("instalaciones y paneles de un tenant (N12)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `n12-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let instB: string;

  async function usuario(nombre: string, tenantId: string, role: "admin" | "tecnico") {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role });
    if (error) throw error;
    return signInLocal(correo(nombre), CLAVE);
  }

  beforeAll(async () => {
    requireLocalSupabase();
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `N12 ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    adminA = await usuario("admin-a", tenantA, "admin");
    tecnicoA = await usuario("tec-a", tenantA, "tecnico");
    adminB = await usuario("admin-b", tenantB, "admin");
    instB = (await createInstallationAs(adminB, tenantB, "Instalación B")).id;
  });

  afterAll(async () => {
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  it("el admin crea y el técnico no", async () => {
    const { id } = await createInstallationAs(adminA, tenantA, "  Torre Norte ");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await fallo(createInstallationAs(tecnicoA, tenantA, "Otra"))).toBe(403);
    expect(await fallo(createInstallationAs(adminA, tenantA, "   "))).toBe(400);
    expect((await listInstallationsAs(tecnicoA, tenantA)).map((i) => i.name)).toEqual(["Torre Norte"]);
  });

  it("un técnico renombra", async () => {
    const [inst] = await listInstallationsAs(tecnicoA, tenantA);
    await renameInstallationAs(tecnicoA, tenantA, inst.id, "Torre Poniente");
    expect((await getInstallationAs(tecnicoA, tenantA, inst.id))?.name).toBe("Torre Poniente");
  });

  it("la instalación de otro tenant da 404 (get, rename) y 403 (lista)", async () => {
    expect(await getInstallationAs(adminA, tenantA, instB)).toBeNull();
    expect(await fallo(renameInstallationAs(adminA, tenantA, instB, "Robada"))).toBe(404);
    expect(await fallo(listInstallationsAs(adminA, tenantB))).toBe(403);
    expect(await getInstallationAs(adminA, tenantA, "no-es-uuid")).toBeNull();
    const { data } = await admin.from("installations").select("name").eq("id", instB).single();
    expect(data?.name).toBe("Instalación B");
  });

  it("lista los paneles de la instalación sin columnas secretas", async () => {
    const codigo = `PNL-${sufijo.slice(0, 4).toUpperCase().replace(/[ILOU]/g, "A")}-ZZZZ`;
    const { data: panel, error } = await admin
      .from("panels")
      .insert({
        panel_code: /^PNL-[0-9A-HJKMNP-TV-Z]{4}-ZZZZ$/.test(codigo) ? codigo : "PNL-AAAA-ZZZZ",
        panel_secret_hash: "a".repeat(64),
        installation_id: instB,
        tenant_id: tenantB,
        status: "claimed",
      })
      .select("id")
      .single();
    if (error) throw error;
    const paneles = await listPanelsAs(adminB, instB);
    expect(paneles).toHaveLength(1);
    expect(paneles[0]).not.toHaveProperty("panel_secret_hash");
    expect(await listPanelsAs(adminA, instB)).toEqual([]);
    await admin.from("panels").delete().eq("id", panel.id);
  });
});
