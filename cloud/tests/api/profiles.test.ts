import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listarPerfiles, POST as crearPerfil } from "@/app/api/v1/installations/[installationId]/profiles/route";
import {
  DELETE as borrarPerfil,
  PATCH as renombrarPerfil,
} from "@/app/api/v1/installations/[installationId]/profiles/[profileId]/route";
import { PUT as guardarReglas } from "@/app/api/v1/installations/[installationId]/profiles/[profileId]/rules/route";
import { PUT as asignarTitulares } from "@/app/api/v1/installations/[installationId]/profiles/[profileId]/holders/route";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Perfiles de acceso de la API pública contra el Supabase LOCAL.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ctx = { params: Promise<{ installationId: string; profileId?: string }> };
type Metodo = (req: Request, ctx: Ctx) => Promise<Response>;

const regla = (extra: Record<string, unknown> = {}) => ({
  output_mask: 3,
  card_reader_mask: 1,
  pin_reader_mask: 0,
  allow_rf: true,
  weekday_mask: 127,
  start_minute: 0,
  end_minute: 1439,
  ...extra,
});

describe("API pública: perfiles", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const paneles: string[] = [];
  let instA: string;
  let instB: string;
  let secretA: string;
  let holderA: string;
  let holderA2: string;
  let holderB: string;
  let panel1: string;
  let panel2: string;
  let panelB: string;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `PF ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }
  async function instalacion(tenantId: string, name: string): Promise<string> {
    const { data, error } = await admin.from("installations").insert({ tenant_id: tenantId, name }).select("id").single();
    if (error) throw error;
    return data.id;
  }
  async function titular(inst: string, name: string): Promise<string> {
    const { data, error } = await admin
      .from("holders")
      .insert({ installation_id: inst, kind: "persona", name, updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
  async function panel(inst: string): Promise<string> {
    const hex = randomBytes(4).toString("hex").toUpperCase().replace(/[ILOU]/g, "0");
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: `PNL-${hex.slice(0, 4).replace(/[^0-9A-HJKMNP-TV-Z]/g, "0")}-${hex.slice(4).replace(/[^0-9A-HJKMNP-TV-Z]/g, "0")}`,
        panel_secret_hash: "a".repeat(64),
        installation_id: inst,
        status: "claimed",
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    return data.id;
  }

  const pedir = (
    metodo: Metodo,
    opciones: { inst?: string; id?: string; body?: unknown; secret?: string | null } = {},
  ) => {
    const { inst = instA, id = "", body, secret = secretA } = opciones;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret) headers.authorization = `Bearer ${secret}`;
    return metodo(
      new Request(`http://localhost/api/v1/installations/${inst}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ installationId: inst, profileId: id }) },
    );
  };
  const llamar = async (metodo: Metodo, opciones: Parameters<typeof pedir>[1] = {}) => {
    const res = await pedir(metodo, opciones);
    return { res, json: await res.json() };
  };
  const revision = async () => (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;
  const nuevoPerfil = async (name: string) => {
    const { res, json } = await llamar(crearPerfil as Metodo, { body: { name } });
    expect(res.status).toBe(201);
    return json.data.id as string;
  };

  beforeAll(async () => {
    requireLocalSupabase();
    const tenantA = await tenant("A");
    const tenantB = await tenant("B");
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    secretA = `acc_${randomBytes(32).toString("base64url")}`;
    const { error } = await admin
      .from("api_keys")
      .insert({ tenant_id: tenantA, name: "PF", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) });
    if (error) throw error;
    holderA = await titular(instA, "Ana");
    holderA2 = await titular(instA, "Beto");
    holderB = await titular(instB, "Ajeno");
    panel1 = await panel(instA);
    panel2 = await panel(instA);
    panelB = await panel(instB);
  });

  afterAll(async () => {
    await admin.from("panels").delete().in("id", paneles);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("exige llave", async () => {
    expect((await pedir(listarPerfiles as Metodo, { secret: null })).status).toBe(401);
  });

  it("crea, renombra, guarda reglas de dos paneles, asigna titulares y lista", async () => {
    const rev = await revision();
    const { res, json } = await llamar(crearPerfil as Metodo, { body: { name: "  Residentes  " } });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ name: "Residentes", holder_ids: [], rules: [] });
    expect(json.revision).toBeGreaterThan(rev);
    const id = json.data.id as string;

    const vacio = await llamar(renombrarPerfil as Metodo, { id, body: {} });
    expect(vacio.res.status).toBe(400);
    expect(vacio.json.message).toBe("No hay cambios.");
    const extra = await llamar(renombrarPerfil as Metodo, { id, body: { name: "X", otro: 1 } });
    expect(extra.res.status).toBe(400);
    const ren = await llamar(renombrarPerfil as Metodo, { id, body: { name: "Vecinos" } });
    expect(ren.res.status).toBe(200);
    expect(ren.json.data.name).toBe("Vecinos");

    const reglas = await llamar(guardarReglas as Metodo, {
      id,
      body: [
        { panel_id: panel1, rule: regla() },
        { panel_id: panel2, rule: regla({ output_mask: 8 }) },
      ],
    });
    expect(reglas.res.status).toBe(200);
    expect(reglas.json.data.rules).toHaveLength(2);
    // Regla nueva sin `allow_remote` en el cuerpo (cliente de 2A): queda en false.
    expect(reglas.json.data.rules.every((r: { allow_remote: boolean }) => r.allow_remote === false)).toBe(true);

    const remota = await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla({ allow_remote: true }) }] });
    expect(remota.res.status).toBe(200);
    expect(remota.json.data.rules.find((r: { panel_id: string }) => r.panel_id === panel1).allow_remote).toBe(true);
    // Reenviar sin el campo conserva el valor guardado (true).
    const sinCampo = await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla({ output_mask: 5 }) }] });
    const conservada = sinCampo.json.data.rules.find((r: { panel_id: string }) => r.panel_id === panel1);
    expect(conservada).toMatchObject({ allow_remote: true, output_mask: 5 });
    // Enviarlo explícito en false sí lo apaga.
    const apagada = await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla({ allow_remote: false }) }] });
    expect(apagada.json.data.rules.find((r: { panel_id: string }) => r.panel_id === panel1).allow_remote).toBe(false);
    expect(
      (await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla({ allow_remote: "si" }) }] })).res.status,
    ).toBe(400);
    expect(reglas.json.revision).toBeGreaterThan(json.revision);

    const quitar = await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel2, rule: null }] });
    expect(quitar.json.data.rules.map((r: { panel_id: string }) => r.panel_id)).toEqual([panel1]);

    const asig = await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: [holderA, holderA2] } });
    expect(asig.res.status).toBe(200);
    expect([...asig.json.data.holder_ids].sort()).toEqual([holderA, holderA2].sort());

    const lista = await (await pedir(listarPerfiles as Metodo)).json();
    const fila = lista.data.find((p: { id: string }) => p.id === id);
    expect(fila.rules).toHaveLength(1);
    expect(fila.holder_ids).toHaveLength(2);
  });

  it("perfil inexistente o ajeno da 404 'El perfil no existe.'", async () => {
    const { data: ajeno } = await admin
      .from("access_profiles")
      .insert({ installation_id: instB, name: "Ajeno", local_permission_id: 0, updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    for (const id of [randomUUID(), "no-uuid", ajeno!.id as string]) {
      for (const [metodo, body] of [
        [renombrarPerfil, { name: "Z" }],
        [guardarReglas, []],
        [asignarTitulares, { holder_ids: [] }],
        [borrarPerfil, undefined],
      ] as [Metodo, unknown][]) {
        const { res, json } = await llamar(metodo, { id, body });
        expect(res.status).toBe(404);
        expect(json.message).toBe("El perfil no existe.");
      }
    }
    const intacto = await admin.from("access_profiles").select("name, deleted_at").eq("id", ajeno!.id).single();
    expect(intacto.data).toEqual({ name: "Ajeno", deleted_at: null });
  });

  it("una regla con panel_id de otro tenant da 400 y no cambia nada", async () => {
    const id = await nuevoPerfil("ReglaAjena");
    const { res } = await llamar(guardarReglas as Metodo, {
      id,
      body: [
        { panel_id: panel1, rule: regla() },
        { panel_id: panelB, rule: regla() },
      ],
    });
    expect(res.status).toBe(400);
    const { data } = await admin.from("profile_panel_rules").select("id").eq("profile_id", id).is("deleted_at", null);
    expect(data).toEqual([]);
  });

  it("regla inválida o cuerpo que no es lista da 400", async () => {
    const id = await nuevoPerfil("ReglaMala");
    expect((await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla({ output_mask: 99 }) }] })).res.status).toBe(400);
    expect((await llamar(guardarReglas as Metodo, { id, body: { panel_id: panel1 } })).res.status).toBe(400);
    expect((await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla(), x: 1 }] })).res.status).toBe(400);
  });

  it("un holder_id de otro tenant o inexistente da 400 'El titular no existe.' sin cambios", async () => {
    const id = await nuevoPerfil("TitularAjeno");
    await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: [holderA] } });
    for (const malo of [holderB, randomUUID()]) {
      const { res, json } = await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: [holderA2, malo] } });
      expect(res.status).toBe(400);
      expect(json.message).toBe("El titular no existe.");
    }
    const { data } = await admin.from("holder_profiles").select("holder_id").eq("profile_id", id).is("deleted_at", null);
    expect(data).toEqual([{ holder_id: holderA }]);
    const extra = await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: [], x: 1 } });
    expect(extra.res.status).toBe(400);
    const noLista = await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: "x" } });
    expect(noLista.res.status).toBe(400);
  });

  it("borrar un perfil le quita la asignación a sus titulares", async () => {
    const id = await nuevoPerfil("Borrable");
    await llamar(asignarTitulares as Metodo, { id, body: { holder_ids: [holderA] } });
    await llamar(guardarReglas as Metodo, { id, body: [{ panel_id: panel1, rule: regla() }] });
    const rev = await revision();
    const { res, json } = await llamar(borrarPerfil as Metodo, { id });
    expect(res.status).toBe(200);
    expect(json.data).toEqual({ id });
    expect(json.revision).toBeGreaterThan(rev);
    const { data } = await admin.from("holder_profiles").select("id").eq("profile_id", id).is("deleted_at", null);
    expect(data).toEqual([]);
    const lista = await (await pedir(listarPerfiles as Metodo)).json();
    expect(lista.data.map((p: { id: string }) => p.id)).not.toContain(id);
    expect((await llamar(borrarPerfil as Metodo, { id })).res.status).toBe(404);
  });
});
