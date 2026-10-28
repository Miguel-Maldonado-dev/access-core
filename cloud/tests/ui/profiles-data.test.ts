import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { listOutputsAs, updateOutputAs } from "@/lib/outputs";
import { MAX_PROFILES_MESSAGE, type RuleInput } from "@/lib/profile-view";
import {
  createProfileAs,
  deleteProfileAs,
  listHolderOptionsAs,
  listProfilesAs,
  renameProfileAs,
  saveProfileRulesAs,
  setProfileHoldersAs,
} from "@/lib/profiles";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Perfiles, reglas por panel, asignaciones y salidas con RLS contra el Supabase local (N14). */
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

const regla = (extra: Partial<RuleInput> = {}): RuleInput => ({
  output_mask: 0b0011,
  card_reader_mask: 0b0001,
  pin_reader_mask: 0b0010,
  allow_rf: true,
  weekday_mask: 0b0011111,
  start_minute: 480,
  end_minute: 1080,
  ...extra,
});

describe("perfiles y salidas (N14)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `n14-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instB: string;
  let panelA: string;
  let panelB: string;
  let panelBInstB: string;

  async function usuario(nombre: string, tenantId: string, role: "admin" | "tecnico") {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role });
    if (error) throw error;
    return signInLocal(correo(nombre), CLAVE);
  }

  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  let contadorPanel = 0;
  async function panel(installationId: string, status = "active"): Promise<string> {
    const n = ++contadorPanel;
    const hex = (n * 7919 + Number.parseInt(sufijo, 16)).toString(32).toUpperCase().replace(/[ILOU]/g, "X");
    const codigo = `PNL-${hex.padStart(8, "0").slice(0, 4)}-${hex.padStart(8, "0").slice(4, 8)}`;
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: codigo,
        panel_secret_hash: "a".repeat(64),
        installation_id: installationId,
        status,
        ...(["staging", "awaiting_review", "active"].includes(status) ? { device_token_hash: "b".repeat(64) } : {}),
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    return data.id;
  }

  async function salidas(panelId: string, installationId: string) {
    const { error } = await admin.from("outputs").insert(
      [0, 1, 2, 3].map((i) => ({
        installation_id: installationId,
        panel_id: panelId,
        output_index: i,
        alias: "",
        duration_ms: 3000,
        reader_mask: 1,
        enabled: true,
        ...AUTOR,
      })),
    );
    if (error) throw error;
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

  const revision = async (installationId: string) =>
    (await admin.from("installations").select("revision").eq("id", installationId).single()).data!.revision as number;

  beforeAll(async () => {
    requireLocalSupabase();
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `N14 ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    adminA = await usuario("admin-a", tenantA, "admin");
    tecnicoA = await usuario("tec-a", tenantA, "tecnico");
    adminB = await usuario("admin-b", tenantB, "admin");
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    panelA = await panel(instA);
    panelB = await panel(instA);
    panelBInstB = await panel(instB);
    for (const [p, i] of [[panelA, instA], [panelB, instA], [panelBInstB, instB]]) await salidas(p, i);
  });

  // Orden: lo que cuelga de los paneles, los paneles (FK hacia tenants), los tenants (cascada a
  // instalaciones y datos) y al final los usuarios. Cada borrado se comprueba: una falla no pasa en silencio.
  afterAll(async () => {
    const borrado = async (que: string, consulta: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await consulta;
      if (error) throw new Error(`No se pudo limpiar ${que}: ${error.message}`);
    };
    await borrado("outputs", admin.from("outputs").delete().in("panel_id", paneles));
    await borrado("reglas", admin.from("profile_panel_rules").delete().in("panel_id", paneles));
    await borrado("paneles", admin.from("panels").delete().in("id", paneles));
    await borrado("tenants", admin.from("tenants").delete().in("id", tenants));
    for (const u of usuarios) {
      const { error } = await admin.auth.admin.deleteUser(u);
      if (error) throw new Error(`No se pudo borrar el usuario ${u}: ${error.message}`);
    }
  });

  describe("alta, número y borrado de perfiles", () => {
    it("usa el menor número libre, reutiliza el de un perfil borrado y rechaza el 33", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 32; i++) {
        const { id, local_permission_id } = await createProfileAs(adminA, tenantA, instA, `Perfil ${i}`);
        expect(local_permission_id).toBe(i);
        ids.push(id);
      }
      const treintaYTres = await fallo(createProfileAs(adminA, tenantA, instA, "Sobra"));
      expect(treintaYTres.status).toBe(409);
      expect(treintaYTres.message).toBe(MAX_PROFILES_MESSAGE);
      expect(treintaYTres.message).toBe("Máximo 32 perfiles por instalación.");
      expect((await listProfilesAs(adminA, tenantA, instA)).length).toBe(32);

      await deleteProfileAs(tecnicoA, tenantA, instA, ids[5]);
      const nuevo = await createProfileAs(tecnicoA, tenantA, instA, "Reusa 5");
      expect(nuevo.local_permission_id).toBe(5);

      // Otra instalación del mismo tenant tiene su propia numeración.
      const otra = await instalacion(tenantA, "Torre A2");
      expect((await createProfileAs(adminA, tenantA, otra, "Primero")).local_permission_id).toBe(0);

      await admin.from("access_profiles").delete().eq("installation_id", instA);
    });

    it("dos altas simultáneas no dan error ni repiten número", async () => {
      const inst = await instalacion(tenantA, "Carrera");
      const [a, b, c] = await Promise.all([
        createProfileAs(adminA, tenantA, inst, "Uno"),
        createProfileAs(tecnicoA, tenantA, inst, "Dos"),
        createProfileAs(adminA, tenantA, inst, "Tres"),
      ]);
      expect([a, b, c].map((x) => x.local_permission_id).sort()).toEqual([0, 1, 2]);
    });

    it("valida el nombre, renombra y borra con cascada a reglas y asignaciones", async () => {
      const inst = await instalacion(tenantA, "Cascada");
      const p = await panel(inst);
      expect((await fallo(createProfileAs(adminA, tenantA, inst, "   "))).status).toBe(400);
      expect((await fallo(createProfileAs(adminA, tenantA, inst, "x".repeat(61)))).status).toBe(400);
      const { id } = await createProfileAs(adminA, tenantA, inst, "  Residente ");
      await renameProfileAs(tecnicoA, tenantA, inst, id, "Residentes");
      const h = await titular(inst, "Ana");
      await saveProfileRulesAs(adminA, tenantA, inst, id, [{ panel_id: p, rule: regla() }]);
      await setProfileHoldersAs(adminA, tenantA, inst, id, [h]);
      const [perfil] = await listProfilesAs(adminA, tenantA, inst);
      expect(perfil).toMatchObject({ id, name: "Residentes", local_permission_id: 0, holder_ids: [h] });
      expect(perfil.rules).toHaveLength(1);

      await deleteProfileAs(adminA, tenantA, inst, id);
      expect(await listProfilesAs(adminA, tenantA, inst)).toEqual([]);
      const reglas = await admin.from("profile_panel_rules").select("deleted_at").eq("profile_id", id);
      const asignaciones = await admin.from("holder_profiles").select("deleted_at").eq("profile_id", id);
      expect(reglas.data!.every((r) => r.deleted_at !== null)).toBe(true);
      expect(asignaciones.data!.every((r) => r.deleted_at !== null)).toBe(true);
      expect((await fallo(deleteProfileAs(adminA, tenantA, inst, id))).status).toBe(404);
      expect((await fallo(renameProfileAs(adminA, tenantA, inst, id, "Otra"))).status).toBe(404);
    });
  });

  describe("reglas por panel", () => {
    let perfilId: string;
    beforeAll(async () => {
      perfilId = (await createProfileAs(adminA, tenantA, instA, "Reglas")).id;
    });

    it("guarda una regla solo para el panel A: profile_panel_rules tiene 1 fila", async () => {
      await saveProfileRulesAs(tecnicoA, tenantA, instA, perfilId, [
        { panel_id: panelA, rule: regla() },
        { panel_id: panelB, rule: null },
      ]);
      const { data } = await admin
        .from("profile_panel_rules")
        .select("panel_id, output_mask, card_reader_mask, pin_reader_mask, allow_rf, weekday_mask, start_minute, end_minute, origin, deleted_at")
        .eq("profile_id", perfilId);
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({ panel_id: panelA, ...regla(), origin: "cloud", deleted_at: null });
      const [perfil] = (await listProfilesAs(adminA, tenantA, instA)).filter((p) => p.id === perfilId);
      expect(perfil.rules.map((r) => r.panel_id)).toEqual([panelA]);
    });

    it("actualiza solo si cambió, agrega el panel B y borra la regla con 'sin acceso'", async () => {
      const antes = await revision(instA);
      await saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: regla() }]);
      expect(await revision(instA)).toBe(antes);

      await saveProfileRulesAs(adminA, tenantA, instA, perfilId, [
        { panel_id: panelA, rule: regla({ allow_rf: false, output_mask: 15 }) },
        { panel_id: panelB, rule: regla({ weekday_mask: 127, start_minute: 0, end_minute: 0 }) },
      ]);
      expect(await revision(instA)).toBeGreaterThan(antes);
      const vivas = await admin.from("profile_panel_rules").select("panel_id, allow_rf, output_mask").eq("profile_id", perfilId).is("deleted_at", null);
      expect(vivas.data).toHaveLength(2);
      expect(vivas.data!.find((r) => r.panel_id === panelA)).toMatchObject({ allow_rf: false, output_mask: 15 });

      await saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: null }]);
      const quedan = await admin.from("profile_panel_rules").select("panel_id").eq("profile_id", perfilId).is("deleted_at", null);
      expect(quedan.data!.map((r) => r.panel_id)).toEqual([panelB]);

      // Volver a dar acceso inserta una regla nueva (la anterior queda borrada).
      await saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: regla() }]);
      const todas = await admin.from("profile_panel_rules").select("id").eq("profile_id", perfilId).eq("panel_id", panelA);
      expect(todas.data).toHaveLength(2);
    });

    it("rechaza reglas inválidas, paneles ajenos o revocados, y perfiles de otra instalación", async () => {
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: regla({ output_mask: 16 }) }]))).status).toBe(400);
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: regla({ start_minute: 1440 }) }]))).status).toBe(400);
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: { ...regla(), extra: 1 } as RuleInput }]))).status).toBe(400);
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelBInstB, rule: regla() }]))).status).toBe(400);
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: panelA, rule: regla() }, { panel_id: panelA, rule: null }]))).status).toBe(400);
      const revocado = await panel(instA, "revoked");
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, perfilId, [{ panel_id: revocado, rule: regla() }]))).status).toBe(400);
      expect((await fallo(saveProfileRulesAs(adminA, tenantA, instA, randomUUID(), [{ panel_id: panelA, rule: regla() }]))).status).toBe(404);
      expect((await fallo(saveProfileRulesAs(adminB, tenantB, instB, perfilId, [{ panel_id: panelBInstB, rule: regla() }]))).status).toBe(404);
    });
  });

  describe("asignación a titulares", () => {
    it("asigna, quita y deja solo la selección; no toca lo que no cambia", async () => {
      const inst = await instalacion(tenantA, "Asignación");
      const { id } = await createProfileAs(adminA, tenantA, inst, "Servicio");
      const [h1, h2, h3] = [await titular(inst, "Beto"), await titular(inst, "Ana"), await titular(inst, "Carla")];
      expect((await listHolderOptionsAs(adminA, tenantA, inst)).map((h) => h.name)).toEqual(["Ana", "Beto", "Carla"]);

      await setProfileHoldersAs(tecnicoA, tenantA, inst, id, [h1, h2]);
      const antes = await revision(inst);
      await setProfileHoldersAs(tecnicoA, tenantA, inst, id, [h2, h1]);
      expect(await revision(inst)).toBe(antes);

      await setProfileHoldersAs(tecnicoA, tenantA, inst, id, [h2, h3]);
      const [perfil] = await listProfilesAs(adminA, tenantA, inst);
      expect([...perfil.holder_ids].sort()).toEqual([h2, h3].sort());

      await setProfileHoldersAs(tecnicoA, tenantA, inst, id, []);
      expect((await listProfilesAs(adminA, tenantA, inst))[0].holder_ids).toEqual([]);
      // Volver a asignar a uno que se quitó funciona (la fila vieja sigue borrada).
      await setProfileHoldersAs(tecnicoA, tenantA, inst, id, [h1]);
      expect((await listProfilesAs(adminA, tenantA, inst))[0].holder_ids).toEqual([h1]);
    });

    it("rechaza titulares inexistentes o de otra instalación", async () => {
      const inst = await instalacion(tenantA, "Asignación 2");
      const { id } = await createProfileAs(adminA, tenantA, inst, "P");
      const ajeno = await titular(instB, "Ajeno");
      expect((await fallo(setProfileHoldersAs(adminA, tenantA, inst, id, [ajeno]))).status).toBe(409);
      expect((await fallo(setProfileHoldersAs(adminA, tenantA, inst, id, ["no-uuid"]))).status).toBe(400);
      expect((await fallo(setProfileHoldersAs(adminA, tenantA, inst, id, [randomUUID()]))).status).toBe(409);
    });

    it("el borrado lógico de un titular lo quita de las asignaciones", async () => {
      const inst = await instalacion(tenantA, "Asignación 3");
      const { id } = await createProfileAs(adminA, tenantA, inst, "P");
      const h = await titular(inst, "Temporal");
      await setProfileHoldersAs(adminA, tenantA, inst, id, [h]);
      await admin.from("holders").update({ deleted_at: new Date().toISOString() }).eq("id", h);
      expect((await listProfilesAs(adminA, tenantA, inst))[0].holder_ids).toEqual([]);
    });
  });

  describe("aislamiento entre tenants", () => {
    it("un usuario de B no ve ni edita los perfiles de A", async () => {
      expect((await fallo(listProfilesAs(adminB, tenantB, instA))).status).toBe(404);
      expect((await fallo(createProfileAs(adminB, tenantB, instA, "Intruso"))).status).toBe(404);
      expect((await fallo(listProfilesAs(adminB, tenantA, instA))).status).toBe(403);
      expect((await fallo(listOutputsAs(adminB, tenantB, instA))).status).toBe(404);
    });
  });

  describe("salidas", () => {
    it("lista las 4 salidas por panel, ordenadas", async () => {
      const lista = await listOutputsAs(tecnicoA, tenantA, instA);
      expect(lista).toHaveLength(8);
      expect(lista.filter((o) => o.panel_id === panelA).map((o) => o.output_index)).toEqual([0, 1, 2, 3]);
    });

    it("cambiar el alias aumenta la revisión; sin cambios no escribe", async () => {
      const [primera] = (await listOutputsAs(tecnicoA, tenantA, instA)).filter((o) => o.panel_id === panelA);
      const entrada = { alias: "  Pluma vehicular ", duration_ms: 3000, reader_mask: 1, enabled: true };
      const antes = await revision(instA);
      await updateOutputAs(tecnicoA, tenantA, instA, primera.id, entrada);
      const despues = await revision(instA);
      expect(despues).toBeGreaterThan(antes);
      const { data } = await admin.from("outputs").select("alias, origin, revision").eq("id", primera.id).single();
      expect(data).toMatchObject({ alias: "Pluma vehicular", origin: "cloud" });
      expect(data!.revision).toBeGreaterThan(antes);

      await updateOutputAs(tecnicoA, tenantA, instA, primera.id, entrada);
      expect(await revision(instA)).toBe(despues);

      await updateOutputAs(adminA, tenantA, instA, primera.id, { alias: "Pluma vehicular", duration_ms: 65535, reader_mask: 15, enabled: false });
      const { data: cambio } = await admin.from("outputs").select("duration_ms, reader_mask, enabled").eq("id", primera.id).single();
      expect(cambio).toEqual({ duration_ms: 65535, reader_mask: 15, enabled: false });
    });

    it("valida duración, lectores, alias y pertenencia", async () => {
      const [o] = await listOutputsAs(adminA, tenantA, instA);
      const ok = { alias: "", duration_ms: 1000, reader_mask: 1, enabled: true };
      for (const malo of [
        { ...ok, duration_ms: 65536 },
        { ...ok, duration_ms: -1 },
        { ...ok, duration_ms: 1.5 },
        { ...ok, reader_mask: 16 },
        { ...ok, alias: "x".repeat(61) },
        { ...ok, enabled: "si" },
        { ...ok, extra: 1 },
      ]) {
        expect((await fallo(updateOutputAs(adminA, tenantA, instA, o.id, malo))).status).toBe(400);
      }
      expect((await fallo(updateOutputAs(adminA, tenantA, instA, randomUUID(), ok))).status).toBe(404);
      expect((await fallo(updateOutputAs(adminB, tenantB, instB, o.id, ok))).status).toBe(404);
    });
  });
});
