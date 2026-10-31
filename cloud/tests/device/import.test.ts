import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as importSnapshot } from "@/app/api/device/v1/import-snapshot/route";
import { decryptPin, encryptPin, pinLookup } from "@/lib/crypto";
import type { ContractRow, SnapshotTables, TableData } from "@/lib/device/contract";
import {
  MAX_PROFILES,
  computeImportDiff,
  confirmImportAs,
  readImportDiffAs,
  snapshotProblem,
  type CloudState,
  type ImportDiff,
  type StoredSnapshot,
} from "@/lib/device/imports";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

// Importación al vincular (N8): POST /import-snapshot, computeImportDiff, confirmImport
// y la lectura del diff. Las pruebas de integración usan el Supabase LOCAL; las filas de
// partida se escriben como servidor (llave secreta) con updated_at, updated_by y origin.
// Cada corrida crea sus propios usuarios, tenants, instalaciones y paneles, y los borra.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const base32 = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[b & 31]).join("");
const URL_BASE = "http://localhost/api/device/v1";
const MAXIMO_PERFILES = "Máximo 32 perfiles por instalación.";

type Fila = Record<string, unknown>;

function snapshotVacio(): SnapshotTables {
  return {
    holders: [],
    cards: [],
    controls: [],
    control_buttons: [],
    permissions: [],
    holder_permissions: [],
    outputs: [],
  };
}

function titular(
  kind: "persona" | "domicilio",
  name: string,
  pin: string | null = null,
  id: string = randomUUID(),
): ContractRow<"holders"> {
  return { id, data: { kind, name, department: "", address: "", notes: "", pin } };
}

const tarjeta = (holder_id: string, card_code: number, id: string = randomUUID()): ContractRow<"cards"> => ({
  id,
  data: { card_code, holder_id, description: `Tarjeta ${card_code}` },
});

const PERMISO: Omit<TableData["permissions"], "permission_id" | "name"> = {
  output_mask: 3,
  card_reader_mask: 1,
  pin_reader_mask: 2,
  allow_rf: true,
  weekday_mask: 62,
  start_minute: 360,
  end_minute: 1320,
};

const permiso = (permission_id: number, name: string, id: string = randomUUID()): ContractRow<"permissions"> => ({
  id,
  data: { permission_id, name, ...PERMISO },
});

const asignacion = (holder_id: string, permission_id: number, id: string = randomUUID()): ContractRow<"holder_permissions"> => ({
  id,
  data: { holder_id, permission_id },
});

function salidasDelPanel(ids: string[] = [0, 1, 2, 3].map(() => randomUUID())): ContractRow<"outputs">[] {
  return ids.map((id, i) => ({
    id,
    data: { output_id: i, alias: `Puerta ${i + 1}`, duration_ms: 2500 + i, reader_mask: 1 << i, enabled: i !== 3 },
  }));
}

/** Recorre un valor JSON y devuelve verdadero si alguna clave o valor de texto cumple `pred`. */
function contiene(valor: unknown, pred: (clave: string | null, texto: string | null) => boolean): boolean {
  if (typeof valor === "string") return pred(null, valor);
  if (Array.isArray(valor)) return valor.some((v) => contiene(v, pred));
  if (valor && typeof valor === "object") {
    return Object.entries(valor).some(([k, v]) => pred(k, null) || contiene(v, pred));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

describe("computeImportDiff (puro)", () => {
  const nube: CloudState = {
    holders: [
      { id: "c-ana", kind: "persona", name: "Ana Pérez", pin_lookup: "lookup-ana" },
      { id: "c-beto", kind: "persona", name: "Beto", pin_lookup: null },
      { id: "c-casa", kind: "domicilio", name: "Casa 5", pin_lookup: null },
    ],
    cards: [
      { id: "c-k1001", card_code: 1001, holder_id: "c-ana" },
      { id: "c-k2002", card_code: 2002, holder_id: "c-beto" },
    ],
    controls: [{ id: "c-ctl-beto", holder_id: "c-beto" }],
    control_buttons: [{ id: "c-btn-5555", control_id: "c-ctl-beto", button: 0, rf_code: 5555 }],
    access_profiles: [{ id: "c-perfil-0", local_permission_id: 0 }],
    holder_profiles: [],
  };

  const guardado = (pin_lookup: string | null) => ({
    pin_ciphertext: pin_lookup === null ? null : `cifrado-${pin_lookup}`,
    pin_lookup,
  });

  function snap(): StoredSnapshot {
    const h = (id: string, kind: "persona" | "domicilio", name: string, lookup: string | null) => ({
      id,
      data: { kind, name, department: "", address: "", notes: "", ...guardado(lookup) },
    });
    return {
      holders: [
        h("s-ana", "persona", "  ANA PÉREZ ", "lookup-ana"), // mismo titular y mismo PIN
        h("s-beto", "persona", "beto", "lookup-beto"), // mismo titular; la nube no tiene su PIN
        h("s-casa", "persona", "Casa 5", "lookup-ana"), // otro kind: titular nuevo; PIN de Ana
        h("s-dora", "persona", "Dora", "lookup-dora"), // titular nuevo con PIN libre
      ],
      cards: [
        { id: "s-k1001", data: { card_code: 1001, holder_id: "s-ana", description: "" } }, // ya está, mismo dueño
        { id: "s-k3003", data: { card_code: 3003, holder_id: "s-ana", description: "Nueva" } }, // nueva
        { id: "s-k2002", data: { card_code: 2002, holder_id: "s-ana", description: "" } }, // es de Beto
        { id: "s-k4004", data: { card_code: 4004, holder_id: "s-casa", description: "" } }, // del titular nuevo
      ],
      controls: [
        { id: "s-ctl-beto", data: { holder_id: "s-beto", description: "Control Beto" } }, // ya está (rf 5555)
        { id: "s-ctl-casa", data: { holder_id: "s-casa", description: "Control Casa" } },
      ],
      control_buttons: [
        { id: "s-b1", data: { control_id: "s-ctl-beto", button: 0, rf_code: 5555, output_id: 0 } },
        { id: "s-b2", data: { control_id: "s-ctl-casa", button: 0, rf_code: 5555, output_id: 0 } }, // de Beto
        { id: "s-b3", data: { control_id: "s-ctl-casa", button: 1, rf_code: 6006, output_id: null } },
      ],
      permissions: [],
      holder_permissions: [],
      outputs: [],
    };
  }

  it("aplica los criterios de coincidencia del brief y anida lo de los titulares nuevos", () => {
    const diff = computeImportDiff(nube, snap());
    expect(diff).toEqual<ImportDiff>({
      onlyInPanel: [
        { type: "pin", id: "s-beto", holder_name: "Beto" },
        {
          type: "holder",
          id: "s-casa",
          kind: "persona",
          name: "Casa 5",
          department: "",
          has_pin: false,
          cards: [{ id: "s-k4004", card_code: 4004, description: "" }],
          controls: [
            {
              id: "s-ctl-casa",
              description: "Control Casa",
              buttons: [{ id: "s-b3", button: 1, rf_code: 6006, output_id: null }],
            },
          ],
        },
        {
          type: "holder",
          id: "s-dora",
          kind: "persona",
          name: "Dora",
          department: "",
          has_pin: true,
          cards: [],
          controls: [],
        },
        { type: "card", id: "s-k3003", holder_name: "Ana Pérez", card_code: 3003, description: "Nueva" },
      ],
      conflicts: [
        { type: "pin", id: "s-casa", holder_name: "Casa 5", reason: "El PIN ya lo usa otro titular de la instalación." },
        {
          type: "card",
          id: "s-k2002",
          holder_name: "  ANA PÉREZ ",
          card_code: 2002,
          reason: "La tarjeta 2002 ya es de otro titular (Beto).",
        },
        {
          type: "control_button",
          id: "s-b2",
          holder_name: "Casa 5",
          rf_code: 5555,
          reason: "El código RF 5555 ya es de otro titular (Beto).",
        },
      ],
    });
  });

  it("nunca expone el PIN ni su cifrado o pin_lookup", () => {
    const diff = computeImportDiff(nube, snap());
    expect(
      contiene(diff, (k, t) => k === "pin" || k === "pin_lookup" || k === "pin_ciphertext" || (t ?? "").includes("lookup-")),
    ).toBe(false);
  });

  it("un titular con otro PIN en la nube es conflicto (la importación solo agrega)", () => {
    const s = snap();
    s.holders = [{ ...s.holders[0], data: { ...s.holders[0].data, ...guardado("lookup-otro") } }];
    s.cards = [];
    s.controls = [];
    s.control_buttons = [];
    expect(computeImportDiff(nube, s)).toEqual<ImportDiff>({
      onlyInPanel: [],
      conflicts: [
        { type: "pin", id: "s-ana", holder_name: "  ANA PÉREZ ", reason: "El titular ya tiene otro PIN en la plataforma." },
      ],
    });
  });

  it("dos titulares del panel emparejados con el mismo de la nube: solo el primer PIN se ofrece", () => {
    const s = snap();
    const beto = s.holders[1];
    s.holders = [beto, { id: "s-beto-2", data: { ...beto.data, name: "BETO", ...guardado("lookup-beto-2") } }];
    s.cards = [];
    s.controls = [];
    s.control_buttons = [];
    expect(computeImportDiff(nube, s)).toEqual<ImportDiff>({
      onlyInPanel: [{ type: "pin", id: "s-beto", holder_name: "Beto" }],
      conflicts: [
        { type: "pin", id: "s-beto-2", holder_name: "BETO", reason: "El titular ya tiene otro PIN en la plataforma." },
      ],
    });
  });

  /** Snapshot con un solo titular (sin PIN) y un control con los botones dados. */
  function conControl(
    holder: { id: string; name: string },
    controlId: string,
    botones: [button: number, rf_code: number][],
  ): StoredSnapshot {
    return {
      ...snapshotVacio(),
      holders: [
        { id: holder.id, data: { kind: "persona", name: holder.name, department: "", address: "", notes: "", ...guardado(null) } },
      ],
      controls: [{ id: controlId, data: { holder_id: holder.id, description: "Control" } }],
      control_buttons: botones.map(([button, rf_code]) => ({
        id: `s-b${rf_code}`,
        data: { control_id: controlId, button, rf_code, output_id: 1 },
      })),
    };
  }

  it("caso A: un RF nuevo en un control que la nube ya tiene (otro UUID, mismo titular) se ofrece como botón", () => {
    const s = conControl({ id: "s-beto", name: "Beto" }, "s-ctl", [
      [0, 5555],
      [1, 7777],
    ]);
    expect(computeImportDiff(nube, s)).toEqual<ImportDiff>({
      onlyInPanel: [
        {
          type: "button",
          id: "s-b7777",
          holder_name: "Beto",
          control_description: "Control",
          button: 1,
          rf_code: 7777,
          output_id: 1,
        },
      ],
      conflicts: [],
    });

    // Si ese número de botón ya está ocupado en el control de la nube, es conflicto.
    const ocupada: CloudState = {
      ...nube,
      control_buttons: [...nube.control_buttons, { id: "c-btn-5556", control_id: "c-ctl-beto", button: 1, rf_code: 5556 }],
    };
    expect(computeImportDiff(ocupada, s)).toEqual<ImportDiff>({
      onlyInPanel: [],
      conflicts: [
        {
          type: "control_button",
          id: "s-b7777",
          holder_name: "Beto",
          rf_code: 7777,
          reason: "El botón 1 del control ya tiene otro código RF en la plataforma.",
        },
      ],
    });
  });

  it("caso B: con el mismo UUID de control y el mismo titular, sus RF nuevos se ofrecen como botones", () => {
    const s = conControl({ id: "s-beto", name: "Beto" }, "c-ctl-beto", [[2, 9999]]);
    expect(computeImportDiff(nube, s).onlyInPanel).toEqual([
      {
        type: "button",
        id: "s-b9999",
        holder_name: "Beto",
        control_description: "Control",
        button: 2,
        rf_code: 9999,
        output_id: 1,
      },
    ]);
  });

  it("caso B: con el mismo UUID de control de otro titular, es un control nuevo y sus RF ajenos son conflicto", () => {
    const s = conControl({ id: "s-ana", name: "Ana Pérez" }, "c-ctl-beto", [
      [0, 5555],
      [3, 8888],
    ]);
    expect(computeImportDiff(nube, s)).toEqual<ImportDiff>({
      onlyInPanel: [
        {
          type: "control",
          id: "c-ctl-beto",
          holder_name: "Ana Pérez",
          description: "Control",
          buttons: [{ id: "s-b8888", button: 3, rf_code: 8888, output_id: 1 }],
        },
      ],
      conflicts: [
        {
          type: "control_button",
          id: "s-b5555",
          holder_name: "Ana Pérez",
          rf_code: 5555,
          reason: "El código RF 5555 ya es de otro titular (Beto).",
        },
      ],
    });
  });

  it("dos botones que la nube ya tiene con el mismo número en su control: el segundo es conflicto", () => {
    // En la nube, dos botones vivos del control de Beto comparten el número 0 porque van
    // a paneles distintos; el panel nuevo no puede recibir los dos.
    const compartido: CloudState = {
      ...nube,
      control_buttons: [...nube.control_buttons, { id: "c-btn-5558", control_id: "c-ctl-beto", button: 0, rf_code: 5558 }],
    };
    const s = conControl({ id: "s-beto", name: "Beto" }, "s-ctl", [
      [0, 5555],
      [1, 5558],
    ]);
    expect(computeImportDiff(compartido, s)).toEqual<ImportDiff>({
      onlyInPanel: [],
      conflicts: [
        {
          type: "control_button",
          id: "s-b5558",
          holder_name: "Beto",
          rf_code: 5558,
          reason: "El botón 0 del control ya tiene otro código RF en este panel.",
        },
      ],
    });
  });

  it("un titular con el mismo UUID en la instalación es el mismo aunque cambie el nombre", () => {
    const s: StoredSnapshot = {
      ...snap(),
      holders: [
        { id: "c-beto", data: { kind: "persona", name: "Roberto", department: "", address: "", notes: "", ...guardado(null) } },
      ],
      cards: [{ id: "s-k2002", data: { card_code: 2002, holder_id: "c-beto", description: "" } }],
      controls: [],
      control_buttons: [],
    };
    expect(computeImportDiff(nube, s)).toEqual<ImportDiff>({ onlyInPanel: [], conflicts: [] });
  });

  it(`pasando de ${MAX_PROFILES} perfiles, los permisos sobrantes van a conflicts`, () => {
    const llena: CloudState = {
      ...nube,
      access_profiles: Array.from({ length: 30 }, (_, i) => ({ id: `c-perfil-${i}`, local_permission_id: i })),
    };
    const s: StoredSnapshot = {
      ...snapshotVacioGuardado(),
      permissions: [
        { id: "s-p7", data: { permission_id: 7, name: "Siete", ...PERMISO } },
        { id: "s-p2", data: { permission_id: 2, name: "Dos", ...PERMISO } },
        { id: "c-perfil-4", data: { permission_id: 4, name: "Ya está", ...PERMISO } }, // mismo UUID: no ocupa lugar
        { id: "s-p5", data: { permission_id: 5, name: "Cinco", ...PERMISO } },
      ],
    };
    expect(computeImportDiff(llena, s)).toEqual<ImportDiff>({
      onlyInPanel: [],
      conflicts: [{ type: "permission", id: "s-p7", permission_id: 7, name: "Siete", reason: MAXIMO_PERFILES }],
    });
  });

  function snapshotVacioGuardado(): StoredSnapshot {
    return { ...snapshotVacio(), holders: [] };
  }
});

describe("snapshotProblem (coherencia interna)", () => {
  function base() {
    const s = snapshotVacio();
    const h = titular("persona", "Ana", "1234");
    s.holders.push(h);
    s.cards.push(tarjeta(h.id, 1));
    s.controls.push({ id: randomUUID(), data: { holder_id: h.id, description: "" } });
    s.control_buttons.push({
      id: randomUUID(),
      data: { control_id: s.controls[0].id, button: 0, rf_code: 9, output_id: 0 },
    });
    s.permissions.push(permiso(0, "Residente"));
    s.holder_permissions.push(asignacion(h.id, 0));
    s.outputs.push(...salidasDelPanel());
    return s;
  }

  it("acepta un snapshot coherente", () => {
    expect(snapshotProblem(base())).toBeNull();
  });

  it("rechaza referencias que no están en el snapshot y valores únicos repetidos", () => {
    const sinTitular = base();
    sinTitular.cards.push(tarjeta(randomUUID(), 2));
    expect(snapshotProblem(sinTitular)).toMatch(/titular que no está en el snapshot/);

    const sinControl = base();
    sinControl.control_buttons[0].data.control_id = randomUUID();
    expect(snapshotProblem(sinControl)).toMatch(/control que no está en el snapshot/);

    const sinPermiso = base();
    sinPermiso.holder_permissions[0].data.permission_id = 9;
    expect(snapshotProblem(sinPermiso)).toMatch(/permiso que no está en el snapshot/);

    const tarjetaRepetida = base();
    tarjetaRepetida.cards.push(tarjeta(tarjetaRepetida.holders[0].id, 1));
    expect(snapshotProblem(tarjetaRepetida)).toMatch(/Código de tarjeta repetido: 1/);

    const pinRepetido = base();
    pinRepetido.holders.push(titular("persona", "Beto", "1234"));
    const problema = snapshotProblem(pinRepetido);
    expect(problema).toMatch(/PIN repetido/);
    expect(problema).not.toContain("1234");

    const idRepetido = base();
    idRepetido.cards.push(tarjeta(idRepetido.holders[0].id, 3, idRepetido.cards[0].id));
    expect(snapshotProblem(idRepetido)).toMatch(/Identificador repetido en cards/);
  });
});

// ---------------------------------------------------------------------------
// Integración
// ---------------------------------------------------------------------------

interface PanelPrueba {
  id: string;
  code: string;
  token: string;
}

function peticion(panel: PanelPrueba | null, cuerpo: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (panel) headers.authorization = `Device ${panel.code}.${panel.token}`;
  return new Request(`${URL_BASE}/import-snapshot`, {
    method: "POST",
    headers,
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
}

const subir = (panel: PanelPrueba, tables: SnapshotTables) => importSnapshot(peticion(panel, { tables }));

describe("importación al vincular (POST /import-snapshot y confirmImport)", () => {
  const corrida = base32(6).toLowerCase();
  const password = `Prueba-${randomBytes(12).toString("hex")}`;
  const correo = (rol: string) => `${rol}-imp-${corrida}@pruebas.local`;
  const claves = { enc: process.env.PIN_ENC_KEY, lookup: process.env.PIN_LOOKUP_KEY };

  let admin: SupabaseClient;
  const usuarios: string[] = [];
  const tenants: string[] = [];
  const paneles: string[] = [];

  let clienteAdminA: SupabaseClient;
  let clienteTecnicoA: SupabaseClient;
  let clienteAdminB: SupabaseClient;

  let tenantA: string;
  let instVacia: string;
  let instRemap: string;
  let instDatos: string;
  let inst32: string;
  let instB: string;
  let instVinculos: string;

  let pVacio: PanelPrueba;
  let pRemap: PanelPrueba;
  let pDatos: PanelPrueba;
  let pDatos2: PanelPrueba;
  let pRelink: PanelPrueba;
  let pFusion: PanelPrueba;
  let pMigrado: PanelPrueba;
  let pActivo: PanelPrueba;
  let p32: PanelPrueba;
  let pVinculos: PanelPrueba;
  let pVinculosOtro: PanelPrueba;

  // instDatos
  const PIN_ANA = "731864";
  let ana: string;
  let beto: string;
  let residente: string;
  let controlBeto: string; // botones 0 = RF 5555 y 2 = RF 5557
  let boton5555: string;
  let boton5557: string;
  let controlFer: string; // lo crea la importación de pDatos2
  const salidasNubeDatos: string[] = [];
  // instB (otro tenant): sus UUID reaparecen en el snapshot de pRemap (Riesgo 4)
  let xavier: string;
  let tarjetaX: string;
  const salidasNubeB: string[] = [];
  let filaXavierAntes: Fila;
  // inst32
  let eva: string;

  const autor = () => ({ updated_at: new Date().toISOString(), updated_by: "prueba", origin: "cloud" });

  async function insertar(tabla: string, fila: Fila): Promise<string> {
    const { data, error } = await admin
      .from(tabla)
      .insert({ ...fila, ...autor() })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    return data.id;
  }

  async function fila(tabla: string, id: string): Promise<Fila | null> {
    const { data, error } = await admin.from(tabla).select("*").eq("id", id).maybeSingle<Fila>();
    if (error) throw error;
    return data;
  }

  async function filasDe(tabla: string, columna: string, valor: string): Promise<Fila[]> {
    const { data, error } = await admin.from(tabla).select("*").eq(columna, valor).order("id");
    if (error) throw error;
    return data as Fila[];
  }

  /** Vínculos vivos botón–panel de un panel, ordenados por botón. */
  async function vinculosDe(panel: PanelPrueba): Promise<Fila[]> {
    const { data, error } = await admin
      .from("control_button_panels")
      .select("button_id, output_index, installation_id, origin, updated_by")
      .eq("panel_id", panel.id)
      .is("deleted_at", null)
      .order("button_id");
    if (error) throw error;
    return data as Fila[];
  }

  async function estadoDe(panel: PanelPrueba): Promise<string> {
    const p = await fila("panels", panel.id);
    return p!.status as string;
  }

  async function importacionDe(panel: PanelPrueba): Promise<Fila | null> {
    const { data, error } = await admin.from("panel_imports").select("*").eq("panel_id", panel.id).maybeSingle<Fila>();
    if (error) throw error;
    return data;
  }

  async function crearPanel(installationId: string, status: string): Promise<PanelPrueba> {
    const panel = { code: `PNL-${base32(4)}-${base32(4)}`, token: randomBytes(32).toString("base64url") };
    const { data, error } = await admin
      .from("panels")
      .insert({
        panel_code: panel.code,
        panel_secret_hash: sha256(randomBytes(32).toString("hex")),
        device_token_hash: sha256(panel.token),
        installation_id: installationId,
        status,
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw error;
    paneles.push(data.id);
    return { ...panel, id: data.id };
  }

  async function crearSalidasNube(panelId: string, installationId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const i of [0, 1, 2, 3]) {
      ids.push(
        await insertar("outputs", {
          installation_id: installationId,
          panel_id: panelId,
          output_index: i,
          alias: `Nube ${i}`,
          duration_ms: 1000,
          reader_mask: 15,
          enabled: true,
        }),
      );
    }
    return ids;
  }

  const origenDe = (panel: PanelPrueba) => `panel:${panel.code}`;

  beforeAll(async () => {
    requireLocalSupabase();
    admin = localAdmin();
    process.env.PIN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.PIN_LOOKUP_KEY = randomBytes(32).toString("base64");

    const [adminA, tecnicoA, adminB] = await Promise.all([
      createLocalUser(admin, correo("admin-a"), password),
      createLocalUser(admin, correo("tecnico-a"), password),
      createLocalUser(admin, correo("admin-b"), password),
    ]);
    usuarios.push(adminA, tecnicoA, adminB);

    const { data: ts, error: e1 } = await admin
      .from("tenants")
      .insert([{ name: `Imp A ${corrida}` }, { name: `Imp B ${corrida}` }])
      .select("id, name");
    if (e1) throw e1;
    tenantA = ts.find((t) => t.name.startsWith("Imp A"))!.id;
    const tenantB = ts.find((t) => t.name.startsWith("Imp B"))!.id;
    tenants.push(tenantA, tenantB);

    const { error: e2 } = await admin.from("tenant_members").insert([
      { tenant_id: tenantA, user_id: adminA, role: "admin" },
      { tenant_id: tenantA, user_id: tecnicoA, role: "tecnico" },
      { tenant_id: tenantB, user_id: adminB, role: "admin" },
    ]);
    if (e2) throw e2;

    const nombres = ["Vacia", "Remap", "Datos", "32", "B", "Vinculos"].map((n) => `Fracc ${n} ${corrida}`);
    const { data: is, error: e3 } = await admin
      .from("installations")
      .insert(nombres.map((name) => ({ tenant_id: name.startsWith("Fracc B") ? tenantB : tenantA, name })))
      .select("id, name");
    if (e3) throw e3;
    [instVacia, instRemap, instDatos, inst32, instB, instVinculos] = nombres.map(
      (n) => is.find((i) => i.name === n)!.id,
    );

    pVacio = await crearPanel(instVacia, "staging");
    pRemap = await crearPanel(instRemap, "staging");
    pDatos = await crearPanel(instDatos, "staging");
    pDatos2 = await crearPanel(instDatos, "staging");
    pRelink = await crearPanel(instDatos, "staging");
    pFusion = await crearPanel(instDatos, "staging");
    pMigrado = await crearPanel(instDatos, "staging");
    pActivo = await crearPanel(instDatos, "active");
    p32 = await crearPanel(inst32, "staging");
    pVinculos = await crearPanel(instVinculos, "staging");
    pVinculosOtro = await crearPanel(instVinculos, "active");
    const pB = await crearPanel(instB, "active");

    // instDatos: Ana (con PIN) y Beto, sus tarjetas y el perfil Residente (0).
    const d = { installation_id: instDatos };
    ana = await insertar("holders", {
      ...d,
      kind: "persona",
      name: "Ana Pérez",
      pin_ciphertext: encryptPin(PIN_ANA),
      pin_lookup: pinLookup(instDatos, PIN_ANA),
    });
    beto = await insertar("holders", { ...d, kind: "persona", name: "Beto" });
    await insertar("cards", { ...d, card_code: 1001, holder_id: ana, description: "" });
    await insertar("cards", { ...d, card_code: 2002, holder_id: beto, description: "" });
    residente = await insertar("access_profiles", { ...d, name: "Residente", local_permission_id: 0 });
    await insertar("holder_profiles", { ...d, holder_id: ana, profile_id: residente });
    controlBeto = await insertar("controls", { ...d, holder_id: beto, description: "Control Beto" });
    // Los botones de la nube van al panel activo con S1; los paneles en staging no tienen vínculos.
    boton5555 = await insertar("control_buttons", { ...d, control_id: controlBeto, button: 0, rf_code: 5555 });
    boton5557 = await insertar("control_buttons", { ...d, control_id: controlBeto, button: 2, rf_code: 5557 });
    for (const button_id of [boton5555, boton5557]) {
      await insertar("control_button_panels", { ...d, button_id, panel_id: pActivo.id, output_index: 0 });
    }
    // pDatos ya tenía salidas vivas en esta instalación (se vinculó antes).
    salidasNubeDatos.push(...(await crearSalidasNube(pDatos.id, instDatos)));

    // instB (otro tenant).
    const b = { installation_id: instB };
    xavier = await insertar("holders", { ...b, kind: "persona", name: "Xavier" });
    tarjetaX = await insertar("cards", { ...b, card_code: 5005, holder_id: xavier, description: "" });
    salidasNubeB.push(...(await crearSalidasNube(pB.id, instB)));
    filaXavierAntes = (await fila("holders", xavier))!;

    // inst32: 31 perfiles vivos (0..30) y Eva.
    const { error: e4 } = await admin.from("access_profiles").insert(
      Array.from({ length: 31 }, (_, i) => ({
        installation_id: inst32,
        name: `Perfil ${i}`,
        local_permission_id: i,
        ...autor(),
      })),
    );
    if (e4) throw e4;
    eva = await insertar("holders", { installation_id: inst32, kind: "persona", name: "Eva" });

    [clienteAdminA, clienteTecnicoA, clienteAdminB] = await Promise.all([
      signInLocal(correo("admin-a"), password),
      signInLocal(correo("tecnico-a"), password),
      signInLocal(correo("admin-b"), password),
    ]);
  });

  afterAll(async () => {
    for (const [k, v] of [
      ["PIN_ENC_KEY", claves.enc],
      ["PIN_LOOKUP_KEY", claves.lookup],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!admin) return;
    // Salidas, reglas y vínculos referencian a los paneles; los paneles a las instalaciones
    // (y borran en cascada sus panel_imports); los tenants borran en cascada instalaciones,
    // datos replicados, miembros y auditoría.
    if (paneles.length) {
      for (const tabla of ["outputs", "profile_panel_rules", "control_button_panels"]) {
        const { error } = await admin.from(tabla).delete().in("panel_id", paneles);
        if (error) throw error;
      }
      const { error } = await admin.from("panels").delete().in("id", paneles);
      if (error) throw error;
    }
    if (tenants.length) {
      const { error } = await admin.from("tenants").delete().in("id", tenants);
      if (error) throw error;
    }
    await Promise.all(usuarios.map((id) => admin.auth.admin.deleteUser(id)));
  });

  describe("instalación vacía", () => {
    it("importa todo con los mismos UUID, como cambios del panel, y queda active", async () => {
      const s = snapshotVacio();
      const carla = titular("persona", "Carla", "4321");
      const casa = titular("domicilio", "Casa 7");
      s.holders.push(carla, casa);
      s.cards.push(tarjeta(carla.id, 7001), tarjeta(carla.id, 7002), tarjeta(casa.id, 7003));
      const control = { id: randomUUID(), data: { holder_id: casa.id, description: "Control Casa 7" } };
      s.controls.push(control);
      const boton = { id: randomUUID(), data: { control_id: control.id, button: 1, rf_code: 9001, output_id: 2 } };
      s.control_buttons.push(boton);
      const peatonal = permiso(3, "Peatonal");
      s.permissions.push(peatonal);
      const hp = asignacion(carla.id, 3);
      s.holder_permissions.push(hp);
      s.outputs.push(...salidasDelPanel());

      const res = await subir(pVacio, s);
      expect(res.status).toBe(202);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ status: "active" });
      expect(await estadoDe(pVacio)).toBe("active");
      expect(await importacionDe(pVacio)).toBeNull();

      const comoPanel = { installation_id: instVacia, origin: origenDe(pVacio), updated_by: origenDe(pVacio), deleted_at: null };
      const h = await fila("holders", carla.id);
      expect(h).toMatchObject({ ...comoPanel, kind: "persona", name: "Carla", has_pin: true });
      expect(decryptPin(h!.pin_ciphertext as string)).toBe("4321");
      expect(h!.pin_lookup).toBe(pinLookup(instVacia, "4321"));
      expect(await fila("holders", casa.id)).toMatchObject({ ...comoPanel, kind: "domicilio", has_pin: false });
      for (const k of s.cards) {
        expect(await fila("cards", k.id)).toMatchObject({ ...comoPanel, ...k.data });
      }
      expect(await fila("controls", control.id)).toMatchObject({ ...comoPanel, holder_id: casa.id });
      expect(await fila("control_buttons", boton.id)).toMatchObject({
        ...comoPanel,
        control_id: control.id,
        button: 1,
        rf_code: 9001,
      });
      expect(await vinculosDe(pVacio)).toEqual([
        { button_id: boton.id, output_index: 2, installation_id: instVacia, origin: origenDe(pVacio), updated_by: origenDe(pVacio) },
      ]);
      expect(await fila("access_profiles", peatonal.id)).toMatchObject({
        ...comoPanel,
        name: "Peatonal",
        local_permission_id: 3,
      });
      const reglas = await filasDe("profile_panel_rules", "profile_id", peatonal.id);
      expect(reglas).toHaveLength(1);
      expect(reglas[0]).toMatchObject({ ...comoPanel, panel_id: pVacio.id, ...PERMISO });
      expect(await fila("holder_profiles", hp.id)).toMatchObject({
        ...comoPanel,
        holder_id: carla.id,
        profile_id: peatonal.id,
      });
      for (const o of s.outputs) {
        const { output_id, ...resto } = o.data;
        expect(await fila("outputs", o.id)).toMatchObject({
          ...comoPanel,
          panel_id: pVacio.id,
          output_index: output_id,
          ...resto,
        });
      }
    });

    it("importar un panel a una instalación vacía vincula sus botones solo a ese panel", async () => {
      const s = snapshotVacio();
      const ines = titular("persona", "Inés");
      s.holders.push(ines);
      const control = { id: randomUUID(), data: { holder_id: ines.id, description: "Control Inés" } };
      s.controls.push(control);
      const conSalida = { id: randomUUID(), data: { control_id: control.id, button: 0, rf_code: 9101, output_id: 1 } };
      const sinSalida = { id: randomUUID(), data: { control_id: control.id, button: 1, rf_code: 9102, output_id: null } };
      s.control_buttons.push(conSalida, sinSalida);
      s.outputs.push(...salidasDelPanel());

      expect(await (await subir(pVinculos, s)).json()).toEqual({ status: "active" });

      const comoPanel = { installation_id: instVinculos, origin: origenDe(pVinculos), updated_by: origenDe(pVinculos) };
      const esperados = [
        { button_id: conSalida.id, output_index: 1, ...comoPanel },
        { button_id: sinSalida.id, output_index: null, ...comoPanel },
      ].sort((a, b) => (a.button_id < b.button_id ? -1 : 1));
      expect(await vinculosDe(pVinculos)).toEqual(esperados);
      // El otro panel de la instalación no recibe vínculos automáticos.
      expect(await vinculosDe(pVinculosOtro)).toEqual([]);
    });

    it("con el panel fuera de staging responde 409 y no cambia nada", async () => {
      const s = snapshotVacio();
      const otro = titular("persona", "No entra");
      s.holders.push(otro);
      for (const panel of [pVacio, pActivo]) {
        const res = await subir(panel, s);
        expect(res.status).toBe(409);
        const cuerpo = await res.json();
        expect(cuerpo.code).toBe("not_staging");
        expect(typeof cuerpo.message).toBe("string");
      }
      expect(await fila("holders", otro.id)).toBeNull();
      expect(await estadoDe(pActivo)).toBe("active");
    });

    it("sin credencial responde 401 y con un snapshot incoherente o incompleto 400", async () => {
      expect((await importSnapshot(peticion(null, { tables: snapshotVacio() }))).status).toBe(401);

      const incoherente = snapshotVacio();
      incoherente.cards.push(tarjeta(randomUUID(), 1));
      const r1 = await subir(pRemap, incoherente);
      expect(r1.status).toBe(400);
      expect(await r1.json()).toMatchObject({ code: "invalid_snapshot" });

      const incompleto: Partial<SnapshotTables> = snapshotVacio();
      delete incompleto.outputs;
      const r2 = await importSnapshot(peticion(pRemap, { tables: incompleto }));
      expect(r2.status).toBe(400);
      expect(await r2.json()).toMatchObject({ code: "invalid_body" });

      expect(await estadoDe(pRemap)).toBe("staging");
    });

    it("Riesgo 4: un UUID que ya existe en otra instalación recibe uno nuevo y no toca la otra", async () => {
      const s = snapshotVacio();
      const diego = titular("persona", "Diego", null, xavier); // UUID de un titular de instB
      s.holders.push(diego);
      s.cards.push(tarjeta(xavier, 5005, tarjetaX)); // UUID y código de una tarjeta de instB
      s.controls.push({ id: randomUUID(), data: { holder_id: xavier, description: "Control Diego" } });
      const p = permiso(1, "General");
      s.permissions.push(p);
      s.holder_permissions.push(asignacion(xavier, 1));
      s.outputs.push(...salidasDelPanel(salidasNubeB)); // UUID de las salidas de otro panel

      const res = await subir(pRemap, s);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "active" });

      const [h] = await filasDe("holders", "installation_id", instRemap);
      expect(h).toMatchObject({ name: "Diego", origin: origenDe(pRemap) });
      expect(h.id).not.toBe(xavier);
      const [k] = await filasDe("cards", "installation_id", instRemap);
      expect(k).toMatchObject({ card_code: 5005, holder_id: h.id });
      expect(k.id).not.toBe(tarjetaX);
      const [c] = await filasDe("controls", "installation_id", instRemap);
      expect(c.holder_id).toBe(h.id);
      const [hp] = await filasDe("holder_profiles", "installation_id", instRemap);
      expect(hp).toMatchObject({ holder_id: h.id, profile_id: p.id });
      const salidas = await filasDe("outputs", "installation_id", instRemap);
      expect(salidas).toHaveLength(4);
      for (const o of salidas) {
        expect(o.panel_id).toBe(pRemap.id);
        expect(salidasNubeB).not.toContain(o.id);
      }

      // La otra instalación queda igual.
      expect(await fila("holders", xavier)).toEqual(filaXavierAntes);
      expect(await fila("cards", tarjetaX)).toMatchObject({ installation_id: instB, holder_id: xavier });
      for (const id of salidasNubeB) {
        expect(await fila("outputs", id)).toMatchObject({ installation_id: instB, alias: expect.stringMatching(/^Nube /) });
      }
    });
  });

  describe("instalación con datos", () => {
    // Snapshot de pDatos: Ana (mismo PIN, nombre en mayúsculas) con una tarjeta nueva
    // (3003) y una cuyo código ya es de Beto (2002); el permiso Caseta (0) asignado a Ana.
    const sAna = titular("persona", "ANA PÉREZ", PIN_ANA);
    const nueva = tarjeta(sAna.id, 3003);
    const deBeto = tarjeta(sAna.id, 2002);
    const caseta = permiso(0, "Caseta");
    const casetaAna = asignacion(sAna.id, 0);
    const salidasPanel = salidasDelPanel();

    function snapshotDatos(): SnapshotTables {
      return {
        ...snapshotVacio(),
        holders: [sAna],
        cards: [nueva, deBeto],
        permissions: [caseta],
        holder_permissions: [casetaAna],
        outputs: salidasPanel,
      };
    }

    it("queda awaiting_review con 1 en onlyInPanel y 1 en conflicts", async () => {
      const res = await subir(pDatos, snapshotDatos());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "awaiting_review" });
      expect(await estadoDe(pDatos)).toBe("awaiting_review");

      const importacion = await importacionDe(pDatos);
      const diff = importacion!.diff as ImportDiff;
      expect(diff.onlyInPanel).toEqual([
        { type: "card", id: nueva.id, holder_name: "Ana Pérez", card_code: 3003, description: "Tarjeta 3003" },
      ]);
      expect(diff.conflicts).toEqual([
        {
          type: "card",
          id: deBeto.id,
          holder_name: "ANA PÉREZ",
          card_code: 2002,
          reason: "La tarjeta 2002 ya es de otro titular (Beto).",
        },
      ]);
      // Nada se escribió todavía en las tablas replicadas.
      expect(await fila("cards", nueva.id)).toBeNull();
      expect(await fila("access_profiles", caseta.id)).toBeNull();
    });

    it("el snapshot guardado no tiene el PIN en claro: lo guarda cifrado con su pin_lookup", async () => {
      const importacion = await importacionDe(pDatos);
      const snapshot = importacion!.snapshot as StoredSnapshot;
      expect(contiene(snapshot, (k, t) => k === "pin" || t === PIN_ANA)).toBe(false);
      const [h] = snapshot.holders;
      expect(decryptPin(h.data.pin_ciphertext!)).toBe(PIN_ANA);
      expect(h.data.pin_lookup).toBe(pinLookup(instDatos, PIN_ANA));
      expect(contiene(importacion!.diff, (k, t) => k === "pin_lookup" || t === h.data.pin_lookup)).toBe(false);
    });

    it("un miembro lee el diff (sin PIN); otro tenant no lo ve", async () => {
      const diff = await readImportDiffAs(clienteTecnicoA, pDatos.id);
      expect(diff.onlyInPanel.map((x) => x.id)).toEqual([nueva.id]);
      expect(diff.conflicts.map((x) => x.id)).toEqual([deBeto.id]);
      expect(contiene(diff, (k) => k === "pin" || k === "pin_lookup" || k === "pin_ciphertext")).toBe(false);
      await expect(readImportDiffAs(clienteAdminB, pDatos.id)).rejects.toMatchObject({ status: 404 });
      await expect(readImportDiffAs(clienteAdminA, pActivo.id)).rejects.toMatchObject({ status: 404 });
    });

    it("un técnico no puede confirmar la importación (403) ni otro tenant (404)", async () => {
      await expect(confirmImportAs(clienteTecnicoA, pDatos.id, [nueva.id])).rejects.toMatchObject({
        status: 403,
        message: "No tienes permiso para esta acción.",
      });
      await expect(confirmImportAs(clienteAdminB, pDatos.id, [nueva.id])).rejects.toMatchObject({ status: 404 });
      expect(await estadoDe(pDatos)).toBe("awaiting_review");
      expect(await fila("cards", nueva.id)).toBeNull();
    });

    it("confirmImport importa la nueva y no la conflictiva, reutiliza al titular y deja active", async () => {
      const r = await confirmImportAs(clienteAdminA, pDatos.id, [nueva.id, deBeto.id, nueva.id]);
      expect(r).toEqual({ imported: [nueva.id], ignored: [deBeto.id] });
      expect(await estadoDe(pDatos)).toBe("active");
      expect(await importacionDe(pDatos)).toBeNull();

      // La tarjeta nueva, con su UUID, en la Ana de la nube; la conflictiva no entra.
      expect(await fila("cards", nueva.id)).toMatchObject({
        installation_id: instDatos,
        holder_id: ana,
        card_code: 3003,
        origin: origenDe(pDatos),
        updated_by: origenDe(pDatos),
        deleted_at: null,
      });
      expect(await fila("cards", deBeto.id)).toBeNull();
      const tarjetas2002 = (await filasDe("cards", "installation_id", instDatos)).filter((k) => k.card_code === 2002);
      expect(tarjetas2002).toHaveLength(1);
      expect(tarjetas2002[0].holder_id).toBe(beto);

      // El titular con el mismo nombre se reutiliza en lugar de duplicarse.
      const titulares = await filasDe("holders", "installation_id", instDatos);
      expect(titulares.map((h) => h.id).sort()).toEqual([ana, beto].sort());
      expect(await fila("holders", sAna.id)).toBeNull();

      // El permiso local es un perfil nuevo con el menor local_permission_id libre (1),
      // regla solo en este panel y asignado a la Ana de la nube.
      expect(await fila("access_profiles", caseta.id)).toMatchObject({
        installation_id: instDatos,
        name: "Caseta",
        local_permission_id: 1,
        origin: origenDe(pDatos),
      });
      expect(await fila("access_profiles", residente)).toMatchObject({ local_permission_id: 0, deleted_at: null });
      const reglas = await filasDe("profile_panel_rules", "profile_id", caseta.id);
      expect(reglas).toHaveLength(1);
      expect(reglas[0]).toMatchObject({ panel_id: pDatos.id, ...PERMISO });
      expect(await fila("holder_profiles", casetaAna.id)).toMatchObject({ holder_id: ana, profile_id: caseta.id });

      // Las salidas del panel se importan sobre las que ya tenía en la nube.
      const salidas = (await filasDe("outputs", "panel_id", pDatos.id)).filter((o) => o.deleted_at === null);
      expect(salidas.map((o) => o.id).sort()).toEqual([...salidasNubeDatos].sort());
      for (const o of salidas) {
        const local = salidasPanel.find((x) => x.data.output_id === o.output_index)!;
        expect(o).toMatchObject({
          alias: local.data.alias,
          duration_ms: local.data.duration_ms,
          reader_mask: local.data.reader_mask,
          enabled: local.data.enabled,
          origin: origenDe(pDatos),
        });
      }
    });

    it("confirmar otra vez responde 409", async () => {
      await expect(confirmImportAs(clienteAdminA, pDatos.id, [nueva.id])).rejects.toMatchObject({ status: 409 });
    });

    it("un titular nuevo seleccionado entra con su PIN, tarjetas y controles; el PIN libre de uno existente también", async () => {
      const s = snapshotVacio();
      const sBeto = titular("persona", "beto", "5150"); // Beto en la nube no tiene PIN
      const fer = titular("persona", "Fer", "8080");
      const gil = titular("domicilio", "Gil");
      s.holders.push(sBeto, fer, gil);
      const kFer = tarjeta(fer.id, 6006);
      const kGil = tarjeta(gil.id, 6007);
      s.cards.push(kFer, kGil);
      const control = { id: randomUUID(), data: { holder_id: fer.id, description: "Control Fer" } };
      controlFer = control.id;
      s.controls.push(control);
      const boton = { id: randomUUID(), data: { control_id: control.id, button: 2, rf_code: 7007, output_id: null } };
      s.control_buttons.push(boton);
      s.outputs.push(...salidasDelPanel());

      expect(await (await subir(pDatos2, s)).json()).toEqual({ status: "awaiting_review" });
      const diff = await readImportDiffAs(clienteAdminA, pDatos2.id);
      expect(diff.onlyInPanel.map((i) => [i.type, i.id])).toEqual([
        ["pin", sBeto.id],
        ["holder", fer.id],
        ["holder", gil.id],
      ]);
      expect(diff.conflicts).toEqual([]);

      const r = await confirmImportAs(clienteAdminA, pDatos2.id, [sBeto.id, fer.id]);
      expect(r).toEqual({ imported: [sBeto.id, fer.id], ignored: [] });
      expect(await estadoDe(pDatos2)).toBe("active");

      const comoPanel = { installation_id: instDatos, origin: origenDe(pDatos2), deleted_at: null };
      const b = await fila("holders", beto);
      expect(b).toMatchObject({ ...comoPanel, name: "Beto", has_pin: true });
      expect(decryptPin(b!.pin_ciphertext as string)).toBe("5150");
      const f = await fila("holders", fer.id);
      expect(f).toMatchObject({ ...comoPanel, name: "Fer", has_pin: true });
      expect(f!.pin_lookup).toBe(pinLookup(instDatos, "8080"));
      expect(await fila("cards", kFer.id)).toMatchObject({ ...comoPanel, holder_id: fer.id, card_code: 6006 });
      expect(await fila("controls", control.id)).toMatchObject({ ...comoPanel, holder_id: fer.id });
      expect(await fila("control_buttons", boton.id)).toMatchObject({
        ...comoPanel,
        control_id: control.id,
        rf_code: 7007,
      });
      expect(await vinculosDe(pDatos2)).toEqual([
        { button_id: boton.id, output_index: null, installation_id: instDatos, origin: origenDe(pDatos2), updated_by: origenDe(pDatos2) },
      ]);
      // Lo no seleccionado no entra.
      expect(await fila("holders", gil.id)).toBeNull();
      expect(await fila("cards", kGil.id)).toBeNull();
    });

    it("al re-vincular: perfiles con el mismo UUID se asignan (unión) y los RF nuevos se agregan al control de la nube", async () => {
      // El panel ya estuvo vinculado: trae los UUID de la nube (Ana, Beto, Residente y el
      // control de Beto) y un residente nuevo, Hugo, dado de alta en la web local.
      const s = snapshotVacio();
      const sAna = titular("persona", "Ana Pérez", PIN_ANA, ana);
      const sBeto = titular("persona", "Beto", null, beto);
      const hugo = titular("persona", "Hugo");
      s.holders.push(sAna, sBeto, hugo);
      s.permissions.push(permiso(0, "Residente", residente));
      const [hpAna, hpBeto, hpHugo] = [asignacion(ana, 0), asignacion(beto, 0), asignacion(hugo.id, 0)];
      s.holder_permissions.push(hpAna, hpBeto, hpHugo);
      // Control de Beto (mismo UUID): 0 = 5555 ya está, 1 = 7777 es nuevo y 2 = 7778 choca
      // con el 2 = 5557 de la nube.
      s.controls.push({ id: controlBeto, data: { holder_id: beto, description: "Control Beto" } });
      const b7777 = { id: randomUUID(), data: { control_id: controlBeto, button: 1, rf_code: 7777, output_id: 1 } };
      const b7778 = { id: randomUUID(), data: { control_id: controlBeto, button: 2, rf_code: 7778, output_id: null } };
      s.control_buttons.push(
        { id: randomUUID(), data: { control_id: controlBeto, button: 0, rf_code: 5555, output_id: 3 } },
        b7777,
        b7778,
      );
      // Control de Hugo con el UUID del control de Fer: es otro control; 7007 es de Fer.
      s.controls.push({ id: controlFer, data: { holder_id: hugo.id, description: "Control Hugo" } });
      const b9100 = { id: randomUUID(), data: { control_id: controlFer, button: 1, rf_code: 9100, output_id: 0 } };
      s.control_buttons.push(
        { id: randomUUID(), data: { control_id: controlFer, button: 0, rf_code: 7007, output_id: 0 } },
        b9100,
      );
      s.outputs.push(...salidasDelPanel());
      const perfilesAntes = (await filasDe("access_profiles", "installation_id", instDatos)).length;
      const controlFerAntes = await fila("controls", controlFer);

      expect(await (await subir(pRelink, s)).json()).toEqual({ status: "awaiting_review" });
      const diff = await readImportDiffAs(clienteAdminA, pRelink.id);
      expect(diff.onlyInPanel.map((i) => [i.type, i.id])).toEqual([
        ["holder", hugo.id],
        ["button", b7777.id],
      ]);
      expect(diff.conflicts.map((c) => [c.type, c.id, c.reason])).toEqual([
        ["control_button", b7778.id, "El botón 2 del control ya tiene otro código RF en la plataforma."],
        ["control_button", s.control_buttons[3].id, "El código RF 7007 ya es de otro titular (Fer)."],
      ]);

      const r = await confirmImportAs(clienteAdminA, pRelink.id, [hugo.id, b7777.id]);
      expect(r).toEqual({ imported: [hugo.id, b7777.id], ignored: [] });

      // Hugo entra con su permiso "Residente" (el perfil vivo con el mismo UUID).
      expect(await fila("holders", hugo.id)).toMatchObject({ installation_id: instDatos, name: "Hugo" });
      expect(await fila("holder_profiles", hpHugo.id)).toMatchObject({ holder_id: hugo.id, profile_id: residente });
      // Unión: Beto recibe la asignación que la nube no tenía; Ana no se duplica.
      expect(await fila("holder_profiles", hpBeto.id)).toMatchObject({ holder_id: beto, profile_id: residente });
      const deAna = (await filasDe("holder_profiles", "holder_id", ana)).filter(
        (a) => a.profile_id === residente && a.deleted_at === null,
      );
      expect(deAna).toHaveLength(1);
      expect(await fila("holder_profiles", hpAna.id)).toBeNull();
      // Ningún perfil nuevo.
      expect(await filasDe("access_profiles", "installation_id", instDatos)).toHaveLength(perfilesAntes);

      // El botón nuevo se agrega al control de Beto de la nube; el que chocaba, no.
      expect(await fila("control_buttons", b7777.id)).toMatchObject({
        installation_id: instDatos,
        control_id: controlBeto,
        button: 1,
        rf_code: 7777,
        origin: origenDe(pRelink),
      });
      expect(await fila("control_buttons", b7778.id)).toBeNull();
      // Vínculos con pRelink: el 5555 que ya estaba (con su salida local), el 7777 y el 9100
      // nuevos; el 5557 de la nube (que el panel no tiene) y el 7007 de Fer, no.
      expect((await vinculosDe(pRelink)).map((v) => [v.button_id, v.output_index]).sort()).toEqual(
        [
          [boton5555, 3],
          [b7777.id, 1],
          [b9100.id, 0],
        ].sort(),
      );

      // El control de Hugo es otro (UUID nuevo) con solo su botón libre; el de Fer no cambia.
      const [ctlHugo] = await filasDe("controls", "holder_id", hugo.id);
      expect(ctlHugo.id).not.toBe(controlFer);
      const botonesHugo = await filasDe("control_buttons", "control_id", ctlHugo.id as string);
      expect(botonesHugo.map((b) => [b.id, b.rf_code])).toEqual([[b9100.id, 9100]]);
      expect(await fila("controls", controlFer)).toEqual(controlFerAntes);
      expect((await filasDe("control_buttons", "control_id", controlFer)).map((b) => b.rf_code)).toEqual([7007]);
    });
  });

  describe("vínculos de los botones que la nube ya tiene", () => {
    // pFusion trae el control de Beto con otro UUID y solo el RF 5557 (que la nube ya tiene
    // en el control de Beto) con la salida S4.
    const sBeto = titular("persona", "Beto");
    const control = { id: randomUUID(), data: { holder_id: sBeto.id, description: "Control de Beto" } };
    const b5557 = { id: randomUUID(), data: { control_id: control.id, button: 2, rf_code: 5557, output_id: 3 } };

    it("un botón que la nube ya tiene con el mismo titular queda vinculado al panel nuevo con su salida local", async () => {
      const s = snapshotVacio();
      s.holders.push(sBeto);
      s.controls.push(control);
      s.control_buttons.push(b5557);
      s.outputs.push(...salidasDelPanel());

      expect(await (await subir(pFusion, s)).json()).toEqual({ status: "awaiting_review" });
      // No es una diferencia: no se ofrece ni es conflicto.
      expect(await readImportDiffAs(clienteAdminA, pFusion.id)).toEqual<ImportDiff>({ onlyInPanel: [], conflicts: [] });

      expect(await confirmImportAs(clienteAdminA, pFusion.id, [])).toEqual({ imported: [], ignored: [] });
      expect(await estadoDe(pFusion)).toBe("active");
      expect(await vinculosDe(pFusion)).toEqual([
        { button_id: boton5557, output_index: 3, installation_id: instDatos, origin: origenDe(pFusion), updated_by: origenDe(pFusion) },
      ]);
      // El botón compartido no cambia ni se duplica, y el panel activo conserva su vínculo.
      expect(await fila("control_buttons", b5557.id)).toBeNull();
      expect(await fila("control_buttons", boton5557)).toMatchObject({ control_id: controlBeto, button: 2, deleted_at: null });
      expect(await fila("controls", control.id)).toBeNull();
      expect((await vinculosDe(pActivo)).find((v) => v.button_id === boton5557)).toMatchObject({ output_index: 0 });
    });

    it("los botones de la nube que el panel no tiene no se vinculan al panel nuevo", async () => {
      const vivos = (await filasDe("control_buttons", "control_id", controlBeto)).filter((b) => b.deleted_at === null);
      expect(vivos.map((b) => b.rf_code).sort()).toEqual([5555, 5557, 7777]);
      expect((await vinculosDe(pFusion)).map((v) => v.button_id)).toEqual([boton5557]);
    });

    it("un vínculo vivo que el panel ya tenía (de la migración) solo cambia a la salida local", async () => {
      const s = snapshotVacio();
      const otroBeto = titular("persona", "Beto");
      const otroControl = { id: randomUUID(), data: { holder_id: otroBeto.id, description: "Control" } };
      s.holders.push(otroBeto);
      s.controls.push(otroControl);
      s.control_buttons.push({ id: randomUUID(), data: { control_id: otroControl.id, button: 0, rf_code: 5555, output_id: 2 } });
      s.outputs.push(...salidasDelPanel());
      expect(await (await subir(pMigrado, s)).json()).toEqual({ status: "awaiting_review" });
      // La migración vinculó los botones vivos a los paneles en revisión.
      await insertar("control_button_panels", {
        installation_id: instDatos,
        button_id: boton5555,
        panel_id: pMigrado.id,
        output_index: 0,
      });

      expect(await confirmImportAs(clienteAdminA, pMigrado.id, [])).toEqual({ imported: [], ignored: [] });
      expect(await vinculosDe(pMigrado)).toEqual([
        { button_id: boton5555, output_index: 2, installation_id: instDatos, origin: origenDe(pMigrado), updated_by: origenDe(pMigrado) },
      ]);
    });
  });

  describe(`máximo de ${MAX_PROFILES} perfiles`, () => {
    it("los permisos que no caben van a conflicts y no se importan", async () => {
      const s = snapshotVacio();
      const sEva = titular("persona", "eva");
      s.holders.push(sEva);
      const [a, b, c] = [permiso(0, "A"), permiso(1, "B"), permiso(2, "C")];
      s.permissions.push(c, a, b);
      s.holder_permissions.push(asignacion(sEva.id, 0), asignacion(sEva.id, 1), asignacion(sEva.id, 2));
      s.outputs.push(...salidasDelPanel());

      const res = await subir(p32, s);
      expect(await res.json()).toEqual({ status: "awaiting_review" });
      const diff = await readImportDiffAs(clienteAdminA, p32.id);
      expect(diff).toEqual<ImportDiff>({
        onlyInPanel: [],
        conflicts: [
          { type: "permission", id: b.id, permission_id: 1, name: "B", reason: MAXIMO_PERFILES },
          { type: "permission", id: c.id, permission_id: 2, name: "C", reason: MAXIMO_PERFILES },
        ],
      });

      expect(await confirmImportAs(clienteAdminA, p32.id, [])).toEqual({ imported: [], ignored: [] });
      expect(await estadoDe(p32)).toBe("active");
      const perfiles = (await filasDe("access_profiles", "installation_id", inst32)).filter((p) => p.deleted_at === null);
      expect(perfiles).toHaveLength(MAX_PROFILES);
      expect(await fila("access_profiles", a.id)).toMatchObject({ name: "A", local_permission_id: 31 });
      expect(await fila("access_profiles", b.id)).toBeNull();
      expect(await fila("access_profiles", c.id)).toBeNull();
      const asignaciones = await filasDe("holder_profiles", "holder_id", eva);
      expect(asignaciones.map((x) => x.profile_id)).toEqual([a.id]);
      expect(await filasDe("profile_panel_rules", "profile_id", a.id)).toHaveLength(1);
    });
  });
});
