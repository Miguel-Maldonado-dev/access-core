import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listarTarjetas, POST as crearTarjeta } from "@/app/api/v1/installations/[installationId]/cards/route";
import {
  DELETE as borrarTarjeta,
  PATCH as editarTarjeta,
} from "@/app/api/v1/installations/[installationId]/cards/[cardId]/route";
import { GET as listarControles, POST as crearControl } from "@/app/api/v1/installations/[installationId]/controls/route";
import {
  DELETE as borrarControl,
  GET as leerControl,
  PUT as reemplazarControl,
} from "@/app/api/v1/installations/[installationId]/controls/[controlId]/route";
import { traducir } from "@/lib/controls";
import { localAdmin, requireLocalSupabase } from "../helpers/supabase-local";

// Tarjetas y controles con salida por panel de la API pública contra el Supabase LOCAL.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ctx = { params: Promise<{ installationId: string; cardId?: string; controlId?: string }> };
type Metodo = (req: Request, ctx: Ctx) => Promise<Response>;

describe("API pública: tarjetas y controles", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const tenants: string[] = [];
  const paneles: string[] = [];
  let instA: string;
  let instB: string;
  let secretA: string;
  let holderA: string;
  let holderB: string;
  let panel1: string;
  let panel2: string;
  let panelB: string;
  let controlB: string;
  let botonB: string;
  let cardB: string;
  let siguienteRf = 1_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const rf = () => ++siguienteRf;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `TC ${nombre} ${sufijo}` }).select("id").single();
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
      { params: Promise.resolve({ installationId: inst, cardId: id, controlId: id }) },
    );
  };
  const llamar = async (metodo: Metodo, opciones: Parameters<typeof pedir>[1] = {}) => {
    const res = await pedir(metodo, opciones);
    return { res, json: await res.json() };
  };
  const revision = async () => (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;
  const vinculos = async (controlId: string) => {
    const { data: botones } = await admin.from("control_buttons").select("id").eq("control_id", controlId).is("deleted_at", null);
    const { data } = await admin
      .from("control_button_panels")
      .select("panel_id, output_index")
      .in("button_id", (botones ?? []).map((b) => b.id))
      .is("deleted_at", null);
    return data ?? [];
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
      .insert({ tenant_id: tenantA, name: "TC", prefix: secretA.slice(0, 12), key_hash: sha256(secretA) });
    if (error) throw error;
    holderA = await titular(instA, "Ana");
    holderB = await titular(instB, "Ajeno");
    panel1 = await panel(instA);
    panel2 = await panel(instA);
    panelB = await panel(instB);
    const { data: cb, error: errorCb } = await admin
      .from("controls")
      .insert({ installation_id: instB, holder_id: holderB, description: "", updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    if (errorCb) throw errorCb;
    controlB = cb.id;
    const { data: bb, error: errorBb } = await admin
      .from("control_buttons")
      .insert({ installation_id: instB, control_id: controlB, button: 0, rf_code: rf(), updated_by: "prueba", origin: "cloud" })
      .select("id, rf_code")
      .single();
    if (errorBb) throw errorBb;
    botonB = bb.id;
    const { data: tb, error: errorTb } = await admin
      .from("cards")
      .insert({ installation_id: instB, holder_id: holderB, card_code: 777, description: "", updated_by: "prueba", origin: "cloud" })
      .select("id")
      .single();
    if (errorTb) throw errorTb;
    cardB = tb.id;
  });

  afterAll(async () => {
    await admin.from("control_button_panels").delete().in("panel_id", paneles);
    await admin.from("panels").delete().in("id", paneles);
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
  });

  it("exige llave", async () => {
    expect((await pedir(listarTarjetas as Metodo, { secret: null })).status).toBe(401);
    expect((await pedir(listarControles as Metodo, { secret: null })).status).toBe(401);
  });

  it("tarjetas: CRUD, 201, revisión y código repetido da 409", async () => {
    const codigo = rf();
    const rev = await revision();
    const { res, json } = await llamar(crearTarjeta as Metodo, {
      body: { card_code: codigo, holder_id: holderA, description: "  Llavero  " },
    });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ card_code: codigo, holder_id: holderA, holder_name: "Ana", description: "Llavero" });
    expect(json.revision).toBeGreaterThan(rev);
    const id = json.data.id as string;

    const lista = await (await pedir(listarTarjetas as Metodo)).json();
    expect(lista.data.map((c: { id: string }) => c.id)).toContain(id);

    const dup = await llamar(crearTarjeta as Metodo, { body: { card_code: codigo, holder_id: holderA } });
    expect(dup.res.status).toBe(409);

    const vacio = await llamar(editarTarjeta as Metodo, { id, body: {} });
    expect(vacio.res.status).toBe(400);
    expect(vacio.json.message).toBe("No hay cambios.");
    const extra = await llamar(editarTarjeta as Metodo, { id, body: { card_code: 5 } });
    expect(extra.res.status).toBe(400);

    const edit = await llamar(editarTarjeta as Metodo, { id, body: { description: "Nueva" } });
    expect(edit.res.status).toBe(200);
    expect(edit.json.data).toMatchObject({ id, card_code: codigo, holder_id: holderA, description: "Nueva" });

    const del = await llamar(borrarTarjeta as Metodo, { id });
    expect(del.json.data).toEqual({ id });
    expect((await llamar(borrarTarjeta as Metodo, { id })).res.status).toBe(404);
  });

  it("tarjetas: aislamiento entre tenants", async () => {
    const ajena = await llamar(crearTarjeta as Metodo, { body: { card_code: rf(), holder_id: holderB } });
    expect(ajena.res.status).toBe(400);
    const enB = await llamar(crearTarjeta as Metodo, { inst: instB, body: { card_code: rf(), holder_id: holderB } });
    expect(enB.res.status).toBe(404);
    const edit = await llamar(editarTarjeta as Metodo, { id: cardB, body: { description: "x" } });
    expect(edit.res.status).toBe(404);
    expect(edit.json.message).toBe("La tarjeta no existe.");
    expect((await llamar(borrarTarjeta as Metodo, { id: cardB })).res.status).toBe(404);
    const { data } = await admin.from("cards").select("deleted_at, description").eq("id", cardB).single();
    expect(data).toEqual({ deleted_at: null, description: "" });
  });

  it("controles: un botón al Panel 1 en S1 y Ninguna en el Panel 2 crea un solo vínculo", async () => {
    const codigo = rf();
    const rev = await revision();
    const { res, json } = await llamar(crearControl as Metodo, {
      body: {
        holder_id: holderA,
        description: "Portón",
        buttons: [{ button: 0, rf_code: codigo, outputs: { [panel1]: 0, [panel2]: null } }],
      },
    });
    expect(res.status).toBe(201);
    expect(json.revision).toBeGreaterThan(rev);
    expect(json.data).toMatchObject({ holder_id: holderA, holder_name: "Ana", description: "Portón" });
    expect(json.data.buttons).toHaveLength(1);
    expect(json.data.buttons[0]).toMatchObject({ button: 0, rf_code: codigo, outputs: { [panel1]: 0 } });
    expect(Object.keys(json.data.buttons[0].outputs)).toEqual([panel1]);
    expect(await vinculos(json.data.id)).toEqual([{ panel_id: panel1, output_index: 0 }]);

    const leido = await llamar(leerControl as Metodo, { id: json.data.id });
    expect(leido.json.data).toEqual(json.data);
    const lista = await (await pedir(listarControles as Metodo)).json();
    expect(lista.data.map((c: { id: string }) => c.id)).toContain(json.data.id);
  });

  it("controles: PUT cambia la salida por panel y DELETE borra", async () => {
    const { json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, buttons: [{ button: 1, rf_code: rf(), outputs: { [panel1]: 1 } }] },
    });
    const id = json.data.id as string;
    const boton = json.data.buttons[0];
    const put = await llamar(reemplazarControl as Metodo, {
      id,
      body: {
        holder_id: holderA,
        description: "Editado",
        buttons: [{ id: boton.id, button: 1, rf_code: boton.rf_code, outputs: { [panel1]: 2, [panel2]: 3 } }],
      },
    });
    expect(put.res.status).toBe(200);
    expect(put.json.data.description).toBe("Editado");
    expect(put.json.data.buttons[0].outputs).toEqual({ [panel1]: 2, [panel2]: 3 });
    const extra = await llamar(reemplazarControl as Metodo, { id, body: { holder_id: holderA, buttons: [], otro: 1 } });
    expect(extra.res.status).toBe(400);

    const del = await llamar(borrarControl as Metodo, { id });
    expect(del.json.data).toEqual({ id });
    expect((await pedir(leerControl as Metodo, { id })).status).toBe(404);
  });

  it("controles: un panel_id de otro tenant da 400", async () => {
    const { res, json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, buttons: [{ button: 0, rf_code: rf(), outputs: { [panelB]: 0 } }] },
    });
    expect(res.status).toBe(400);
    expect(typeof json.message).toBe("string");
  });

  it("controles: el mismo número de botón en el mismo panel da error y la unicidad por panel se traduce a 409", async () => {
    // La validación previa lo detecta dentro del control (400); el 409 es la carrera contra la restricción.
    const { res, json } = await llamar(crearControl as Metodo, {
      body: {
        holder_id: holderA,
        buttons: [
          { button: 2, rf_code: rf(), outputs: { [panel2]: 0 } },
          { button: 2, rf_code: rf(), outputs: { [panel2]: 1 } },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(json.message).toMatch(/número 3/);
    const carrera = () =>
      traducir({ code: "23505", message: "x", details: "control_button_panels_panel_button_live_key" });
    expect(carrera).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("controles: el control de B da 404 y no cambia", async () => {
    const leer = await llamar(leerControl as Metodo, { id: controlB });
    expect(leer.res.status).toBe(404);
    expect(leer.json.message).toBe("El control no existe.");
    const put = await llamar(reemplazarControl as Metodo, {
      id: controlB,
      body: { holder_id: holderA, description: "", buttons: [] },
    });
    expect(put.res.status).toBe(404);
    expect((await llamar(borrarControl as Metodo, { id: controlB })).res.status).toBe(404);
    const delInstB = await llamar(leerControl as Metodo, { inst: instB, id: controlB });
    expect(delInstB.res.status).toBe(404);
    const { data } = await admin.from("controls").select("deleted_at").eq("id", controlB).single();
    expect(data!.deleted_at).toBeNull();
  });

  it("controles: un titular de B da 400 en POST y en PUT", async () => {
    const post = await llamar(crearControl as Metodo, {
      body: { holder_id: holderB, buttons: [{ button: 0, rf_code: rf(), outputs: { [panel1]: 0 } }] },
    });
    expect(post.res.status).toBe(400);
    const { json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, description: "Propio", buttons: [{ button: 0, rf_code: rf(), outputs: { [panel1]: 0 } }] },
    });
    const put = await llamar(reemplazarControl as Metodo, {
      id: json.data.id,
      body: { holder_id: holderB, description: "Propio", buttons: [] },
    });
    expect(put.res.status).toBe(400);
    const { data } = await admin.from("controls").select("holder_id").eq("id", json.data.id).single();
    expect(data!.holder_id).toBe(holderA);
  });

  it("controles: un PUT con el id de un botón de B da 409 y el botón de B no cambia", async () => {
    const { data: antes } = await admin.from("control_buttons").select("*").eq("id", botonB).single();
    const { json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, description: "", buttons: [{ button: 1, rf_code: rf(), outputs: { [panel1]: 1 } }] },
    });
    const put = await llamar(reemplazarControl as Metodo, {
      id: json.data.id,
      body: { holder_id: holderA, description: "", buttons: [{ id: botonB, button: 0, rf_code: rf(), outputs: { [panel1]: 0 } }] },
    });
    expect(put.res.status).toBe(409);
    const { data: despues } = await admin.from("control_buttons").select("*").eq("id", botonB).single();
    expect(despues).toEqual(antes);
  });

  it("controles: un PUT que omite un panel en outputs conserva su vínculo", async () => {
    const { json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, description: "", buttons: [{ button: 3, rf_code: rf(), outputs: { [panel1]: 0, [panel2]: 1 } }] },
    });
    const boton = json.data.buttons[0];
    const put = await llamar(reemplazarControl as Metodo, {
      id: json.data.id,
      body: { holder_id: holderA, description: "", buttons: [{ id: boton.id, button: 3, rf_code: boton.rf_code, outputs: { [panel1]: 2 } }] },
    });
    expect(put.res.status).toBe(200);
    expect(put.json.data.buttons[0].outputs).toEqual({ [panel1]: 2, [panel2]: 1 });
    const actuales = await vinculos(json.data.id);
    expect(actuales).toHaveLength(2);
    expect(actuales).toEqual(
      expect.arrayContaining([
        { panel_id: panel1, output_index: 2 },
        { panel_id: panel2, output_index: 1 },
      ]),
    );
  });

  it("controles: PUT sin description da 400 y no borra la descripción", async () => {
    const { json } = await llamar(crearControl as Metodo, {
      body: { holder_id: holderA, description: "Conservar", buttons: [{ button: 0, rf_code: rf(), outputs: { [panel1]: 3 } }] },
    });
    const put = await llamar(reemplazarControl as Metodo, { id: json.data.id, body: { holder_id: holderA, buttons: [] } });
    expect(put.res.status).toBe(400);
    expect(put.json.code).toBe("bad_request");
    const { data } = await admin.from("controls").select("description").eq("id", json.data.id).single();
    expect(data!.description).toBe("Conservar");
  });
});
