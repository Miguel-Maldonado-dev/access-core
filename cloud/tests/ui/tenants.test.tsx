// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MembersManager from "@/components/members/MembersManager";
import TenantsAdmin from "@/components/tenants/TenantsAdmin";
import type { ActionResult } from "@/lib/actions";
import type { TenantSummary } from "@/lib/tenants/admin";
import type { TenantMember } from "@/lib/tenants/members";

/**
 * Interfaz de /admin/tenants y /t/[tenant]/users: las server actions se sustituyen por
 * funciones de prueba, así se ve qué manda cada control y cómo muestra la respuesta.
 */
const ULTIMO_ADMIN = "El tenant debe tener al menos un administrador.";
const ok = <T,>(data: T): ActionResult<T> => ({ ok: true, data });
const error = (mensaje: string, status = 409): ActionResult<never> => ({ ok: false, status, error: mensaje });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function escribir(etiqueta: string, valor: string) {
  fireEvent.change(screen.getByLabelText(etiqueta), { target: { value: valor } });
}

/** Espera la confirmación en la zona `role="status"` (siempre presente, vacía al inicio). */
async function confirmacion(texto: string) {
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(texto));
}

describe("TenantsAdmin (/admin/tenants)", () => {
  const tenants: TenantSummary[] = [
    {
      id: "t-1",
      name: "Fraccionamiento Las Palmas",
      suspendedAt: null,
      createdAt: "2026-10-20T10:00:00.000Z",
      admins: [
        { userId: "u-ana", email: "ana@ejemplo.mx" },
        { userId: "u-beto", email: "beto@ejemplo.mx" },
      ],
    },
    {
      id: "t-2",
      name: "Residencial Del Lago",
      suspendedAt: "2026-10-25T10:00:00.000Z",
      createdAt: "2026-10-21T10:00:00.000Z",
      admins: [],
    },
  ];

  function montar(overrides: Partial<Parameters<typeof TenantsAdmin>[0]> = {}) {
    const props = {
      tenants,
      onCreate: vi.fn(async () => ok({ tenantId: "t-3", existingAccount: false })),
      onSetSuspended: vi.fn(async () => ok(undefined)),
      onAddAdmin: vi.fn(async () => ok({ existingAccount: false })),
      ...overrides,
    };
    render(<TenantsAdmin {...props} />);
    return props;
  }

  it("lista los tenants con su estado y sus administradores", () => {
    montar();
    const filas = screen.getAllByRole("row");
    const palmas = within(filas.find((f) => f.textContent?.includes("Las Palmas"))!);
    expect(palmas.getByText("Activo")).toBeTruthy();
    expect(palmas.getByText("ana@ejemplo.mx")).toBeTruthy();
    expect(palmas.getByText("beto@ejemplo.mx")).toBeTruthy();
    expect(palmas.queryByText(/pendiente/i)).toBeNull();
    const lago = within(filas.find((f) => f.textContent?.includes("Del Lago"))!);
    expect(lago.getByText("Suspendido")).toBeTruthy();
    expect(lago.getByText("Sin administradores")).toBeTruthy();
  });

  /** Llena el formulario "Nuevo tenant". */
  function llenarAlta(clave = "Clave-segura-1", repetida = clave) {
    escribir("Nombre del tenant", "Privada Los Pinos");
    escribir("Correo del administrador", "carla@ejemplo.mx");
    escribir("Contraseña del administrador", clave);
    escribir("Repite la contraseña del administrador", repetida);
  }

  it("el formulario no habla de invitaciones", () => {
    montar();
    expect(document.body.textContent).not.toMatch(/invita|reenv/i);
  });

  it("crea un tenant con el nombre, el correo y la contraseña del primer administrador", async () => {
    const props = montar();
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Crear tenant" }));
    await confirmacion("Se creó el tenant Privada Los Pinos. carla@ejemplo.mx ya puede iniciar sesión.");
    expect(props.onCreate).toHaveBeenCalledWith("Privada Los Pinos", "carla@ejemplo.mx", "Clave-segura-1");
    // El formulario queda limpio, contraseñas incluidas.
    expect((screen.getByLabelText("Contraseña del administrador") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Repite la contraseña del administrador") as HTMLInputElement).value).toBe("");
  });

  it("si el correo ya tenía cuenta, lo dice y aclara que conserva su contraseña", async () => {
    montar({ onCreate: vi.fn(async () => ok({ tenantId: "t-3", existingAccount: true })) });
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Crear tenant" }));
    await confirmacion(
      "Se creó el tenant Privada Los Pinos. Ese correo ya tenía cuenta: se agregó como administrador y conserva su contraseña.",
    );
  });

  it("con contraseñas distintas no llama a la acción y avisa", async () => {
    const props = montar();
    llenarAlta("Clave-segura-1", "Clave-segura-2");
    fireEvent.click(screen.getByRole("button", { name: "Crear tenant" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Las contraseñas no coinciden.");
    expect(props.onCreate).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Nombre del tenant") as HTMLInputElement).value).toBe("Privada Los Pinos");
  });

  it("muestra en español el error al crear y conserva lo escrito", async () => {
    montar({ onCreate: vi.fn(async () => error("Escribe un correo válido.", 400)) });
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Crear tenant" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Escribe un correo válido.");
    expect((screen.getByLabelText("Nombre del tenant") as HTMLInputElement).value).toBe("Privada Los Pinos");
  });

  it("suspende tras confirmar y reactiva", async () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: "Suspender Fraccionamiento Las Palmas" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onSetSuspended).toHaveBeenCalledWith("t-1", true);
    await confirmacion("Se suspendió «Fraccionamiento Las Palmas».");
    // Mientras corre una acción los botones se desactivan; ya terminó.
    fireEvent.click(screen.getByRole("button", { name: "Reactivar Residencial Del Lago" }));
    expect(props.onSetSuspended).toHaveBeenCalledWith("t-2", false);
    await confirmacion("Se reactivó «Residencial Del Lago».");
  });

  it("ya no ofrece reenviar invitaciones", () => {
    montar();
    expect(screen.queryByRole("button", { name: /Reenviar/ })).toBeNull();
  });

  it("agrega a otro administrador a un tenant existente con correo y contraseña", async () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador a Residencial Del Lago" }));
    escribir("Correo del nuevo administrador", "dora@ejemplo.mx");
    escribir("Contraseña del nuevo administrador", "Clave-segura-1");
    escribir("Repite la contraseña del nuevo administrador", "Clave-segura-1");
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador" }));
    await confirmacion("dora@ejemplo.mx ya puede iniciar sesión como administrador de «Residencial Del Lago».");
    expect(props.onAddAdmin).toHaveBeenCalledWith("t-2", "dora@ejemplo.mx", "Clave-segura-1");
  });

  it("al agregar administrador con una cuenta existente, aclara que conserva su contraseña", async () => {
    montar({ onAddAdmin: vi.fn(async () => ok({ existingAccount: true })) });
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador a Residencial Del Lago" }));
    escribir("Correo del nuevo administrador", "dora@ejemplo.mx");
    escribir("Contraseña del nuevo administrador", "Clave-segura-1");
    escribir("Repite la contraseña del nuevo administrador", "Clave-segura-1");
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador" }));
    await confirmacion(
      "Ese correo ya tenía cuenta: se agregó como administrador y conserva su contraseña.",
    );
  });

  it("al agregar administrador con contraseñas distintas no llama a la acción", async () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador a Residencial Del Lago" }));
    escribir("Correo del nuevo administrador", "dora@ejemplo.mx");
    escribir("Contraseña del nuevo administrador", "Clave-segura-1");
    escribir("Repite la contraseña del nuevo administrador", "otra-clave-xyz");
    fireEvent.click(screen.getByRole("button", { name: "Agregar administrador" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Las contraseñas no coinciden.");
    expect(props.onAddAdmin).not.toHaveBeenCalled();
  });
});

describe("MembersManager (/t/[tenant]/users)", () => {
  const miembros: TenantMember[] = [
    { userId: "u-ana", email: "ana@ejemplo.mx", role: "admin" },
    { userId: "u-tec", email: "tec@ejemplo.mx", role: "tecnico" },
  ];

  function montar(overrides: Partial<Parameters<typeof MembersManager>[0]> = {}) {
    const props = {
      tenantId: "t-1",
      currentUserId: "u-ana",
      members: miembros,
      onAdd: vi.fn(async () => ok({ existingAccount: false })),
      onChangeRole: vi.fn(async () => ok({ self: false })),
      onRemove: vi.fn(async () => ok({ self: false })),
      ...overrides,
    };
    render(<MembersManager {...props} />);
    return props;
  }

  it("lista a los miembros con su correo y su rol", () => {
    montar();
    const filas = screen.getAllByRole("row");
    const ana = within(filas.find((f) => f.textContent?.includes("ana@ejemplo.mx"))!);
    expect(ana.getByText("Administrador")).toBeTruthy();
    expect(ana.getByText("Tú")).toBeTruthy();
    const tec = within(filas.find((f) => f.textContent?.includes("tec@ejemplo.mx"))!);
    expect(tec.getByText("Técnico")).toBeTruthy();
    expect(tec.queryByText(/pendiente/i)).toBeNull();
  });

  it("ya no ofrece reenviar invitaciones ni habla de ellas", () => {
    montar();
    expect(screen.queryByRole("button", { name: /Reenviar/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/invita|reenv/i);
  });

  it("quitar al último admin muestra el mensaje", async () => {
    const props = montar({ onRemove: vi.fn(async () => error(ULTIMO_ADMIN)) });
    fireEvent.click(screen.getByRole("button", { name: "Quitar a ana@ejemplo.mx" }));
    expect((await screen.findByRole("alert")).textContent).toBe(ULTIMO_ADMIN);
    expect(props.onRemove).toHaveBeenCalledWith("t-1", "u-ana");
  });

  it("degradar al último admin muestra el mensaje", async () => {
    const props = montar({ onChangeRole: vi.fn(async () => error(ULTIMO_ADMIN)) });
    fireEvent.click(screen.getByRole("button", { name: "Hacer técnico a ana@ejemplo.mx" }));
    expect((await screen.findByRole("alert")).textContent).toBe(ULTIMO_ADMIN);
    expect(props.onChangeRole).toHaveBeenCalledWith("t-1", "u-ana", "tecnico");
  });

  it("no quita a nadie si no se confirma", () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: "Quitar a tec@ejemplo.mx" }));
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  /** Llena el formulario "Agregar usuario". */
  function llenarAlta(clave = "Clave-segura-1", repetida = clave) {
    escribir("Correo", "nuevo@ejemplo.mx");
    fireEvent.change(screen.getByLabelText("Rol"), { target: { value: "admin" } });
    escribir("Contraseña", clave);
    escribir("Repite la contraseña", repetida);
  }

  it("agrega con el correo, el rol y la contraseña elegidos", async () => {
    const props = montar();
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Agregar usuario" }));
    await confirmacion("nuevo@ejemplo.mx ya puede iniciar sesión.");
    expect(props.onAdd).toHaveBeenCalledWith("t-1", "nuevo@ejemplo.mx", "Clave-segura-1", "admin");
    expect((screen.getByLabelText("Contraseña") as HTMLInputElement).value).toBe("");
  });

  it("si el correo ya tenía cuenta, aclara que conserva su contraseña", async () => {
    montar({ onAdd: vi.fn(async () => ok({ existingAccount: true })) });
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Agregar usuario" }));
    await confirmacion("Ese correo ya tenía cuenta: se agregó al tenant y conserva su contraseña.");
  });

  it("con contraseñas distintas no llama a la acción y avisa", async () => {
    const props = montar();
    llenarAlta("Clave-segura-1", "Clave-segura-2");
    fireEvent.click(screen.getByRole("button", { name: "Agregar usuario" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Las contraseñas no coinciden.");
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("muestra el error de la acción y conserva lo escrito", async () => {
    montar({ onAdd: vi.fn(async () => error("Ese correo ya es miembro del tenant.")) });
    llenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Agregar usuario" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Ese correo ya es miembro del tenant.");
    expect((screen.getByLabelText("Correo") as HTMLInputElement).value).toBe("nuevo@ejemplo.mx");
  });
});
