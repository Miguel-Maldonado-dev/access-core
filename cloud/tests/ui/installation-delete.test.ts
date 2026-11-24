import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as activate } from "@/app/api/device/v1/activate/route";
import { GET as linkState } from "@/app/api/device/v1/link-state/route";
import { POST as register } from "@/app/api/device/v1/register/route";
import { HttpError } from "@/lib/errors";
import { deleteInstallationAs } from "@/lib/installation-delete";
import { claimPanelAs } from "@/lib/panels/claim";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// "Eliminar instalación" contra el Supabase LOCAL, con un panel real (register → claim → activate).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const CLAVE = "Clave-de-prueba-123";
const URL_BASE = "http://localhost/api/device/v1";

function post(ruta: string, cuerpo: unknown): Request {
  return new Request(`${URL_BASE}/${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
}

async function fallo(promesa: Promise<unknown>): Promise<HttpError> {
  try {
    await promesa;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Se esperaba un HttpError y salió bien.");
}

describe("deleteInstallationAs", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `di-${n}-${sufijo}@test.local`;
  const nombre = `Fracc Eliminar ${sufijo}`;
  const usuarios: string[] = [];
  const panel = {
    code: `PNL-${base32(4)}-${base32(4)}`,
    claimCode: base32(8),
    secret: randomBytes(32).toString("hex"),
  };
  let tenant: string;
  let inst: string;
  let inst2: string;
  let adminC: SupabaseClient;
  let tecnicoC: SupabaseClient;
  let token = "";

  const registrar = () =>
    register(
      post("register", {
        panel_code: panel.code,
        claim_code_hash: sha256(panel.claimCode),
        panel_secret_hash: sha256(panel.secret),
        software_version: "1.0.0",
        schema_version: 7,
      }),
    );
  const estado = () =>
    linkState(new Request(`${URL_BASE}/link-state`, { headers: { authorization: `Device ${panel.code}.${token}` } }));
  const contar = async (tabla: string, id: string) => {
    const { count, error } = await admin.from(tabla).select("*", { count: "exact", head: true }).eq("installation_id", id);
    if (error) throw error;
    return count ?? 0;
  };

  beforeAll(async () => {
    requireLocalSupabase();
    const { data: t, error: e1 } = await admin.from("tenants").insert({ name: `DI ${sufijo}` }).select("id").single();
    if (e1) throw e1;
    tenant = t.id;
    const ids = await Promise.all([createLocalUser(admin, correo("admin"), CLAVE), createLocalUser(admin, correo("tec"), CLAVE)]);
    usuarios.push(...ids);
    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenant, user_id: ids[0], role: "admin" },
      { tenant_id: tenant, user_id: ids[1], role: "tecnico" },
    ]);
    if (e2) throw e2;
    const { data: i, error: e3 } = await admin
      .from("installations")
      .insert([
        { tenant_id: tenant, name: nombre },
        { tenant_id: tenant, name: `${nombre} B` },
      ])
      .select("id, name");
    if (e3) throw e3;
    inst = i.find((x) => x.name === nombre)!.id;
    inst2 = i.find((x) => x.name !== nombre)!.id;
    [adminC, tecnicoC] = await Promise.all([signInLocal(correo("admin"), CLAVE), signInLocal(correo("tec"), CLAVE)]);

    expect((await registrar()).status).toBe(201);
    await claimPanelAs(adminC, inst, panel.code, panel.claimCode);
    const act = await activate(post("activate", { panel_code: panel.code, panel_secret: panel.secret }));
    expect(act.status).toBe(200);
    token = ((await act.json()) as { device_token: string }).device_token;
    expect((await estado()).status).toBe(200);

    const { error: e4 } = await admin.from("holders").insert({
      installation_id: inst,
      kind: "persona",
      name: "Ana",
      updated_by: "prueba",
      origin: "cloud",
    });
    if (e4) throw e4;
  });

  afterAll(async () => {
    await admin.from("panels").delete().eq("panel_code", panel.code);
    await admin.from("tenants").delete().eq("id", tenant);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  it("un técnico recibe 403 y no borra nada", async () => {
    expect((await fallo(deleteInstallationAs(tecnicoC, tenant, inst, nombre))).status).toBe(403);
    expect(await contar("holders", inst)).toBe(1);
  });

  it("un nombre distinto da 400 (distingue mayúsculas)", async () => {
    for (const mal of ["", "otro", nombre.toUpperCase()]) {
      expect(await fallo(deleteInstallationAs(adminC, tenant, inst, mal))).toMatchObject({
        status: 400,
        message: "El nombre no coincide con la instalación.",
      });
    }
    expect(await contar("holders", inst)).toBe(1);
  });

  it("una instalación de otro tenant o inexistente da 404", async () => {
    expect((await fallo(deleteInstallationAs(adminC, tenant, randomUUID(), nombre))).status).toBe(404);
  });

  it("el admin la elimina; el panel recibe 401, se registra de nuevo y se reclama en otra", async () => {
    await deleteInstallationAs(adminC, tenant, inst, `  ${nombre} `);

    const { data: fila } = await admin.from("installations").select("id").eq("id", inst);
    expect(fila).toEqual([]);
    expect(await contar("holders", inst)).toBe(0);
    expect(await contar("panels", inst)).toBe(0);
    expect(await contar("holders", inst2)).toBe(0);
    const { data: otra } = await admin.from("installations").select("id").eq("id", inst2);
    expect(otra).toHaveLength(1);

    const res = await estado();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });

    // El agente borra su credencial, genera otro código y se registra con el mismo secreto.
    panel.claimCode = base32(8);
    const reg = await registrar();
    expect(reg.status).toBe(201);
    expect(await reg.json()).toEqual({ status: "pending" });
    await expect(claimPanelAs(adminC, inst2, panel.code, panel.claimCode)).resolves.toMatchObject({
      status: "claimed",
      installation_id: inst2,
    });
    expect((await activate(post("activate", { panel_code: panel.code, panel_secret: panel.secret }))).status).toBe(200);
  });
});
