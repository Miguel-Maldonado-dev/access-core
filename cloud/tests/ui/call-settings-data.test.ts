import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCallSettingsAs, updateCallSettingsAs } from "@/lib/call-settings";
import { CALL_LIMIT_MESSAGE } from "@/lib/call-view";
import { HttpError } from "@/lib/errors";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Configuración de llamadas por panel con RLS contra el Supabase local: lectura técnico+, edición solo admin. */
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

const entrada = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: "menu",
  output_index: 0,
  menu_mask: 0b0111,
  default_output: 2,
  call_limit_per_minute: 7,
  ...extra,
});

describe("configuración de llamadas (T10)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `t10-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const paneles: string[] = [];
  let tenant = "";
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let inst = "";
  let ajusteId = "";

  async function usuario(nombre: string, role: "admin" | "tecnico") {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenant, user_id: id, role });
    if (error) throw error;
    return signInLocal(correo(nombre), CLAVE);
  }

  beforeAll(async () => {
    requireLocalSupabase();
    const t = await admin.from("tenants").insert({ name: `T10 ${sufijo}` }).select("id").single();
    if (t.error) throw t.error;
    tenant = t.data.id;
    adminA = await usuario("admin", "admin");
    tecnicoA = await usuario("tec", "tecnico");
    const i = await admin.from("installations").insert({ tenant_id: tenant, name: "Torre" }).select("id").single();
    if (i.error) throw i.error;
    inst = i.data.id;
    const hex = Number.parseInt(sufijo, 16).toString(32).toUpperCase().replace(/[ILOU]/g, "X").padStart(8, "0").slice(0, 8);
    const p = await admin
      .from("panels")
      .insert({
        panel_code: `PNL-${hex.slice(0, 4)}-${hex.slice(4, 8)}`,
        panel_secret_hash: "a".repeat(64),
        installation_id: inst,
        status: "active",
        device_token_hash: "b".repeat(64),
      })
      .select("id")
      .single();
    if (p.error) throw p.error;
    paneles.push(p.data.id);
    const c = await admin
      .from("panel_call_settings")
      .insert({ installation_id: inst, panel_id: p.data.id, ...AUTOR })
      .select("id")
      .single();
    if (c.error) throw c.error;
    ajusteId = c.data.id;
  });

  afterAll(async () => {
    await admin.from("panels").delete().in("id", paneles);
    await admin.from("tenants").delete().eq("id", tenant);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  it("el técnico lee los valores por omisión (3 por minuto)", async () => {
    const filas = await listCallSettingsAs(tecnicoA, tenant, inst);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: ajusteId, enabled: false, mode: "single", call_limit_per_minute: 3 });
  });

  it("el técnico no edita (403) y nada cambia", async () => {
    expect((await fallo(updateCallSettingsAs(tecnicoA, tenant, inst, ajusteId, entrada()))).status).toBe(403);
    expect((await listCallSettingsAs(adminA, tenant, inst))[0].enabled).toBe(false);
  });

  it("el admin edita y la lista lo refleja", async () => {
    await updateCallSettingsAs(adminA, tenant, inst, ajusteId, entrada());
    expect((await listCallSettingsAs(tecnicoA, tenant, inst))[0]).toMatchObject({
      enabled: true,
      mode: "menu",
      menu_mask: 7,
      default_output: 2,
      call_limit_per_minute: 7,
    });
  });

  it("un cambio igual no escribe (no sube la revisión)", async () => {
    const antes = (await admin.from("panel_call_settings").select("revision").eq("id", ajusteId).single()).data!.revision;
    await updateCallSettingsAs(adminA, tenant, inst, ajusteId, entrada());
    const despues = (await admin.from("panel_call_settings").select("revision").eq("id", ajusteId).single()).data!.revision;
    expect(despues).toBe(antes);
  });

  it("valida el límite y la predeterminada, y responde 404 a un id ajeno", async () => {
    expect((await fallo(updateCallSettingsAs(adminA, tenant, inst, ajusteId, entrada({ call_limit_per_minute: 21 })))).message).toBe(CALL_LIMIT_MESSAGE);
    expect((await fallo(updateCallSettingsAs(adminA, tenant, inst, ajusteId, entrada({ default_output: 3 })))).status).toBe(400);
    expect((await fallo(updateCallSettingsAs(adminA, tenant, inst, randomUUID(), entrada()))).status).toBe(404);
    expect((await fallo(updateCallSettingsAs(adminA, tenant, inst, "x", entrada()))).status).toBe(404);
  });

  it("«Una salida» con predeterminada fuera del menú se guarda sin ella", async () => {
    await updateCallSettingsAs(adminA, tenant, inst, ajusteId, entrada({ mode: "single", output_index: 1, menu_mask: 0b0001, default_output: 3 }));
    expect((await listCallSettingsAs(adminA, tenant, inst))[0]).toMatchObject({ mode: "single", output_index: 1, default_output: null });
  });
});
