# EMQX para access-core

Broker MQTT de la plataforma en la nube. Cada panel se conecta con usuario = clientid = `panel_code` y
contraseña = `device_token`; la nube le avisa por `acc/<panel_code>/cmd` cuando cambia la
revisión de su instalación, y el broker reporta conexiones para mostrar "En línea".

Archivos:

| Archivo | Para qué |
|---|---|
| `docker-compose.yml` | EMQX 5.8.6 (versión fija), puertos 8883 (ssl) y 443 (wss); API y dashboard solo en `127.0.0.1:18083` |
| `emqx.conf` | **Plantilla** HOCON: listeners TLS, dashboard/API, autenticación HTTP, autorización por archivo, conector, acción y regla |
| `render-entrypoint.sh` | Entrypoint del contenedor: renderiza `emqx.conf` con `APP_URL` y `EMQX_WEBHOOK_SECRET` y arranca EMQX |
| `acl.conf` | Permisos por tópico (`${username}`); todo lo demás se niega |
| `.env.example` | Variables; cópialo a `.env` (ignorado por git) |

Esta configuración se probó contra EMQX 5.8.6 en vivo con la prueba de punta a punta
(`cloud/e2e/run_e2e.sh`, que usa este mismo compose).

**Cómo se configura:** EMQX 5.8 no sustituye variables de entorno `${...}` dentro de `emqx.conf`
(falla con `failed_to_resolve`). Por eso `emqx.conf` es una plantilla: el compose la monta como
`emqx.template.conf` y `render-entrypoint.sh` la convierte en el `emqx.conf` definitivo dentro del
contenedor, con los valores de `APP_URL` y `EMQX_WEBHOOK_SECRET` del entorno (escapados como cadenas
HOCON), justo antes de arrancar EMQX. No hay que editar nada a mano y el valor renderizado nunca
sale del contenedor ni del `.env` (ignorado por git).

## Variables

- `APP_URL`: URL pública de la aplicación (`https://app.ejemplo.com`), sin barra final.
- `EMQX_WEBHOOK_SECRET`: el mismo valor que en la aplicación. EMQX lo manda en `x-emqx-secret`
  a `/api/mqtt/auth` y `/api/mqtt/events`.
- `EMQX_NODE_COOKIE`, `EMQX_DASHBOARD_USER`, `EMQX_DASHBOARD_PASSWORD`: del propio broker.
- `EMQX_CERT_DIR`: carpeta con `fullchain.pem` y `privkey.pem`.
- Opcionales (puertos del anfitrión): `EMQX_MQTT_PORT` (8883), `EMQX_WSS_PORT` (443; si Caddy usa el
  443, define `EMQX_WSS_PORT=8084`), `EMQX_API_PORT` (18083, siempre ligado a `127.0.0.1`) y
  `EMQX_CONTAINER_NAME` (`acceso-emqx`).

En la aplicación (`cloud/.env.local`): `EMQX_API_URL` (por ejemplo `http://127.0.0.1:18083`),
`EMQX_API_KEY`, `EMQX_API_SECRET`, `EMQX_WEBHOOK_SECRET`, `INTERNAL_WEBHOOK_SECRET` y `APP_URL`.

## TLS

Los listeners `ssl:8883` y `wss:443` usan `fullchain.pem` y `privkey.pem` de `EMQX_CERT_DIR`.

**Permisos:** EMQX corre en el contenedor como el usuario `emqx` (uid/gid 1000), no como root, y el
compose monta `EMQX_CERT_DIR` en solo lectura. Las llaves de certbot y de Caddy son de root y `0600`,
así que hay que copiarlas con dueño 1000: `sudo install -o 1000 -g 1000 -m 0600 privkey.pem
"$EMQX_CERT_DIR/privkey.pem"` y `-m 0644` para `fullchain.pem` (no uses `0644` en la llave).
Repítelo en el hook de renovación (ejemplo completo en `cloud/docs/despliegue.md`).

- **certbot:** `certbot certonly --standalone -d mqtt.ejemplo.com`; copia `fullchain.pem` y
  `privkey.pem` de `/etc/letsencrypt/live/mqtt.ejemplo.com/` a `EMQX_CERT_DIR` con los permisos de
  arriba (`install` sigue los enlaces simbólicos) y reinicia EMQX tras cada renovación.
- **Caddy:** Caddy obtiene el certificado de `mqtt.ejemplo.com`; copia `.crt`/`.key` de su
  almacenamiento como `fullchain.pem`/`privkey.pem` con los permisos de arriba. Alternativa: dejar que Caddy termine
  el `wss` en 443 y hacer proxy a `8084`; en ese caso define `EMQX_WSS_PORT=8084` en el `.env`.
  Los listeners llevan `cacertfile` apuntando a `fullchain.pem` (con `verify_none` no se piden
  certificados de cliente); así EMQX no registra `cert_file_not_found` por el `cacert.pem` por defecto.

## API key (para que la aplicación publique)

1. Entra al dashboard (`http://127.0.0.1:18083`, por túnel SSH si es remoto). Escucha solo en
   `127.0.0.1` del servidor (`dashboard.listeners.http.bind = 18083` en `emqx.conf`; el compose lo
   publica ligado a `127.0.0.1`).
2. System > API Key > New: nombre `acceso-cloud`, rol Publisher (o Administrator).
3. Guarda el key y el secret en `EMQX_API_KEY` y `EMQX_API_SECRET` de la aplicación.

## Vault (avisos de cambio desde la base de datos)

Los avisos salen de un trigger en la base. En el editor SQL de Supabase:

```sql
select vault.create_secret('https://app.ejemplo.com', 'app_url');
select vault.create_secret('<INTERNAL_WEBHOOK_SECRET>', 'internal_webhook_secret');
```

Sin esos dos secretos el trigger no hace nada.

## Probar

```bash
cp .env.example .env   # edita los valores
docker compose -f docker-compose.yml --env-file .env config   # valida
docker compose -f docker-compose.yml --env-file .env up -d
# Con un panel activo (usuario = panel_code, contraseña = device_token):
mosquitto_sub -h mqtt.ejemplo.com -p 8883 --capath /etc/ssl/certs -u PNL-XXXX-XXXX -P <token> -t 'acc/PNL-XXXX-XXXX/cmd' -q 1
# Cambia la revisión de la instalación (o publica con la API) y debe llegar {"type":"sync","revision":N}.
```

Comprobaciones: otro usuario no puede suscribirse a `acc/<otro>/cmd`; un panel revocado
no se conecta; al conectar y desconectar, `panels.online` cambia.

## Detrás de Traefik (servidor con Portainer)

Si el servidor ya tiene un Traefik en los puertos 80 y 443 (por ejemplo, el que instala Bluehost con Portainer), usa `docker-compose.traefik.yml` en vez de `docker-compose.yml`. No toca la configuración de ese Traefik:

- **Certificado:** Traefik emite y renueva el certificado de `EMQX_DOMAIN`. El servicio `certs` (alpine con jq) lo copia de `acme.json` a PEM cada 6 horas, con el dueño del usuario `emqx`.
- **MQTT con TLS:** EMQX publica el 8883 directamente.
- **API REST:** sale por el 443 de Traefik solo en `https://EMQX_DOMAIN/api/v5/...`. La aplicación usa `EMQX_API_URL=https://EMQX_DOMAIN`.
- **Dashboard:** no se publica; ábrelo con un túnel: `ssh -L 18083:127.0.0.1:18083 usuario@servidor` y luego `http://localhost:18083`.

Pasos:

1. Copia `emqx.conf`, `render-entrypoint.sh` y `acl.conf` a `/opt/acceso-emqx/` en el servidor y crea `/opt/acceso-emqx/certs`.
2. En Portainer, crea un stack con `docker-compose.traefik.yml` y estas variables:
   - `EMQX_DOMAIN`, `APP_URL`, `EMQX_WEBHOOK_SECRET`, `EMQX_NODE_COOKIE` y `EMQX_DASHBOARD_PASSWORD`;
   - opcionales: `TRAEFIK_NETWORK` (`hostedapps_default`), `TRAEFIK_CERT_RESOLVER` (`challenger`), `TRAEFIK_ENTRYPOINT` (`websecure`), `TRAEFIK_DATA_VOLUME` (`traefik_data`) y `EMQX_DIR` (`/opt/acceso-emqx`).
3. EMQX lee el certificado al arrancar. Para que use el renovado, reinícialo una vez por semana:
   ```bash
   echo '0 4 * * 1 root docker restart acceso-emqx' | sudo tee /etc/cron.d/acceso-emqx
   ```
   Los paneles se reconectan solos; la sincronización periódica cubre los segundos sin avisos.
