import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listInstalaciones } from "@/app/api/v1/installations/route";
import { GET as getInstalacion } from "@/app/api/v1/installations/[installationId]/route";
import { GET as listPaneles } from "@/app/api/v1/installations/[installationId]/panels/route";
import { GET as getSync } from "@/app/api/v1/installations/[installationId]/sync-status/route";
import { GET as listSalidas } from "@/app/api/v1/installations/[installationId]/outputs/route";
import { GET as listLogs } from "@/app/api/v1/installations/[installationId]/logs/route";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Rutas de lectura de la API pública contra el Supabase LOCAL: cada llave solo ve su tenant.

const AUTOR = { updated_by: "prueba", origin: "cloud" };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ruta = (req: Request, ctx: { params: Promise<{ installationId: string }> }) => Promise<Response>;

describe("rutas de lectura de la API pública", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const paneles: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instA2: string;
  let instB: string;
  let panelAtrasado: string;
  let panelAlDia: string;
  let panelB: string;
  let secretA: string;
  let revisionA: number;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `Lectura ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }
  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }
  let contador = 0;
  async function panel(installationId: string, status: string): Promise<string> {
    const hex = (++contador * 7919 + Number.parseInt(sufijo, 16)).toString(32).toUpperCase().replace(/[ILOU]/g, "X").padStart(8, "0");
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: `PNL-${hex.slice(0, 4)}-${hex.slice(4, 8)}`,
        panel_secret_hash: "a".repeat(64),
        installation_id: installationId,
        status,
        device_token_hash: status === "revoked" ? null : "b".repeat(64),
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    return data.id;
  }
  async function llave(tenantId: string): Promise<string> {
    const secret = `acc_${randomBytes(32).toString("base64url")}`;
    const { error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantId, name: "Lectura", prefix: secret.slice(0, 12), key_hash: sha256(secret) });
    if (error) throw error;
    return secret;
  }

  const pedir = (ruta: Ruta, path: string, id = "", secret: string | null = secretA) =>
    ruta(
      new Request(`http://localhost/api/v1/${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }),
      { params: Promise.resolve({ installationId: id }) },
    );

  beforeAll(async () => {
    requireLocalSupabase();
    tenantA = await tenant("A");
    tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instA2 = await instalacion(tenantA, "Torre A2");
    instB = await instalacion(tenantB, "Torre B");
    panelAtrasado = await panel(instA, "active");
    panelAlDia = await panel(instA, "active");
    await panel(instA, "revoked");
    panelB = await panel(instB, "active");
    const salidas = (panelId: string, installationId: string, alias: string) => ({
      installation_id: installationId,
      panel_id: panelId,
      output_index: 0,
      alias,
      duration_ms: 3000,
      reader_mask: 1,
      enabled: true,
      ...AUTOR,
    });
    for (const fila of [
      salidas(panelAtrasado, instA, "Pluma A"),
      { ...salidas(panelAtrasado, instA, "Borrada"), output_index: 1, deleted_at: "2026-01-01T00:00:00Z" },
      salidas(panelB, instB, "Pluma B"),
    ]) {
      const { error } = await admin.from("outputs").insert(fila);
      if (error) throw error;
    }
    const { data } = await admin.from("installations").select("revision").eq("id", instA).single();
    revisionA = data!.revision;
    expect(revisionA).toBeGreaterThan(0);
    await admin.from("panels").update({ synced_revision: revisionA }).eq("id", panelAlDia);
    await admin.from("panels").update({ synced_revision: revisionA - 1 }).eq("id", panelAtrasado);

    // 55 logs de origen 5 y 3 de origen 0 en A; uno de B.
    const fila = (tenantId: string, inst: string, panelId: string, n: number, source: number) => ({
      tenant_id: tenantId,
      installation_id: inst,
      panel_id: panelId,
      local_log_id: n,
      ts: new Date(Date.UTC(2026, 2, 10, 12, 0, n)).toISOString(),
      allowed: true,
      source,
      reason: 0,
    });
    const filas = [
      ...Array.from({ length: 55 }, (_, i) => fila(tenantA, instA, panelAtrasado, i + 1, 5)),
      ...Array.from({ length: 3 }, (_, i) => fila(tenantA, instA, panelAlDia, i + 1, 0)),
      fila(tenantA, instA, panelAlDia, 4, 4),
      fila(tenantB, instB, panelB, 1, 5),
    ];
    const { error } = await admin.from("access_logs").insert(filas);
    if (error) throw error;
    secretA = await llave(tenantA);
  });

  afterAll(async () => {
    await admin.from("outputs").delete().in("panel_id", paneles);
    await admin.from("panels").delete().in("id", paneles);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("exige llave", async () => {
    const res = await pedir(listInstalaciones as Ruta, "installations", "", null);
    expect(res.status).toBe(401);
  });

  it("lista solo las instalaciones del tenant de la llave", async () => {
    const res = await pedir(listInstalaciones as Ruta, "installations");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((i: { id: string }) => i.id).sort()).toEqual([instA, instA2].sort());
    expect(data.find((i: { id: string }) => i.id === instA)).toEqual({ id: instA, name: "Torre A", revision: revisionA });
  });

  it("una instalación propia se lee y la de otro tenant da 404", async () => {
    const ok = await pedir(getInstalacion, "installations/x", instA);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { id: instA, name: "Torre A", revision: revisionA } });
    const otro = await pedir(getInstalacion, "installations/x", instB);
    expect(otro.status).toBe(404);
    expect(await otro.json()).toEqual({ code: "not_found", message: "La instalación no existe." });
    expect((await pedir(getInstalacion, "installations/x", "no-es-uuid")).status).toBe(404);
  });

  it("paneles: solo los de la instalación, sin secretos", async () => {
    const res = await pedir(listPaneles, "p", instA);
    const { data } = await res.json();
    expect(data).toHaveLength(3);
    expect(data.map((p: { id: string }) => p.id)).not.toContain(panelB);
    expect(Object.keys(data[0]).sort()).toEqual(
      ["id", "last_sync_at", "online", "panel_code", "software_version", "status", "synced_revision"].sort(),
    );
    expect((await pedir(listPaneles, "p", instB)).status).toBe(404);
  });

  it("sync-status marca applied según la revisión y omite paneles no vinculados", async () => {
    const res = await pedir(getSync, "s", instA);
    const { data } = await res.json();
    expect(data.revision).toBe(revisionA);
    expect(data.panels).toHaveLength(2);
    const por = Object.fromEntries(data.panels.map((p: { id: string; applied: boolean }) => [p.id, p]));
    expect(por[panelAtrasado]).toMatchObject({ synced_revision: revisionA - 1, applied: false });
    expect(por[panelAlDia]).toMatchObject({ synced_revision: revisionA, applied: true });
    expect(Object.keys(por[panelAlDia]).sort()).toEqual(["applied", "id", "online", "panel_code", "synced_revision"]);
    expect((await pedir(getSync, "s", instB)).status).toBe(404);
  });

  it("salidas: solo las vivas de la instalación", async () => {
    const { data } = await (await pedir(listSalidas, "o", instA)).json();
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      id: expect.any(String),
      panel_id: panelAtrasado,
      output_index: 0,
      alias: "Pluma A",
      duration_ms: 3000,
      reader_mask: 1,
      enabled: true,
    });
    expect((await pedir(listSalidas, "o", instB)).status).toBe(404);
  });

  it("logs: filtra por origen, pagina de 50 y no mezcla tenants", async () => {
    const p1 = await (await pedir(listLogs, "l?origen=5", instA)).json();
    expect(p1).toMatchObject({ page: 1, page_size: 50, total: 55 });
    expect(p1.data).toHaveLength(50);
    expect(p1.data.every((l: { source: number }) => l.source === 5)).toBe(true);
    const p2 = await (await pedir(listLogs, "l?origen=5&pagina=2", instA)).json();
    expect(p2).toMatchObject({ page: 2, page_size: 50, total: 55 });
    expect(p2.data).toHaveLength(5);
    const todos = await (await pedir(listLogs, "l", instA)).json();
    expect(todos.total).toBe(59);
    expect((await pedir(listLogs, "l", instB)).status).toBe(404);
  });

  it("logs: un filtro inválido o desconocido responde 400 nombrando el campo", async () => {
    for (const [consulta, campo] of [
      ["desde=2026-02-30", "desde"],
      ["hasta=foo", "hasta"],
      ["panel=x", "panel"],
      ["titular=x", "titular"],
      ["resultado=otro", "resultado"],
      ["origen=6", "origen"],
      ["pagina=0", "pagina"],
      ["pagina=abc", "pagina"],
      ["rareza=1", "rareza"],
    ]) {
      const res = await pedir(listLogs, `l?${consulta}`, instA);
      expect(res.status, consulta).toBe(400);
      const cuerpo = await res.json();
      expect(cuerpo.code, consulta).toBe("bad_request");
      expect(cuerpo.message, consulta).toContain(campo);
    }
  });

  it("logs: acepta origen=4 (Remota)", async () => {
    const res = await pedir(listLogs, "l?origen=4", instA);
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.total).toBe(1);
    expect(cuerpo.data).toHaveLength(1);
    expect(cuerpo.data[0]).toMatchObject({ source: 4, panel_id: panelAlDia });
  });

  it("logs: filtrar por el panel de otro tenant no trae filas", async () => {
    const res = await (await pedir(listLogs, `l?panel=${panelB}`, instA)).json();
    expect(res.total).toBe(0);
    expect(res.data).toHaveLength(0);
  });
});
