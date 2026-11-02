import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiKeyAs,
  listApiKeysAs,
  revokeApiKeyAs,
  rotateApiKeyAs,
  verifyApiKey,
} from "@/lib/api/keys";
import { HttpError } from "@/lib/errors";
import { createLocalUser, localAdmin, requireLocalSupabase, signInLocal } from "../helpers/supabase-local";

/** Llaves de API contra el Supabase local. */
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

describe("llaves de API", () => {
  const admin = localAdmin();
  const sufijo = randomUUID().slice(0, 8);
  const correo = (n: string) => `api-keys-${n}-${sufijo}@test.local`.toLowerCase();
  const usuarios: string[] = [];
  const tenants: string[] = [];
  let adminA: SupabaseClient;
  let tecnicoA: SupabaseClient;
  let adminB: SupabaseClient;
  let tenantA: string;
  let tenantB: string;
  let tenantLleno: string;
  let adminLleno: SupabaseClient;

  async function tenant(nombre: string): Promise<string> {
    const { data, error } = await admin.from("tenants").insert({ name: `Llaves ${nombre} ${sufijo}` }).select("id").single();
    if (error) throw error;
    tenants.push(data.id);
    return data.id;
  }

  async function usuario(nombre: string, tenantId: string, role: "admin" | "tecnico"): Promise<SupabaseClient> {
    const id = await createLocalUser(admin, correo(nombre), CLAVE);
    usuarios.push(id);
    const { error } = await admin.from("tenant_members").insert({ tenant_id: tenantId, user_id: id, role });
    if (error) throw error;
    return signInLocal(correo(nombre), CLAVE);
  }

  beforeAll(async () => {
    requireLocalSupabase();
    tenantA = await tenant("A");
    tenantB = await tenant("B");
    tenantLleno = await tenant("Lleno");
    adminA = await usuario("admin-a", tenantA, "admin");
    tecnicoA = await usuario("tecnico-a", tenantA, "tecnico");
    adminB = await usuario("admin-b", tenantB, "admin");
    adminLleno = await usuario("admin-lleno", tenantLleno, "admin");
  });

  afterAll(async () => {
    for (const t of tenants) await admin.from("tenants").delete().eq("id", t);
    for (const u of usuarios) await admin.auth.admin.deleteUser(u);
  });

  it("crear devuelve un secreto acc_ de 47 caracteres que verifyApiKey resuelve", async () => {
    const { key, secret } = await createApiKeyAs(adminA, tenantA, "  Integración ERP  ");
    expect(secret).toMatch(/^acc_[A-Za-z0-9_-]{43}$/);
    expect(secret).toHaveLength(47);
    expect(key).toEqual({
      id: expect.any(String),
      name: "Integración ERP",
      prefix: secret.slice(0, 12),
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    });

    expect(await verifyApiKey(secret)).toEqual({
      kind: "api",
      tenantId: tenantA,
      keyId: key.id,
      keyName: "Integración ERP",
    });

    // Solo se guarda el hash y se registra quién la creó.
    const { data, error } = await admin.from("api_keys").select("key_hash, created_by, last_used_at").eq("id", key.id).single();
    if (error) throw error;
    expect(data.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.key_hash).not.toContain(secret.slice(4));
    expect(data.created_by).toBe(usuarios[0]);
    expect(data.last_used_at).not.toBeNull();
  });

  it("last_used_at se actualiza como máximo una vez por minuto", async () => {
    const { key, secret } = await createApiKeyAs(adminA, tenantA, "Uso");
    const leer = async () => {
      const { data, error } = await admin.from("api_keys").select("last_used_at").eq("id", key.id).single();
      if (error) throw error;
      return data.last_used_at as string | null;
    };
    await verifyApiKey(secret);
    const primero = await leer();
    expect(primero).not.toBeNull();
    await verifyApiKey(secret);
    expect(await leer()).toBe(primero);

    const haceDosMinutos = new Date(Date.now() - 120_000).toISOString();
    await admin.from("api_keys").update({ last_used_at: haceDosMinutos }).eq("id", key.id);
    await verifyApiKey(secret);
    expect(Date.parse((await leer()) ?? "")).toBeGreaterThan(Date.parse(haceDosMinutos));
  });

  it("verifyApiKey da null con secretos mal formados o desconocidos", async () => {
    expect(await verifyApiKey("")).toBeNull();
    expect(await verifyApiKey("acc_corta")).toBeNull();
    expect(await verifyApiKey(`acc_${"A".repeat(43)}`)).toBeNull();
    expect(await verifyApiKey(`xyz_${"A".repeat(43)}`)).toBeNull();
  });

  it("lista las llaves del tenant sin el hash", async () => {
    const lista = await listApiKeysAs(adminA, tenantA);
    expect(lista.length).toBeGreaterThanOrEqual(2);
    for (const llave of lista) {
      expect(Object.keys(llave).sort()).toEqual(["created_at", "id", "last_used_at", "name", "prefix", "revoked_at"]);
    }
    expect(await listApiKeysAs(adminB, tenantB)).toEqual([]);
  });

  it("una llave revocada da null", async () => {
    const { key, secret } = await createApiKeyAs(adminA, tenantA, "Para revocar");
    await revokeApiKeyAs(adminA, tenantA, key.id);
    expect(await verifyApiKey(secret)).toBeNull();
    const revocada = (await listApiKeysAs(adminA, tenantA)).find((k) => k.id === key.id);
    expect(revocada?.revoked_at).not.toBeNull();
    expect((await fallo(revokeApiKeyAs(adminA, tenantA, key.id))).status).toBe(404);
  });

  it("no revoca ni rota llaves de otro tenant (404)", async () => {
    const { key, secret } = await createApiKeyAs(adminB, tenantB, "Del B");
    expect((await fallo(revokeApiKeyAs(adminA, tenantA, key.id))).status).toBe(404);
    expect((await fallo(rotateApiKeyAs(adminA, tenantA, key.id))).status).toBe(404);
    expect((await fallo(revokeApiKeyAs(adminA, tenantA, "no-es-uuid"))).status).toBe(404);
    expect(await verifyApiKey(secret)).not.toBeNull();
  });

  it("rotar invalida la anterior y la nueva funciona", async () => {
    const original = await createApiKeyAs(adminA, tenantA, "Rotable");
    const rotada = await rotateApiKeyAs(adminA, tenantA, original.key.id);
    expect(rotada.key.name).toBe("Rotable");
    expect(rotada.key.id).not.toBe(original.key.id);
    expect(rotada.secret).not.toBe(original.secret);
    expect(await verifyApiKey(original.secret)).toBeNull();
    expect(await verifyApiKey(rotada.secret)).toMatchObject({ keyId: rotada.key.id, tenantId: tenantA });
    expect((await fallo(rotateApiKeyAs(adminA, tenantA, original.key.id))).status).toBe(404);
  });

  it("la llave número 11 da 409", async () => {
    for (let i = 1; i <= 10; i++) await createApiKeyAs(adminLleno, tenantLleno, `Llave ${i}`);
    const error = await fallo(createApiKeyAs(adminLleno, tenantLleno, "Once"));
    expect(error.status).toBe(409);
    expect(error.message).toBe("Ya hay 10 llaves activas; revoca alguna.");
    // Rotar con 10 vivas sí se puede: no aumenta las vivas.
    const [primera] = await listApiKeysAs(adminLleno, tenantLleno);
    await expect(rotateApiKeyAs(adminLleno, tenantLleno, primera.id)).resolves.toBeDefined();
  });

  it("valida el nombre", async () => {
    expect((await fallo(createApiKeyAs(adminA, tenantA, "   "))).status).toBe(400);
    expect((await fallo(createApiKeyAs(adminA, tenantA, "x".repeat(61)))).status).toBe(400);
  });

  it("un técnico da 403", async () => {
    expect((await fallo(createApiKeyAs(tecnicoA, tenantA, "No"))).status).toBe(403);
    expect((await fallo(listApiKeysAs(tecnicoA, tenantA))).status).toBe(403);
    const [llave] = await listApiKeysAs(adminA, tenantA);
    expect((await fallo(revokeApiKeyAs(tecnicoA, tenantA, llave.id))).status).toBe(403);
    expect((await fallo(rotateApiKeyAs(tecnicoA, tenantA, llave.id))).status).toBe(403);
    expect((await fallo(createApiKeyAs(adminB, tenantA, "Ajeno"))).status).toBe(403);
  });

  it("un tenant suspendido da null", async () => {
    const { secret } = await createApiKeyAs(adminB, tenantB, "Suspendible");
    expect(await verifyApiKey(secret)).not.toBeNull();
    const { error } = await admin.from("tenants").update({ suspended_at: new Date().toISOString() }).eq("id", tenantB);
    if (error) throw error;
    try {
      expect(await verifyApiKey(secret)).toBeNull();
    } finally {
      await admin.from("tenants").update({ suspended_at: null }).eq("id", tenantB);
    }
    expect(await verifyApiKey(secret)).not.toBeNull();
  });
});
