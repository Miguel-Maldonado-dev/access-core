import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paging } from "@/lib/access-data";
import { createCardAs, deleteCardAs, listCardsAs, updateCardAs } from "@/lib/cards";
import {
  createControlAs,
  deleteControlAs,
  listControlsAs,
  updateControlAs,
  type ButtonInput,
} from "@/lib/controls";
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

const sinBotones = (): ButtonInput[] => Array.from({ length: 4 }, () => ({ rf_code: null, output_index: null }));
const botones = (...codigos: Array<number | null>): ButtonInput[] =>
  sinBotones().map((b, i) => (codigos[i] == null ? b : { rf_code: codigos[i] as number, output_index: i }));

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
  });

  afterAll(async () => {
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

    it("crea un control con botones y los lista con titular y salida", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "Llavero",
        buttons: [
          { rf_code: 2001, output_index: 0 },
          { rf_code: null, output_index: null },
          { rf_code: 2003, output_index: null },
          { rf_code: 2004, output_index: 3 },
        ],
      });
      const c = (await listControlsAs(tecnicoA, tenantA, instA)).find((x) => x.id === id)!;
      expect(c.holder_name).toBe("Joel");
      expect(c.buttons).toEqual([
        { button: 0, rf_code: 2001, output_index: 0 },
        { button: 2, rf_code: 2003, output_index: null },
        { button: 3, rf_code: 2004, output_index: 3 },
      ]);
    });

    it("un RF duplicado da el mensaje en español con el titular", async () => {
      const e = await fallo(
        createControlAs(adminA, tenantA, instA, { holder_id: otroId, description: "", buttons: botones(2001) }),
      );
      expect(e).toMatchObject({ status: 409, message: "El código 2001 ya está registrado en un control de Joel." });
      // el control a medias no queda vivo
      expect((await listControlsAs(adminA, tenantA, instA)).filter((c) => c.holder_id === otroId)).toHaveLength(0);
    });

    it("rechaza códigos repetidos dentro del control, salidas fuera de rango y botones mal formados", async () => {
      let e = await fallo(createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(3001, 3001) }));
      expect(e.message).toBe("Cada botón del control debe tener un código distinto.");
      const malos = botones(3002);
      malos[0].output_index = 4;
      e = await fallo(createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: malos }));
      expect(e.message).toBe("La salida debe estar entre 0 y 3.");
      e = await fallo(createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(3003).slice(0, 3) }));
      expect(e.message).toBe("El control debe tener exactamente 4 botones.");
      e = await fallo(createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(4294967296) }));
      expect(e.message).toBe("Usa solo números (0 a 4294967295).");
    });

    it("al editar cambia, quita y agrega botones, incluso intercambiando códigos", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, {
        holder_id: holderId,
        description: "",
        buttons: botones(4001, 4002, 4003),
      });
      await updateControlAs(tecnicoA, tenantA, instA, id, {
        holder_id: otroId,
        description: "Nuevo",
        buttons: [
          { rf_code: 4002, output_index: 1 },
          { rf_code: 4001, output_index: 0 },
          { rf_code: null, output_index: null },
          { rf_code: 4005, output_index: 2 },
        ],
      });
      const c = (await listControlsAs(adminA, tenantA, instA)).find((x) => x.id === id)!;
      expect(c).toMatchObject({ holder_id: otroId, holder_name: "Kiki", description: "Nuevo" });
      expect(c.buttons).toEqual([
        { button: 0, rf_code: 4002, output_index: 1 },
        { button: 1, rf_code: 4001, output_index: 0 },
        { button: 3, rf_code: 4005, output_index: 2 },
      ]);
      // los códigos liberados quedan disponibles
      await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(4003) });
    });

    it("editar con un RF de otro control da el mensaje y no cambia nada", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(5001) });
      const e = await fallo(
        updateControlAs(adminA, tenantA, instA, id, { holder_id: holderId, description: "", buttons: botones(2001) }),
      );
      expect(e.message).toBe("El código 2001 ya está registrado en un control de Joel.");
      const c = (await listControlsAs(adminA, tenantA, instA)).find((x) => x.id === id)!;
      expect(c.buttons.map((b) => b.rf_code)).toEqual([5001]);
    });

    it("borrar un control deja control y botones con deleted_at y libera los RF", async () => {
      const { id } = await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(6001, 6002) });
      await deleteControlAs(adminA, tenantA, instA, id);
      const { data } = await admin.from("controls").select("deleted_at").eq("id", id).single();
      expect(data!.deleted_at).not.toBeNull();
      const { data: bots } = await admin.from("control_buttons").select("deleted_at").eq("control_id", id);
      expect(bots).toHaveLength(2);
      expect(bots!.every((b) => b.deleted_at !== null)).toBe(true);
      await createControlAs(adminA, tenantA, instA, { holder_id: holderId, description: "", buttons: botones(6001) });
    });
  });
  describe("listas con más filas que la página (límite max_rows de la Data API)", () => {
    const tamanoOriginal = paging.size;
    let instP: string;
    beforeAll(async () => {
      paging.size = 2;
      instP = await instalacion(tenantA, "Torre paginada");
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
      const controles: string[] = [];
      for (let i = 0; i < 3; i++) {
        controles.push(
          (await createControlAs(adminA, tenantA, instP, { holder_id: ids[1], description: `c${i}`, buttons: botones(71000 + i * 10, 71001 + i * 10, 71002 + i * 10) })).id,
        );
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
      for (const c of lista) expect(c.buttons).toHaveLength(3);
      expect(lista.every((c) => c.holder_name === "P2")).toBe(true);
    });

    it("editar solo la descripción de un control con la lista completa no borra botones", async () => {
      const antes = (await listControlsAs(adminA, tenantA, instP))[0];
      const buttons: ButtonInput[] = sinBotones();
      for (const b of antes.buttons) buttons[b.button] = { rf_code: b.rf_code, output_index: b.output_index };
      await updateControlAs(adminA, tenantA, instP, antes.id, { holder_id: antes.holder_id, description: "solo texto", buttons });
      const despues = (await listControlsAs(adminA, tenantA, instP)).find((c) => c.id === antes.id)!;
      expect(despues.description).toBe("solo texto");
      expect(despues.buttons).toEqual(antes.buttons);
      const { data } = await admin.from("control_buttons").select("id").eq("control_id", antes.id).is("deleted_at", null);
      expect(data).toHaveLength(3);
    });
  });
});
