import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paging } from "@/lib/access-data";
import { createCardAs, deleteCardAs, listCardsAs, updateCardAs } from "@/lib/cards";
import {
  createControlAs,
  deleteControlAs,
  listControlsAs,
  traducir,
  updateControlAs,
  type ButtonInput,
  type ButtonRow,
} from "@/lib/controls";
import { KEEP_NO_OUTPUT } from "@/lib/access-view";
import { decryptPin } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { createHolderAs, deleteHolderAs, getHolderPinAs, listHoldersAs, updateHolderAs } from "@/lib/holders";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Titulares, tarjetas y controles de una instalación con RLS contra el Supabase local (N13). */
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

const boton = (
  button: number,
  rf_code: number | null,
  outputs: ButtonInput["outputs"],
  id: string | null = null,
): ButtonInput => ({ id, button, rf_code, outputs });

describe("titulares, tarjetas y controles (N13)", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `n13-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let instA: string;
  let instB: string;
  /** Paneles vinculados de instA (activos), uno revocado de instA, uno pendiente (sin instalación) y uno de instB. */
  let panel1: string;
  let panel2: string;
  let codigo1: string;
  let revocadoA: string;
  let pendiente: string;
  let panelInstB: string;
  const paneles: string[] = [];
  const codigos = new Map<string, string>();

  /** Botón N (0..3) con el código dado, al Panel 1 en la salida N. */
  const botones = (...rf: Array<number | null>): ButtonInput[] =>
    rf.flatMap((c, i) => (c == null ? [] : [boton(i, c, { [panel1]: i })]));

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
  async function panel(installationId: string | null, status = "active"): Promise<string> {
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
        ...(status === "active" ? { device_token_hash: "b".repeat(64) } : {}),
      })
      .select("id")
      .single();
    if (error) throw error;
    paneles.push(data.id);
    codigos.set(data.id, codigo);
    return data.id;
  }

  /** Vínculos vivos de un botón, por panel. */
  async function vinculos(buttonId: string) {
    const { data, error } = await admin
      .from("control_button_panels")
      .select("id, panel_id, output_index, revision")
      .eq("button_id", buttonId)
      .is("deleted_at", null)
      .order("panel_id");
    if (error) throw error;
    return data as { id: string; panel_id: string; output_index: number | null; revision: number }[];
  }

  beforeAll(async () => {
    requireLocalSupabase();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");
    for (const nombre of ["A", "B"]) {
      const { data, error } = await admin.from("tenants").insert({ name: `N13 ${nombre} ${sufijo}` }).select("id").single();
      if (error) throw error;
      tenants.push(data.id);
    }
    [tenantA, tenantB] = tenants;
    adminA = await usuario("admin-a", tenantA, "admin");
    tecnicoA = await usuario("tec-a", tenantA, "tecnico");
    adminB = await usuario("admin-b", tenantB, "admin");
    instA = await instalacion(tenantA, "Torre A");
    instB = await instalacion(tenantB, "Torre B");
    panel1 = await panel(instA);
    panel2 = await panel(instA);
    codigo1 = codigos.get(panel1)!;
    revocadoA = await panel(instA, "revoked");
    pendiente = await panel(null, "pending");
    panelInstB = await panel(instB);
  });

  // Los vínculos apuntan a los paneles sin cascada: primero ellos, luego los paneles y los tenants.
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

  const titular = (nombre: string, extra: Record<string, unknown> = {}) => ({
    kind: "persona" as const,
    name: nombre,
    department: "",
    address: "",
    notes: "",
    pin: { mode: "keep" as const },
    ...extra,
  });

  describe("titulares y PIN", () => {
    it("crea un titular con PIN cifrado y la lista solo expone has_pin", async () => {
      const { id } = await createHolderAs(adminA, tenantA, instA, titular("Ana", { pin: { mode: "set", pin: "123456" } }));
      const lista = await listHoldersAs(tecnicoA, tenantA, instA);
      const ana = lista.find((h) => h.id === id)!;
      expect(ana.has_pin).toBe(true);
      expect(JSON.stringify(lista)).not.toContain("123456");
      expect(Object.keys(ana)).not.toContain("pin");
      const { data } = await admin.from("holders").select("pin_ciphertext, pin_lookup, origin").eq("id", id).single();
      expect(data!.pin_ciphertext).not.toContain("123456");
      expect(decryptPin(data!.pin_ciphertext)).toBe("123456");
      expect(data!.origin).toBe("cloud");
    });

    it("el admin recibe el PIN actual y el técnico no (403)", async () => {
      const { id } = await createHolderAs(adminA, tenantA, instA, titular("Beto", { pin: { mode: "set", pin: "4821" } }));
      expect(await getHolderPinAs(adminA, tenantA, instA, id)).toBe("4821");
      expect((await fallo(getHolderPinAs(tecnicoA, tenantA, instA, id))).status).toBe(403);
    });

    it("el técnico asigna y quita un PIN; 'keep' lo conserva", async () => {
      const { id } = await createHolderAs(tecnicoA, tenantA, instA, titular("Carla"));
      await updateHolderAs(tecnicoA, tenantA, instA, id, titular("Carla", { pin: { mode: "set", pin: "9090" } }));
      expect(await getHolderPinAs(adminA, tenantA, instA, id)).toBe("9090");
      await updateHolderAs(tecnicoA, tenantA, instA, id, titular("Carla R.", { pin: { mode: "keep" } }));
      expect(await getHolderPinAs(adminA, tenantA, instA, id)).toBe("9090");
      await updateHolderAs(tecnicoA, tenantA, instA, id, titular("Carla R.", { pin: { mode: "clear" } }));
      expect(await getHolderPinAs(adminA, tenantA, instA, id)).toBeNull();
      expect((await listHoldersAs(adminA, tenantA, instA)).find((h) => h.id === id)!.has_pin).toBe(false);
    });

    it("un PIN duplicado da el mensaje en español sin revelar el otro PIN", async () => {
      await createHolderAs(adminA, tenantA, instA, titular("Dani", { pin: { mode: "set", pin: "777888" } }));
      const e = await fallo(createHolderAs(adminA, tenantA, instA, titular("Eva", { pin: { mode: "set", pin: "777888" } })));
      expect(e.status).toBe(409);
      expect(e.message).toBe("El PIN ya está asignado a otro titular.");
      expect(e.message).not.toContain("777888");
      expect(e.message).not.toContain("Dani");
    });

    it("rechaza un PIN que no tiene de 4 a 6 dígitos y un nombre vacío", async () => {
      for (const pin of ["123", "1234567", "12a4", ""]) {
        const e = await fallo(createHolderAs(adminA, tenantA, instA, titular("Fer", { pin: { mode: "set", pin } })));
        expect(e).toMatchObject({ status: 400, message: "El PIN debe tener de 4 a 6 dígitos." });
      }
      const e = await fallo(createHolderAs(adminA, tenantA, instA, titular("   ")));
      expect(e).toMatchObject({ status: 400, message: "El nombre es obligatorio." });
    });

    it("borrar un titular deja sus tarjetas y controles con deleted_at y no aparece en las listas", async () => {
      const { id } = await createHolderAs(adminA, tenantA, instA, titular("Gus"));
      const { id: cardId } = await createCardAs(adminA, tenantA, instA, { card_code: 5551, holder_id: id, description: "" });
      const { id: ctrlId } = await createControlAs(adminA, tenantA, instA, {
        holder_id: id,
        description: "",
        buttons: botones(6661),
      });
      await deleteHolderAs(adminA, tenantA, instA, id);
      for (const [tabla, fila] of [
        ["holders", id],
        ["cards", cardId],
        ["controls", ctrlId],
      ] as const) {
        const { data } = await admin.from(tabla).select("deleted_at").eq("id", fila).single();
        expect(data!.deleted_at, tabla).not.toBeNull();
      }
      const { data: bots } = await admin.from("control_buttons").select("deleted_at").eq("control_id", ctrlId);
      expect(bots!.every((b) => b.deleted_at !== null)).toBe(true);
      expect((await listHoldersAs(adminA, tenantA, instA)).some((h) => h.id === id)).toBe(false);
      expect((await listCardsAs(adminA, tenantA, instA)).some((c) => c.id === cardId)).toBe(false);
      expect((await listControlsAs(adminA, tenantA, instA)).some((c) => c.id === ctrlId)).toBe(false);
      expect((await fallo(deleteHolderAs(adminA, tenantA, instA, id))).status).toBe(404);
    });

    it("una instalación de otro tenant o un no miembro reciben error", async () => {
      expect((await fallo(listHoldersAs(adminB, tenantA, instA))).status).toBe(403);
      expect((await fallo(listHoldersAs(adminA, tenantA, instB))).status).toBe(404);
      expect((await fallo(createHolderAs(adminA, tenantA, instB, titular("X")))).status).toBe(404);
    });
  });

  describe("tarjetas", () => {
    let holderId: string;
    let otroId: string;
    beforeAll(async () => {
      holderId = (await createHolderAs(adminA, tenantA, instA, titular("Hugo"))).id;
      otroId = (await createHolderAs(adminA, tenantA, instA, titular("Irene"))).id;
    });

    it("un card_code duplicado muestra el mensaje en español con el nombre del titular", async () => {
      await createCardAs(adminA, tenantA, instA, { card_code: 1001, holder_id: holderId, description: "" });
      const e = await fallo(createCardAs(adminA, tenantA, instA, { card_code: 1001, holder_id: otroId, description: "" }));
      expect(e).toMatchObject({ status: 409, message: "La tarjeta 1001 ya está registrada a Hugo." });
    });

    it("valida el rango del código y que el titular exista", async () => {
      for (const card_code of [-1, 4294967296, 1.5, Number.NaN]) {
        const e = await fallo(createCardAs(adminA, tenantA, instA, { card_code, holder_id: holderId, description: "" }));
        expect(e.message).toBe("Usa solo números (0 a 4294967295).");
      }
      const e = await fallo(createCardAs(adminA, tenantA, instA, { card_code: 1002, holder_id: randomUUID(), description: "" }));
      expect(e).toMatchObject({ status: 400, message: "El titular no existe." });
      await createCardAs(adminA, tenantA, instA, { card_code: 4294967295, holder_id: holderId, description: "" });
    });

    it("edita titular y descripción y no deja repetir el código al editar", async () => {
      const { id } = await createCardAs(adminA, tenantA, instA, { card_code: 1003, holder_id: holderId, description: "a" });
      await updateCardAs(tecnicoA, tenantA, instA, id, { holder_id: otroId, description: "  b " });
      const c = (await listCardsAs(adminA, tenantA, instA)).find((x) => x.id === id)!;
      expect(c).toMatchObject({ card_code: 1003, holder_id: otroId, holder_name: "Irene", description: "b" });
    });

    it("borrar una tarjeta deja deleted_at, sube la revisión y libera el código", async () => {
      const { id } = await createCardAs(adminA, tenantA, instA, { card_code: 1004, holder_id: holderId, description: "" });
      const antes = (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;
      await deleteCardAs(adminA, tenantA, instA, id);
      const { data } = await admin.from("cards").select("deleted_at, revision").eq("id", id).single();
      expect(data!.deleted_at).not.toBeNull();
      const despues = (await admin.from("installations").select("revision").eq("id", instA).single()).data!.revision;
      expect(despues).toBeGreaterThan(antes);
      expect(data!.revision).toBeGreaterThan(antes);
      await createCardAs(adminA, tenantA, instA, { card_code: 1004, holder_id: otroId, description: "" });
    });
  });

  describe("controles", () => {
    let holderId: string;
    let otroId: string;
    beforeAll(async () => {
      holderId = (await createHolderAs(adminA, tenantA, instA, titular("Joel"))).id;
      otroId = (await createHolderAs(adminA, tenantA, instA, titular("Kiki"))).id;
    });

    const sinId = ({ button, rf_code, outputs }: ButtonRow) => ({ button, rf_code, outputs });
    const buscar = async (id: string, cliente = adminA) =>
      (await listControlsAs(cliente, tenantA, instA)).find((x) => x.id === id)!;

    it("crea un control con botones y los lista con titular y salida por panel", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "Llavero",
        buttons: [
          boton(0, 2001, { [panel1]: 0, [panel2]: 1 }),
          boton(2, 2003, { [panel1]: null, [panel2]: 3 }),
          boton(3, 2004, { [panel1]: 3 }),
        ],
      });
      const c = await buscar(id, tecnicoA);
      expect(c.holder_name).toBe("Joel");
      expect(c.buttons.map(sinId)).toEqual([
        { button: 0, rf_code: 2001, outputs: { [panel1]: 0, [panel2]: 1 } },
        { button: 2, rf_code: 2003, outputs: { [panel2]: 3 } },
        { button: 3, rf_code: 2004, outputs: { [panel1]: 3 } },
      ]);
      expect(c.buttons.every((b) => typeof b.id === "string")).toBe(true);
    });

    it("createControlAs con un botón al Panel 1 S1 y al Panel 2 ninguna crea un solo vínculo", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2101, { [panel1]: 0, [panel2]: null })],
      });
      const [b] = (await buscar(id)).buttons;
      expect((await vinculos(b.id)).map(({ panel_id, output_index }) => ({ panel_id, output_index }))).toEqual([
        { panel_id: panel1, output_index: 0 },
      ]);
    });

    it("updateControlAs que cambia la salida del Panel 2 solo toca ese vínculo", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(1, 2201, { [panel1]: 0, [panel2]: 1 })],
      });
      const [b] = (await buscar(id)).buttons;
      const antes = await vinculos(b.id);
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [boton(1, 2201, { [panel1]: 0, [panel2]: 2 }, b.id)],
      });
      const despues = await vinculos(b.id);
      const de = (filas: typeof antes, p: string) => filas.find((f) => f.panel_id === p)!;
      expect(de(despues, panel1)).toEqual(de(antes, panel1));
      expect(de(despues, panel2)).toMatchObject({ id: de(antes, panel2).id, output_index: 2 });
      expect(de(despues, panel2).revision).toBeGreaterThan(de(antes, panel2).revision);
      expect((await buscar(id)).buttons).toEqual([{ id: b.id, button: 1, rf_code: 2201, outputs: { [panel1]: 0, [panel2]: 2 } }]);
    });

    it("botón sin salida en ningún panel se borra, y uno nuevo sin salida no se crea", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2301, { [panel1]: 0, [panel2]: 0 }), boton(1, 2302, { [panel1]: 1 }), boton(2, 2303, {})],
      });
      const c = await buscar(id);
      expect(c.buttons.map((b) => b.rf_code)).toEqual([2301, 2302]);
      const [b0, b1] = c.buttons;
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [
          boton(0, 2301, { [panel1]: null, [panel2]: null }, b0.id),
          boton(1, 2302, { [panel1]: 1 }, b1.id),
          boton(3, 2304, { [panel1]: null }),
        ],
      });
      const { data: fila } = await admin.from("control_buttons").select("deleted_at").eq("id", b0.id).single();
      expect(fila!.deleted_at).not.toBeNull();
      expect(await vinculos(b0.id)).toEqual([]);
      expect((await buscar(id)).buttons.map((b) => b.rf_code)).toEqual([2302]);
      // el código del botón borrado queda libre
      await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(2301) });
    });

    /** Vínculo escrito como servidor (lo que haría un panel o un panel ya revocado). */
    async function vincular(buttonId: string, panelId: string, output_index: number | null) {
      const { error } = await admin.from("control_button_panels").insert({
        installation_id: instA,
        button_id: buttonId,
        panel_id: panelId,
        output_index,
        updated_by: "prueba",
        origin: "cloud",
      });
      if (error) throw error;
    }

    it("Sin salida conserva el vínculo nulo que puso un panel y Ninguna lo borra", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2351, { [panel1]: 0 })],
      });
      const [b] = (await buscar(id)).buttons;
      await vincular(b.id, panel2, null);
      expect((await buscar(id)).buttons[0].outputs).toEqual({ [panel1]: 0, [panel2]: null });
      const antes = await vinculos(b.id);
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2351, { [panel1]: 0, [panel2]: KEEP_NO_OUTPUT }, b.id)],
      });
      expect(await vinculos(b.id)).toEqual(antes);
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2351, { [panel1]: 0, [panel2]: null }, b.id)],
      });
      expect((await buscar(id)).buttons[0].outputs).toEqual({ [panel1]: 0 });
      // ya no existe el vínculo nulo: Sin salida no lo puede crear
      const e = await fallo(
        updateControlAs(adminA, tenantA, instA, id, {
          holder_id: holderId,
          description: "",
          buttons: [boton(0, 2351, { [panel1]: 0, [panel2]: KEEP_NO_OUTPUT }, b.id)],
        }),
      );
      expect(e).toMatchObject({
        status: 400,
        message: "Sin salida solo se puede conservar en un panel que ya tiene el botón sin salida.",
      });
      const e2 = await fallo(
        createControlAs(adminA, tenantA, instA, {
          holder_id: holderId,
          description: "",
          buttons: [boton(1, 2352, { [panel1]: 0, [panel2]: KEEP_NO_OUTPUT })],
        }),
      );
      expect(e2.status).toBe(400);
    });

    it("un botón con solo vínculos sin salida se conserva; sin vínculos a paneles vinculados se borra", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2361, { [panel1]: 0 }), boton(1, 2362, { [panel1]: 1 })],
      });
      const [b0, b1] = (await buscar(id)).buttons;
      await vincular(b0.id, panel2, null);
      await vincular(b1.id, revocadoA, 2);
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [
          boton(0, 2361, { [panel1]: null, [panel2]: KEEP_NO_OUTPUT }, b0.id),
          // el vínculo al panel revocado no cuenta: sin vínculos vigentes, el botón se borra
          boton(1, 2362, { [panel1]: null, [panel2]: null }, b1.id),
        ],
      });
      expect((await buscar(id)).buttons).toEqual([{ id: b0.id, button: 0, rf_code: 2361, outputs: { [panel2]: null } }]);
      const { data } = await admin.from("control_buttons").select("deleted_at").eq("id", b1.id).single();
      expect(data!.deleted_at).not.toBeNull();
      expect(await vinculos(b1.id)).toEqual([]);
    });

    it("un choque de número por panel en la base se traduce a 409 en español", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(2, 2371, { [panel1]: 0 }), boton(2, 2372, { [panel2]: 0 })],
      });
      const b = (await buscar(id)).buttons.find((x) => x.rf_code === 2372)!;
      // Lo que pasaría si otra sesión vinculara el segundo botón al Panel 1 entre la validación y la escritura.
      const { error } = await adminA
        .from("control_button_panels")
        .insert({ installation_id: instA, button_id: b.id, panel_id: panel1, output_index: 1 });
      expect(error).toMatchObject({ code: "23505", details: "control_button_panels_panel_button_live_key" });
      let traducido: unknown;
      try {
        traducir(error!);
      } catch (err) {
        traducido = err;
      }
      expect(traducido).toMatchObject({
        status: 409,
        message: "Otro botón de este control ya usa ese número en el mismo panel. Recarga la página.",
      });
    });

    it("dos botones con el mismo número al mismo panel dan 400; a paneles distintos se permiten", async () => {
      const e = await fallo(
        createControlAs(adminA, tenantA, instA, {
          holder_id: holderId,
          description: "",
          buttons: [boton(0, 2401, { [panel1]: 0 }), boton(0, 2402, { [panel1]: 1, [panel2]: 1 })],
        }),
      );
      expect(e).toMatchObject({ status: 400, message: `Dos botones con el número 1 van al panel ${codigo1}.` });

      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 2401, { [panel1]: 0 }), boton(0, 2402, { [panel2]: 1 })],
      });
      // con el mismo número, el orden entre ellos es el de su id
      const lista = (await buscar(id)).buttons;
      const a = lista.find((x) => x.rf_code === 2401)!;
      const b = lista.find((x) => x.rf_code === 2402)!;
      expect([a.outputs, b.outputs]).toEqual([{ [panel1]: 0 }, { [panel2]: 1 }]);
      // al editar, mover el segundo también al Panel 1 choca con el primero
      const e2 = await fallo(
        updateControlAs(adminA, tenantA, instA, id, {
          holder_id: holderId,
          description: "",
          buttons: [boton(0, 2401, { [panel1]: 0 }, a.id), boton(0, 2402, { [panel1]: 2, [panel2]: 1 }, b.id)],
        }),
      );
      expect(e2).toMatchObject({ status: 400, message: `Dos botones con el número 1 van al panel ${codigo1}.` });
      expect(await vinculos(b.id)).toHaveLength(1);
    });

    it("un técnico puede editar y un usuario de otro tenant no", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(2501) });
      const [b] = (await buscar(id)).buttons;
      await updateControlAs(tecnicoA, tenantA, instA, id, {
        holder_id: holderId,
        description: "Del técnico",
        buttons: [boton(0, 2501, { [panel1]: null, [panel2]: 3 }, b.id)],
      });
      expect((await buscar(id)).buttons[0].outputs).toEqual({ [panel2]: 3 });
      const e = await fallo(
        updateControlAs(adminB, tenantA, instA, id, { holder_id: holderId, description: "", buttons: [] }),
      );
      expect(e.status).toBe(403);
      expect(
        (await fallo(createControlAs(adminB, tenantB, instA, { holder_id: holderId, description: "", buttons: [] }))).status,
      ).toBe(404);
      expect((await fallo(deleteControlAs(adminB, tenantA, instA, id))).status).toBe(403);
      expect((await buscar(id)).description).toBe("Del técnico");
    });

    it("un RF duplicado da el mensaje en español con el titular", async () => {
      const e = await fallo(
        createControlAs(adminA, tenantA, instA, { holder_id: otroId, description: "", buttons: botones(2001) }),
      );
      expect(e).toMatchObject({ status: 409, message: "El código 2001 ya está registrado en un control de Joel." });
      // el control a medias no queda vivo
      expect((await listControlsAs(adminA, tenantA, instA)).filter((c) => c.holder_id === otroId)).toHaveLength(0);
    });

    it("rechaza códigos repetidos, números, salidas y paneles inválidos y demasiados botones", async () => {
      const crear = (buttons: ButtonInput[]) =>
        fallo(createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons }));
      expect((await crear(botones(3001, 3001))).message).toBe("Cada botón del control debe tener un código distinto.");
      expect((await crear([boton(0, 3002, { [panel1]: 4 })])).message).toBe("La salida debe ser de S1 a S4.");
      expect((await crear([boton(4, 3002, { [panel1]: 0 })])).message).toBe("El número de botón debe ser del 1 al 4.");
      for (const p of [revocadoA, pendiente, panelInstB, "no-es-uuid"]) {
        expect((await crear([boton(0, 3002, { [p]: 0 })])).message, p).toBe("El panel no existe o ya no está vinculado.");
      }
      const nueve = Array.from({ length: 9 }, (_, i) => boton(i % 4, 3100 + i, {}));
      expect((await crear(nueve)).message).toBe("El control admite hasta 8 botones.");
      expect((await crear(botones(4294967296))).message).toBe("Usa solo números (0 a 4294967295).");
      expect((await crear([boton(0, 3003, { [panel1]: 0 }, randomUUID())])).status).toBe(400);
    });

    it("al editar cambia códigos en su sitio, quita y agrega botones, incluso intercambiando códigos", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: botones(4001, 4002, 4003),
      });
      const [b0, b1, b2] = (await buscar(id)).buttons;
      // un vínculo a un panel revocado no se recrea con el botón
      await vincular(b0.id, revocadoA, 3);
      await updateControlAs(tecnicoA, tenantA, instA, id, {
        holder_id: otroId,
        description: "Nuevo",
        buttons: [
          boton(0, 4002, { [panel1]: 1 }, b0.id),
          boton(1, 4001, { [panel1]: 0 }, b1.id),
          boton(2, null, { [panel1]: 2 }, b2.id),
          boton(3, 4005, { [panel1]: 2, [panel2]: 0 }),
        ],
      });
      const c = await buscar(id);
      expect(c).toMatchObject({ holder_id: otroId, holder_name: "Kiki", description: "Nuevo" });
      expect(c.buttons.map(sinId)).toEqual([
        { button: 0, rf_code: 4002, outputs: { [panel1]: 1 } },
        { button: 1, rf_code: 4001, outputs: { [panel1]: 0 } },
        { button: 3, rf_code: 4005, outputs: { [panel1]: 2, [panel2]: 0 } },
      ]);
      // el intercambio se rompe dando de alta otra vez el primer botón; el segundo cambia en su sitio
      expect(c.buttons[0].id).not.toBe(b0.id);
      expect(c.buttons[1].id).toBe(b1.id);
      // el código liberado queda disponible
      await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(4003) });
    });

    it("cambiar el código de un botón actualiza su fila y conserva sus vínculos", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 4101, { [panel1]: 0, [panel2]: 2 })],
      });
      const [b] = (await buscar(id)).buttons;
      const antes = await vinculos(b.id);
      await updateControlAs(adminA, tenantA, instA, id, {
        holder_id: holderId,
        description: "",
        buttons: [boton(0, 4102, { [panel1]: 0, [panel2]: 2 }, b.id)],
      });
      expect((await buscar(id)).buttons).toEqual([{ id: b.id, button: 0, rf_code: 4102, outputs: { [panel1]: 0, [panel2]: 2 } }]);
      expect(await vinculos(b.id)).toEqual(antes);
    });

    it("editar con un RF de otro control da el mensaje y no cambia nada", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(5001) });
      const [b] = (await buscar(id)).buttons;
      const e = await fallo(
        updateControlAs(adminA, tenantA, instA, id, {
          holder_id: holderId,
          description: "",
          buttons: [boton(0, 2001, { [panel1]: 0 }, b.id)],
        }),
      );
      expect(e.message).toBe("El código 2001 ya está registrado en un control de Joel.");
      expect((await buscar(id)).buttons.map((x) => x.rf_code)).toEqual([5001]);
    });

    it("un botón que ya no existe da 409 y no cambia nada", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "Antes", buttons: botones(5101) });
      const e = await fallo(
        updateControlAs(adminA, tenantA, instA, id, {
          holder_id: holderId,
          description: "Después",
          buttons: [boton(0, 5101, { [panel1]: 0 }, randomUUID())],
        }),
      );
      expect(e).toMatchObject({ status: 409, message: "Uno de los botones ya no existe. Recarga la página." });
      expect((await buscar(id)).description).toBe("Antes");
    });

    it("borrar un control deja control, botones y vínculos con deleted_at y libera los RF", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(6001, 6002) });
      const ids = (await buscar(id)).buttons.map((b) => b.id);
      await deleteControlAs(adminA, tenantA, instA, id);
      const { data } = await admin.from("controls").select("deleted_at").eq("id", id).single();
      expect(data!.deleted_at).not.toBeNull();
      const { data: bots } = await admin.from("control_buttons").select("deleted_at").eq("control_id", id);
      expect(bots).toHaveLength(2);
      expect(bots!.every((b) => b.deleted_at !== null)).toBe(true);
      for (const b of ids) expect(await vinculos(b)).toEqual([]);
      await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(6001) });
    });
  });
  describe("listas con más filas que la página (límite max_rows de la Data API)", () => {
    const tamanoOriginal = paging.size;
    let instP: string;
    let panelP: string;
    beforeAll(async () => {
      paging.size = 2;
      instP = await instalacion(tenantA, "Torre paginada");
      panelP = await panel(instP);
    });
    afterAll(() => {
      paging.size = tamanoOriginal;
    });

    it("titulares, tarjetas, controles y conteos salen completos con varias páginas", async () => {
      const ids: string[] = [];
      for (const n of ["P1", "P2", "P3", "P4", "P5"]) {
        ids.push((await createHolderAs(adminA, tenantA, instP, titular(n))).id);
      }
      for (let i = 0; i < 5; i++) {
        await createCardAs(adminA, tenantA, instP, { card_code: 70000 + i, holder_id: ids[0], description: "" });
      }
      for (let i = 0; i < 3; i++) {
        await createControlAs(adminA, tenantA, instP, {
          holder_id: ids[1],
          description: `c${i}`,
          buttons: [0, 1, 2].map((n) => boton(n, 71000 + i * 10 + n, { [panelP]: n })),
        });
      }
      const holders = await listHoldersAs(adminA, tenantA, instP);
      expect(holders.map((h) => h.name)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
      expect(holders[0].card_count).toBe(5);
      expect(holders[1].control_count).toBe(3);
      const cards = await listCardsAs(adminA, tenantA, instP);
      expect(cards.map((c) => c.card_code)).toEqual([70000, 70001, 70002, 70003, 70004]);
      expect(cards.every((c) => c.holder_name === "P1")).toBe(true);
      const lista = await listControlsAs(adminA, tenantA, instP);
      expect(lista).toHaveLength(3);
      for (const c of lista) {
        expect(c.buttons.map((b) => b.outputs)).toEqual([{ [panelP]: 0 }, { [panelP]: 1 }, { [panelP]: 2 }]);
      }
      expect(lista.every((c) => c.holder_name === "P2")).toBe(true);
    });

    it("editar solo la descripción de un control con la lista completa no toca botones ni vínculos", async () => {
      const antes = (await listControlsAs(adminA, tenantA, instP))[0];
      const vinculosAntes = await Promise.all(antes.buttons.map((b) => vinculos(b.id)));
      await updateControlAs(adminA, tenantA, instP, antes.id, {
        holder_id: antes.holder_id,
        description: "solo texto",
        buttons: antes.buttons.map((b) => ({ ...b })),
      });
      const despues = (await listControlsAs(adminA, tenantA, instP)).find((c) => c.id === antes.id)!;
      expect(despues.description).toBe("solo texto");
      expect(despues.buttons).toEqual(antes.buttons);
      expect(await Promise.all(antes.buttons.map((b) => vinculos(b.id)))).toEqual(vinculosAntes);
    });
  });
});

describe("traducir (errores de PostgREST)", () => {
  const traducido = (error: Parameters<typeof traducir>[0]) => {
    try {
      traducir(error);
    } catch (err) {
      return err;
    }
    throw new Error("traducir debía lanzar.");
  };

  it("reconoce el choque por panel por `details` (el trigger no llega con `constraint`)", () => {
    expect(
      traducido({
        code: "23505",
        message: "El número de botón ya está en uso en ese control para este panel.",
        details: "control_button_panels_panel_button_live_key",
      }),
    ).toMatchObject({ status: 409, message: "Otro botón de este control ya usa ese número en el mismo panel. Recarga la página." });
  });

  it("sigue reconociendo los índices únicos por el mensaje y deja pasar lo desconocido", () => {
    expect(
      traducido({
        code: "23505",
        message: 'duplicate key value violates unique constraint "control_buttons_rf_code_live_key"',
        details: "Key (installation_id, rf_code)=(…) already exists.",
      }),
    ).toMatchObject({ status: 409, message: "Uno de los códigos ya está registrado en otro control." });
    const otro = { code: "23505", message: "otra restricción", details: null };
    expect(traducido(otro)).toBe(otro);
  });
});
