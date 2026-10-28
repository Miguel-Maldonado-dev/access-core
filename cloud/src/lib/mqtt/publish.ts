import "server-only";

/** Variables de EMQX necesarias para publicar; faltar una es un error de configuración. */
function configEmqx() {
  const faltan = ["EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET"].filter((n) => !process.env[n]);
  if (faltan.length) {
    throw new Error(`Falta configurar EMQX: define ${faltan.join(", ")} en el entorno del servidor.`);
  }
  return {
    url: process.env.EMQX_API_URL!.replace(/\/+$/, ""),
    key: process.env.EMQX_API_KEY!,
    secret: process.env.EMQX_API_SECRET!,
  };
}

/**
 * Publica `payload` (JSON) en `acc/<panelCode>/cmd` con la API REST de EMQX 5
 * (`POST /api/v5/publish`), QoS 1 y sin retener. Autenticación básica con la API key.
 * Lanza error si EMQX no responde 2xx; el mensaje nunca incluye credenciales.
 */
export async function publishToPanel(panelCode: string, payload: unknown): Promise<void> {
  const { url, key, secret } = configEmqx();
  const respuesta = await fetch(`${url}/api/v5/publish`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      topic: `acc/${panelCode}/cmd`,
      qos: 1,
      retain: false,
      payload: JSON.stringify(payload),
      payload_encoding: "plain",
    }),
    cache: "no-store",
  });
  if (!respuesta.ok) {
    throw new Error(`EMQX rechazó la publicación para ${panelCode} (HTTP ${respuesta.status}).`);
  }
}
