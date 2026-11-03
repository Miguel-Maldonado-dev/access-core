import "server-only";

/**
 * La publicación que con seguridad no salió: falta la configuración de EMQX o EMQX respondió con un
 * código distinto de 2xx. Reintentar no duplica la orden. Cualquier otro error de
 * `publishToPanel` (red, tiempo agotado) es ambiguo: EMQX pudo entregarlo.
 */
export class PublicacionNoEntregada extends Error {
  override name = "PublicacionNoEntregada";
}

/** Variables de EMQX necesarias para publicar; faltar una es un error de configuración. */
function configEmqx() {
  const faltan = ["EMQX_API_URL", "EMQX_API_KEY", "EMQX_API_SECRET"].filter((n) => !process.env[n]);
  if (faltan.length) {
    throw new PublicacionNoEntregada(`Falta configurar EMQX: define ${faltan.join(", ")} en el entorno del servidor.`);
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
 * Si EMQX no responde 2xx (o falta la configuración) lanza `PublicacionNoEntregada`; un
 * error de red se propaga tal cual. El mensaje nunca incluye credenciales.
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
    throw new PublicacionNoEntregada(`EMQX rechazó la publicación para ${panelCode} (HTTP ${respuesta.status}).`);
  }
}
