import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiActor } from "@/lib/auth/guards";
import { createCardAs, listCardsAs } from "@/lib/cards";
import { createControlAs, listControlsAs, updateControlAs } from "@/lib/controls";
import { HttpError } from "@/lib/errors";
import { createHolderAs, deleteHolderAs, getHolderPinAs, listHoldersAs } from "@/lib/holders";
import { listInstallationsAs } from "@/lib/installations";
import { listLogsAs } from "@/lib/logs";
import { listOutputsAs } from "@/lib/outputs";
import { listPanelsAs } from "@/lib/panels/list";
import { createProfileAs, listProfilesAs, renameProfileAs } from "@/lib/profiles";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** La capa de datos con un actor de API (sin sesión), contra el Supabase local. */
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

const titular = (nombre: string, extra: Record<string, unknown> = {}) => ({
  kind: "persona" as const,
  name: nombre,
  department: "",
  address: "",
  notes: "",
  pin: { mode: "keep" as const },
  ...extra,
});

describe("actor de API en la capa de datos", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `api-actor-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };
  let adminA: SupabaseClient;
  let adminAId: string;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instB: string;
  let panelA: string;
  let panelB: string;
  let actorA: ApiActor;

  async function usuario(nombre: string, tenantId: string) {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role: "admin" });
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

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `API ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    ({ id: adminAId, cliente: adminA } = await usuario("admin-a", tenantA));
    ({ cliente: adminB } = await usuario("admin-b", tenantB));
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    panelA = await panel(instA);
    panelB = await panel(instB);
    actorA = { kind: "api", tenantId: tenantA, keyId: randomUUID(), keyName: "Integración A" };
  });

  afterAll(async () => {
    await admin.from("control_button_panels").delete().in("panel_id", paneles);
    await admin.from("panels").delete().in("id", paneles);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
    for (const [nombre, valor] of [
      ["PIN_ENC_KEY", claves.enc],
      ["PIN_LOOKUP_KEY", claves.lookup],
    ] as const) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
  });

  async function autoriaDe(tabla: string, id: string) {
    const { data, error } = await admin.from(tabla).select("updated_by, origin").eq("id", id).single();
    if (error) throw error;
    return data as { updated_by: string; origin: string };
  }

  async function auditoriaDe(id: string) {
    const { data, error } = await admin.from("audit_log").select("op, updated_by").eq("row_id", id).order("id");
    if (error) throw error;
    return data as { op: string; updated_by: string }[];
  }

  it("crea un titular firmado api:<keyId> en la fila y en audit_log", async () => {
    const { id } = await createHolderAs(actorA, tenantA, instA, titular("Ana API"));
    expect(await autoriaDe("holders", id)).toEqual({ updated_by: `api:${actorA.keyId}`, origin: "cloud" });
    expect(await auditoriaDe(id)).toEqual([{ op: "insert", updated_by: `api:${actorA.keyId}` }]);
    expect((await listHoldersAs(actorA, tenantA, instA)).map((h) => h.id)).toContain(id);
  });

  it("una escritura desde la interfaz sigue firmando user:<uid>", async () => {
    const { id } = await createHolderAs(adminA, tenantA, instA, titular("Beto UI"));
    expect(await autoriaDe("holders", id)).toEqual({ updated_by: `user:${adminAId}`, origin: "cloud" });
    expect(await auditoriaDe(id)).toEqual([{ op: "insert", updated_by: `user:${adminAId}` }]);
  });

  it("el borrado lógico en cascada queda firmado por la llave", async () => {
    const { id } = await createHolderAs(actorA, tenantA, instA, titular("Carla API"));
    const { id: tarjeta } = await createCardAs(actorA, tenantA, instA, { card_code: 7_001_001, holder_id: id, description: "" });
    expect(await autoriaDe("cards", tarjeta)).toEqual({ updated_by: `api:${actorA.keyId}`, origin: "cloud" });
    await deleteHolderAs(actorA, tenantA, instA, id);
    expect((await auditoriaDe(tarjeta)).at(-1)).toEqual({ op: "delete", updated_by: `api:${actorA.keyId}` });
  });

  it("no crea una tarjeta con el titular de otro tenant", async () => {
    const { id: holderB } = await createHolderAs(adminB, tenantB, instB, titular("Titular B"));
    const e = await fallo(createCardAs(actorA, tenantA, instA, { card_code: 7_002_002, holder_id: holderB, description: "" }));
    expect([400, 404]).toContain(e.status);
    const { data } = await admin.from("cards").select("id").eq("card_code", 7_002_002);
    expect(data).toEqual([]);
  });

  it("no vincula un botón a un panel de otro tenant", async () => {
    const { id: holder } = await createHolderAs(actorA, tenantA, instA, titular("Dora API"));
    const { id: control } = await createControlAs(actorA, tenantA, instA, {
      holder_id: holder,
      description: "Llavero",
      buttons: [{ id: null, button: 0, rf_code: 7_003_003, outputs: { [panelA]: 0 } }],
    });
    const { data: botones } = await admin.from("control_buttons").select("id, updated_by").eq("control_id", control);
    expect(botones).toEqual([{ id: expect.any(String), updated_by: `api:${actorA.keyId}` }]);
    const antes = await listControlsAs(actorA, tenantA, instA);

    const e = await fallo(
      updateControlAs(actorA, tenantA, instA, control, {
        holder_id: holder,
        description: "Llavero",
        buttons: [{ id: botones![0].id, button: 0, rf_code: 7_003_003, outputs: { [panelB]: 1 } }],
      }),
    );
    expect(e.status).toBe(400);
    expect(await listControlsAs(actorA, tenantA, instA)).toEqual(antes);
    const { data: ajenos } = await admin.from("control_button_panels").select("id").eq("panel_id", panelB);
    expect(ajenos).toEqual([]);
  });

  it("no renombra un perfil de otro tenant aunque la instalación sea propia", async () => {
    const { id: perfilB } = await createProfileAs(adminB, tenantB, instB, "Perfil B");
    const e = await fallo(renameProfileAs(actorA, tenantA, instA, perfilB, "Hackeado"));
    expect(e.status).toBe(404);
    const { data } = await admin.from("access_profiles").select("name").eq("id", perfilB).single();
    expect(data!.name).toBe("Perfil B");
  });

  it("no lista los paneles de una instalación de otro tenant", async () => {
    expect((await fallo(listPanelsAs(actorA, tenantA, instB))).status).toBe(404);
    expect((await listPanelsAs(actorA, tenantA, instA)).map((p) => p.id)).toEqual([panelA]);
  });

  it("con el tenant de otro responde 404 con el mismo texto en todas las funciones", async () => {
    const intentos: Array<() => Promise<unknown>> = [
      () => listInstallationsAs(actorA, tenantB),
      () => listHoldersAs(actorA, tenantB, instB),
      () => createHolderAs(actorA, tenantB, instB, titular("Intruso")),
      () => listCardsAs(actorA, tenantB, instB),
      () => listControlsAs(actorA, tenantB, instB),
      () => listProfilesAs(actorA, tenantB, instB),
      () => listOutputsAs(actorA, tenantB, instB),
      () => listLogsAs(actorA, tenantB, instB, { page: 1 }),
      () => listPanelsAs(actorA, tenantB, instB),
      () => listHoldersAs(actorA, "no-es-uuid", instB),
    ];
    for (const intento of intentos) {
      const e = await fallo(intento());
      expect(e.status).toBe(404);
      expect(e.message).toBe("La instalación no existe.");
    }
    const { data } = await admin.from("holders").select("id").eq("name", "Intruso");
    expect(data).toEqual([]);
  });

  it("lee el PIN de un titular: la llave actúa como admin", async () => {
    const { id } = await createHolderAs(actorA, tenantA, instA, titular("Eva API", { pin: { mode: "set", pin: "482913" } }));
    expect(await getHolderPinAs(actorA, tenantA, instA, id)).toBe("482913");
  });
});
