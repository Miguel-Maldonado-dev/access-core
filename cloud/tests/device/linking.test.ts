import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as activate } from "@/app/api/device/v1/activate/route";
import { GET as linkState } from "@/app/api/device/v1/link-state/route";
import { POST as register } from "@/app/api/device/v1/register/route";
import { GET as listLogs } from "@/app/api/v1/installations/[installationId]/logs/route";
import { GET as listSalidas } from "@/app/api/v1/installations/[installationId]/outputs/route";
import { GET as listPaneles } from "@/app/api/v1/installations/[installationId]/panels/route";
import { requireTenantRole } from "@/lib/auth/guards";
import { claimPanelAs, revokePanelAs } from "@/lib/panels/claim";
import {
  createLocalUser,
  localAdmin,
  requireLocalSupabase,
  signInLocal,
} from "../helpers/supabase-local";

// Integración contra el Supabase LOCAL: los handlers se invocan con `Request` y las
// acciones con un cliente con sesión real (RLS de verdad). Datos únicos por corrida.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const ERROR_GENERICO = "El panel no existe o el código de vinculación es incorrecto.";

interface PanelPrueba {
  code: string;
  claimCode: string;
  secret: string;
}

function nuevoPanel(): PanelPrueba {
  return {
    code: `PNL-${base32(4)}-${base32(4)}`,
    claimCode: base32(8),
    secret: randomBytes(32).toString("hex"),
  };
}

const URL_BASE = "http://localhost/api/device/v1";

function post(ruta: string, cuerpo: unknown): Request {
  return new Request(`${URL_BASE}/${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
}

function registrar(p: PanelPrueba, cambios: Record<string, unknown> = {}) {
  return register(
    post("register", {
      panel_code: p.code,
      claim_code_hash: sha256(p.claimCode),
      panel_secret_hash: sha256(p.secret),
      software_version: "1.2.3",
      schema_version: 6,
      ...cambios,
    }),
  );
}

function activar(p: PanelPrueba, secret = p.secret) {
  return activate(post("activate", { panel_code: p.code, panel_secret: secret }));
}

function estadoDeVinculo(authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return linkState(new Request(`${URL_BASE}/link-state`, { headers }));
}

describe("vinculación de paneles", () => {
  const corrida = base32(6).toLowerCase();
  const password = `Prueba-${randomBytes(12).toString("hex")}`;
  const correo = (rol: string) => `${rol}-${corrida}@pruebas.local`;

  let admin: SupabaseClient;
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const panelesCreados: string[] = [];

  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instA2: string;
  let instB: string;
  const nombreInstA = `Fracc A ${corrida}`;
  let clienteAdminA: SupabaseClient;
  let clienteTecnicoA: SupabaseClient;
  let clienteAdminB: SupabaseClient;

  // Panel principal del flujo y su token de dispositivo.
  const p1 = nuevoPanel();
  let tokenP1 = "";

  async function panelEnBase(code: string) {
    const { data, error } = await admin.from("panels").select("*").eq("panel_code", code).single();
    if (error) throw error;
    return data;
  }

  async function registrarYGuardar(p: PanelPrueba) {
    panelesCreados.push(p.code);
    return registrar(p);
  }

  // Escrituras del servidor en las tablas replicadas (traen updated_by y origin).
  const AUTOR = { updated_by: "prueba", origin: "cloud" };

  async function crearSalidas(panelId: string, installationId: string) {
    const { error } = await admin.from("outputs").insert(
      [0, 1, 2, 3].map((i) => ({
        installation_id: installationId,
        panel_id: panelId,
        output_index: i,
        alias: `Salida ${i + 1}`,
        duration_ms: 3000,
        reader_mask: 1,
        enabled: true,
        ...AUTOR,
      })),
    );
    if (error) throw error;
  }

  async function crearRegla(panelId: string, installationId: string, permiso: number) {
    const { data: perfil, error } = await admin
      .from("access_profiles")
      .insert({ installation_id: installationId, name: `Perfil ${permiso}`, local_permission_id: permiso, ...AUTOR })
      .select("id")
      .single();
    if (error) throw error;
    const { error: errorRegla } = await admin
      .from("profile_panel_rules")
      .insert({
        installation_id: installationId,
        profile_id: perfil.id,
        panel_id: panelId,
        output_mask: 15,
        card_reader_mask: 15,
        pin_reader_mask: 0,
        allow_rf: true,
        weekday_mask: 127,
        start_minute: 0,
        end_minute: 0,
        ...AUTOR,
      });
    if (errorRegla) throw errorRegla;
  }

  /** Panel reclamado en `installationId` con 4 salidas y 1 regla; luego revocado y registrado con código nuevo. */
  async function panelRevocadoConDatos(installationId: string, permiso: number) {
    const p = nuevoPanel();
    expect((await registrarYGuardar(p)).status).toBe(201);
    const { id } = await claimPanelAs(clienteAdminA, installationId, p.code, p.claimCode);
    await crearSalidas(id, installationId);
    await crearRegla(id, installationId, permiso);
    await revokePanelAs(clienteAdminA, id);
    p.claimCode = base32(8);
    expect((await registrar(p)).status).toBe(200);
    return { p, id };
  }

  async function filasDelPanel(tabla: "outputs" | "profile_panel_rules", panelId: string, installationId: string) {
    const { data, error } = await admin
      .from(tabla)
      .select("deleted_at, updated_by, origin")
      .eq("panel_id", panelId)
      .eq("installation_id", installationId);
    if (error) throw error;
    return data;
  }

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();

    const [adminA, tecnicoA, adminB] = await Promise.all([
      createLocalUser(admin, correo("admin-a"), password),
      createLocalUser(admin, correo("tecnico-a"), password),
      createLocalUser(admin, correo("admin-b"), password),
    ]);
    usuarios.push(adminA, tecnicoA, adminB);

    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `Tenant A ${corrida}` }, { name: `Tenant B ${corrida}` }])
      .select("id, name")
      .order("name");
    if (e1) throw e1;
    [tenantA, tenantB] = ts.map((t) => t.id);
    tenants.push(tenantA, tenantB);

    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenantA, user_id: adminA, role: "admin" },
      { tenant_id: tenantA, user_id: tecnicoA, role: "tecnico" },
      { tenant_id: tenantB, user_id: adminB, role: "admin" },
    ]);
    if (e2) throw e2;

    const { data: is, error: e3 } = await admin
      .from("installations")
      .insert([
        { tenant_id: tenantA, name: nombreInstA },
        { tenant_id: tenantA, name: `Fracc A2 ${corrida}` },
        { tenant_id: tenantB, name: `Fracc B ${corrida}` },
      ])
      .select("id, name");
    if (e3) throw e3;
    const idDe = (nombre: string) => is.find((i) => i.name === nombre)!.id;
    instA = idDe(nombreInstA);
    instA2 = idDe(`Fracc A2 ${corrida}`);
    instB = idDe(`Fracc B ${corrida}`);

    [clienteAdminA, clienteTecnicoA, clienteAdminB] = await Promise.all([
      signInLocal(correo("admin-a"), password),
      signInLocal(correo("tecnico-a"), password),
      signInLocal(correo("admin-b"), password),
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    // Orden: salidas y reglas (referencian a los paneles), paneles (referencian a las
    // instalaciones), tenants (cascada a instalaciones, perfiles, miembros, auditoría e
    // intentos) y usuarios.
    if (panelesCreados.length) {
      const { data: paneles } = await admin.from("panels").select("id").in("panel_code", panelesCreados);
      const ids = (paneles ?? []).map((p) => p.id);
      await admin.from("outputs").delete().in("panel_id", ids);
      await admin.from("profile_panel_rules").delete().in("panel_id", ids);
      await admin.from("access_logs").delete().in("panel_id", ids);
      await admin.from("panels").delete().in("id", ids);
    }
    if (tenants.length) await admin.from("tenants").delete().in("id", tenants);
    await Promise.all(usuarios.map((id) => admin.auth.admin.deleteUser(id)));
  });

  describe("requireTenantRole", () => {
    it("'tecnico' acepta técnicos y administradores; 'admin' solo administradores", async () => {
      await expect(requireTenantRole(tenantA, "tecnico", clienteTecnicoA)).resolves.toMatchObject({
        tenantId: tenantA,
        role: "tecnico",
      });
      await expect(requireTenantRole(tenantA, "tecnico", clienteAdminA)).resolves.toMatchObject({
        role: "admin",
      });
      await expect(requireTenantRole(tenantA, "admin", clienteAdminA)).resolves.toMatchObject({
        role: "admin",
      });
      await expect(requireTenantRole(tenantA, "admin", clienteTecnicoA)).rejects.toMatchObject({
        status: 403,
        message: "No tienes permiso para esta acción.",
      });
    });

    it("un usuario de otro tenant o un id inválido responde 403", async () => {
      await expect(requireTenantRole(tenantA, "tecnico", clienteAdminB)).rejects.toMatchObject({
        status: 403,
      });
      await expect(requireTenantRole("no-es-uuid", "tecnico", clienteAdminA)).rejects.toMatchObject({
        status: 403,
      });
    });

    it("sin sesión responde 401", async () => {
      const sinSesion = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      await expect(requireTenantRole(tenantA, "tecnico", sinSesion)).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("POST /register", () => {
    it("un panel nuevo queda pending (201) con sus hashes y versiones", async () => {
      const res = await registrarYGuardar(p1);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ status: "pending" });

      const fila = await panelEnBase(p1.code);
      expect(fila).toMatchObject({
        status: "pending",
        installation_id: null,
        tenant_id: null,
        claim_code_hash: sha256(p1.claimCode),
        panel_secret_hash: sha256(p1.secret),
        device_token_hash: null,
        software_version: "1.2.3",
        schema_version: 6,
      });
    });

    it("repetido con el mismo secreto mientras está pending actualiza el código (200)", async () => {
      p1.claimCode = base32(8);
      const res = await registrar(p1, { software_version: "1.2.4" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "pending" });
      const fila = await panelEnBase(p1.code);
      expect(fila.claim_code_hash).toBe(sha256(p1.claimCode));
      expect(fila.software_version).toBe("1.2.4");
    });

    it("el mismo panel_code con otro panel_secret_hash responde 409 y no cambia nada", async () => {
      const intruso = { ...p1, claimCode: base32(8), secret: randomBytes(32).toString("hex") };
      const res = await registrar(intruso);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "panel_code_taken" });
      const fila = await panelEnBase(p1.code);
      expect(fila.claim_code_hash).toBe(sha256(p1.claimCode));
      expect(fila.panel_secret_hash).toBe(sha256(p1.secret));
    });

    it("un cuerpo inválido responde 400 en español", async () => {
      for (const cuerpo of [
        "{no es json",
        { panel_code: "PNL-1234", claim_code_hash: "x", panel_secret_hash: "y" },
        {
          panel_code: nuevoPanel().code,
          claim_code_hash: sha256("a").toUpperCase(),
          panel_secret_hash: sha256("b"),
          software_version: "1",
          schema_version: 6,
        },
      ]) {
        const res = await register(post("register", cuerpo));
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.code).toBe("invalid_body");
        expect(typeof json.message).toBe("string");
      }
    });
  });

  describe("POST /activate antes de reclamar", () => {
    it("sin reclamar responde 202 pending", async () => {
      const res = await activar(p1);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "pending" });
    });

    it("con un secreto incorrecto o un panel inexistente responde 401", async () => {
      const malSecreto = await activar(p1, randomBytes(32).toString("hex"));
      expect(malSecreto.status).toBe(401);
      expect(await malSecreto.json()).toMatchObject({ code: "unauthorized" });

      const inexistente = await activar(nuevoPanel());
      expect(inexistente.status).toBe(401);
      expect(await inexistente.json()).toMatchObject({ code: "unauthorized" });
    });
  });

  describe("claimPanel", () => {
    it("con un código erróneo falla con un error genérico", async () => {
      await expect(claimPanelAs(clienteAdminA, instA, p1.code, "ZZZZZZZZ")).rejects.toMatchObject({
        status: 400,
        message: ERROR_GENERICO,
      });
      // Un panel inexistente da exactamente el mismo error.
      await expect(
        claimPanelAs(clienteAdminA, instA, nuevoPanel().code, p1.claimCode),
      ).rejects.toMatchObject({ status: 400, message: ERROR_GENERICO });
      expect((await panelEnBase(p1.code)).status).toBe("pending");
    });

    it("un técnico no puede reclamar (403)", async () => {
      await expect(
        claimPanelAs(clienteTecnicoA, instA, p1.code, p1.claimCode),
      ).rejects.toMatchObject({ status: 403 });
      expect((await panelEnBase(p1.code)).status).toBe("pending");
    });

    it("un admin de otro tenant no ve la instalación (404)", async () => {
      await expect(
        claimPanelAs(clienteAdminB, instA, p1.code, p1.claimCode),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("una instalación inexistente responde 404", async () => {
      await expect(
        claimPanelAs(clienteAdminA, "29999999-0000-0000-0000-000000000000", p1.code, p1.claimCode),
      ).rejects.toMatchObject({ status: 404 });
      await expect(claimPanelAs(clienteAdminA, "no-es-uuid", p1.code, p1.claimCode)).rejects.toMatchObject({
        status: 404,
      });
    });

    it("con el código correcto (con espacios y minúsculas) deja el panel claimed", async () => {
      const panel = await claimPanelAs(
        clienteAdminA,
        instA,
        `  ${p1.code.toLowerCase()} `,
        ` ${p1.claimCode.toLowerCase()}  `,
      );
      expect(panel).toMatchObject({ panel_code: p1.code, status: "claimed", installation_id: instA });

      const fila = await panelEnBase(p1.code);
      expect(fila).toMatchObject({
        status: "claimed",
        installation_id: instA,
        tenant_id: tenantA,
        claim_code_hash: null,
      });

      // El miembro lo ve por RLS (solo columnas no secretas).
      const { data, error } = await clienteTecnicoA
        .from("panels")
        .select("id, status, installation_id")
        .eq("panel_code", p1.code);
      expect(error).toBeNull();
      expect(data).toEqual([{ id: fila.id, status: "claimed", installation_id: instA }]);
      // Un miembro de otro tenant no lo ve.
      const { data: ajeno } = await clienteAdminB.from("panels").select("id").eq("panel_code", p1.code);
      expect(ajeno).toEqual([]);
    });

    it("un panel ya reclamado no se puede volver a reclamar", async () => {
      await expect(
        claimPanelAs(clienteAdminA, instA, p1.code, p1.claimCode),
      ).rejects.toMatchObject({ status: 400, message: ERROR_GENERICO });
    });

    it("register con el mismo secreto en otro estado no cambia nada (200)", async () => {
      const res = await registrar({ ...p1, claimCode: base32(8) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "claimed" });
      const fila = await panelEnBase(p1.code);
      expect(fila).toMatchObject({ status: "claimed", installation_id: instA, claim_code_hash: null });
    });
  });

  describe("POST /activate y GET /link-state", () => {
    it("reclamado responde 200 con el token una sola vez y pasa a staging", async () => {
      const res = await activar(p1);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const json = await res.json();
      expect(json).toEqual({
        device_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        installation_id: instA,
        installation_name: nombreInstA,
      });
      tokenP1 = json.device_token;

      const fila = await panelEnBase(p1.code);
      expect(fila.status).toBe("staging");
      expect(fila.device_token_hash).toBe(sha256(tokenP1));
    });

    it("una segunda llamada responde 409", async () => {
      const res = await activar(p1);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "already_activated" });
      expect((await panelEnBase(p1.code)).device_token_hash).toBe(sha256(tokenP1));
    });

    it("un token válido en link-state responde staging y actualiza last_seen_at", async () => {
      const res = await estadoDeVinculo(`Device ${p1.code}.${tokenP1}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "staging" });
      const fila = await panelEnBase(p1.code);
      expect(fila.last_seen_at).not.toBeNull();
    });

    it("el token de otro panel responde 401", async () => {
      const p2 = nuevoPanel();
      expect((await registrarYGuardar(p2)).status).toBe(201);
      await claimPanelAs(clienteAdminA, instA, p2.code, p2.claimCode);
      const { device_token: tokenP2 } = await (await activar(p2)).json();

      const cruzado = await estadoDeVinculo(`Device ${p1.code}.${tokenP2}`);
      expect(cruzado.status).toBe(401);
      expect(await cruzado.json()).toMatchObject({ code: "unauthorized" });
      // Con su propio código sí entra.
      expect((await estadoDeVinculo(`Device ${p2.code}.${tokenP2}`)).status).toBe(200);
    });

    it("sin credencial o con una credencial mal formada responde 401", async () => {
      for (const authorization of [
        undefined,
        "",
        `Bearer ${tokenP1}`,
        `Device ${p1.code}`,
        `Device ${p1.code}.`,
        `Device ${p1.code}.${tokenP1}x`,
        `device ${p1.code}.${tokenP1}`,
      ]) {
        const res = await estadoDeVinculo(authorization);
        expect(res.status, String(authorization)).toBe(401);
        expect(await res.json()).toEqual({ code: "unauthorized", message: expect.any(String) });
      }
    });
  });

  describe("límite de intentos de claimPanel", () => {
    it("el intento 11 en una hora responde 429, aunque el código sea correcto", async () => {
      const p = nuevoPanel();
      expect((await registrarYGuardar(p)).status).toBe(201);

      for (let i = 0; i < 10; i++) {
        await expect(claimPanelAs(clienteAdminB, instB, p.code, "00000000")).rejects.toMatchObject({
          status: 400,
        });
      }
      await expect(claimPanelAs(clienteAdminB, instB, p.code, p.claimCode)).rejects.toMatchObject({
        status: 429,
        message: "Demasiados intentos; espera una hora.",
      });
      expect((await panelEnBase(p.code)).status).toBe("pending");

      // El límite es por tenant: el tenant A sigue pudiendo reclamar.
      const otro = nuevoPanel();
      expect((await registrarYGuardar(otro)).status).toBe(201);
      await expect(claimPanelAs(clienteAdminA, instA, otro.code, otro.claimCode)).resolves.toMatchObject({
        status: "claimed",
      });
    });
  });

  describe("revokePanel", () => {
    it("un técnico no puede revocar (403)", async () => {
      const { id } = await panelEnBase(p1.code);
      await expect(revokePanelAs(clienteTecnicoA, id)).rejects.toMatchObject({ status: 403 });
      expect((await panelEnBase(p1.code)).status).toBe("staging");
    });

    it("un admin de otro tenant no puede revocar (404)", async () => {
      const { id } = await panelEnBase(p1.code);
      await expect(revokePanelAs(clienteAdminB, id)).rejects.toMatchObject({ status: 404 });
    });

    it("revocar borra el snapshot de importación guardado (nombres y PIN cifrados)", async () => {
      const p = nuevoPanel();
      expect((await registrarYGuardar(p)).status).toBe(201);
      const { id } = await claimPanelAs(clienteAdminA, instA, p.code, p.claimCode);
      const { error } = await admin
        .from("panel_imports")
        .insert({ panel_id: id, snapshot: { holders: [] }, diff: { conflicts: [] } });
      expect(error).toBeNull();

      await revokePanelAs(clienteAdminA, id);

      const { data, error: errorLeer } = await admin.from("panel_imports").select("panel_id").eq("panel_id", id);
      expect(errorLeer).toBeNull();
      expect(data).toEqual([]);
    });

    it("después de revocar el token da 401, /activate da 410 y un register nuevo lo deja reclamable", async () => {
      const { id } = await panelEnBase(p1.code);
      await revokePanelAs(clienteAdminA, id);

      const fila = await panelEnBase(p1.code);
      expect(fila).toMatchObject({ status: "revoked", device_token_hash: null, installation_id: instA });

      const res = await estadoDeVinculo(`Device ${p1.code}.${tokenP1}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "unauthorized" });

      const revocado = await activar(p1);
      expect(revocado.status).toBe(410);
      expect(await revocado.json()).toMatchObject({ code: "revoked" });

      // El panel genera un código de vinculación nuevo y se registra con el mismo secreto.
      const codigoViejo = p1.claimCode;
      p1.claimCode = base32(8);
      const reg = await registrar(p1);
      expect(reg.status).toBe(200);
      expect(await reg.json()).toEqual({ status: "pending" });
      expect(await panelEnBase(p1.code)).toMatchObject({
        status: "pending",
        installation_id: null,
        tenant_id: null,
        claim_code_hash: sha256(p1.claimCode),
        device_token_hash: null,
        synced_revision: 0,
      });

      // El código viejo ya no sirve; el nuevo sí.
      await expect(claimPanelAs(clienteAdminA, instA, p1.code, codigoViejo)).rejects.toMatchObject({
        status: 400,
      });
      await expect(claimPanelAs(clienteAdminA, instA, p1.code, p1.claimCode)).resolves.toMatchObject({
        status: "claimed",
        installation_id: instA,
      });
      expect((await activar(p1)).status).toBe(200);
    });
  });

  describe("reclamar un panel que tuvo datos en otra instalación", () => {
    it("borra lógicamente sus salidas y reglas viejas y permite crear las 4 salidas en la nueva", async () => {
      const { p, id } = await panelRevocadoConDatos(instA, 10);

      await expect(claimPanelAs(clienteAdminA, instA2, p.code, p.claimCode)).resolves.toMatchObject({
        status: "claimed",
        installation_id: instA2,
      });

      // Ya las borró la revocación; el reclamo no las vuelve a tocar.
      const borrado = { deleted_at: expect.any(String), updated_by: "system:revocacion", origin: "cloud" };
      const viejas = await filasDelPanel("outputs", id, instA);
      expect(viejas).toHaveLength(4);
      for (const salida of viejas) expect(salida).toMatchObject(borrado);
      const reglas = await filasDelPanel("profile_panel_rules", id, instA);
      expect(reglas).toEqual([borrado]);

      // Sin choque con el índice único de salidas vivas por panel.
      await expect(crearSalidas(id, instA2)).resolves.toBeUndefined();
      const nuevas = await filasDelPanel("outputs", id, instA2);
      expect(nuevas.filter((s) => s.deleted_at === null)).toHaveLength(4);
    });

    it("volver a la misma instalación no revive sus salidas y reglas: se crean nuevas", async () => {
      const { p, id } = await panelRevocadoConDatos(instA, 11);

      await claimPanelAs(clienteAdminA, instA, p.code, p.claimCode);

      const borrado = { deleted_at: expect.any(String), updated_by: "system:revocacion", origin: "cloud" };
      const viejas = await filasDelPanel("outputs", id, instA);
      expect(viejas).toHaveLength(4);
      for (const salida of viejas) expect(salida).toMatchObject(borrado);
      expect(await filasDelPanel("profile_panel_rules", id, instA)).toEqual([borrado]);

      await expect(crearSalidas(id, instA)).resolves.toBeUndefined();
      const todas = await filasDelPanel("outputs", id, instA);
      expect(todas.filter((s) => s.deleted_at === null)).toHaveLength(4);
    });
  });

  describe("revocar limpia la API pública", () => {
    it("GET outputs y panels ya no lo traen; sus logs siguen en GET logs", async () => {
      const p = nuevoPanel();
      expect((await registrarYGuardar(p)).status).toBe(201);
      const { id } = await claimPanelAs(clienteAdminA, instA, p.code, p.claimCode);
      await crearSalidas(id, instA);
      const { error: errorLog } = await admin.from("access_logs").insert({
        tenant_id: tenantA,
        installation_id: instA,
        panel_id: id,
        local_log_id: 1,
        ts: new Date(Date.now() - 60_000).toISOString(),
        allowed: true,
        source: 0,
        reason: 0,
      });
      expect(errorLog).toBeNull();

      const secret = `acc_${randomBytes(32).toString("base64url")}`;
      const { error: errorLlave } = await admin
        .from("api_keys")
        .insert({ tenant_id: tenantA, name: "Revocar", prefix: secret.slice(0, 12), key_hash: sha256(secret) });
      expect(errorLlave).toBeNull();
      type Ruta = (req: Request, ctx: { params: Promise<{ installationId: string }> }) => Promise<Response>;
      const pedir = async (ruta: Ruta, path: string) => {
        const res = await ruta(
          new Request(`http://localhost/api/v1/installations/${instA}/${path}`, {
            headers: { authorization: `Bearer ${secret}` },
          }),
          { params: Promise.resolve({ installationId: instA }) },
        );
        expect(res.status).toBe(200);
        return (await res.json()).data as { id: string; panel_id?: string }[];
      };

      expect((await pedir(listSalidas, "outputs")).filter((o) => o.panel_id === id)).toHaveLength(4);
      expect((await pedir(listPaneles, "panels")).map((x) => x.id)).toContain(id);

      await revokePanelAs(clienteAdminA, id);

      expect((await pedir(listSalidas, "outputs")).filter((o) => o.panel_id === id)).toEqual([]);
      expect((await pedir(listPaneles, "panels")).map((x) => x.id)).not.toContain(id);
      const logs = (await pedir(listLogs, `logs?panel=${id}`)) as unknown as { panel_code: string }[];
      expect(logs).toHaveLength(1);
      expect(logs[0].panel_code).toBe(p.code);
    });
  });
});
