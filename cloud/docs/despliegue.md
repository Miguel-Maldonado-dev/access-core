# Guía de despliegue de la plataforma en la nube (etapa 1)

Esta guía pone en línea la plataforma de `cloud/` y conecta los paneles. Tiene cuatro piezas:

| Pieza | Dónde corre | Para qué |
|---|---|---|
| Base de datos y Auth | Proyecto Supabase | Datos con RLS por tenant, usuarios, `pg_cron` (retención de logs) y `pg_net` (avisos de cambio) |
| Aplicación Next.js | Vercel | Interfaz, API de dispositivos `/api/device/v1`, receptores del broker y de la base |
| Broker MQTT | Servidor virtual con Docker (EMQX 5.8.6) | Avisos de sincronización nube → panel y estado «En línea» |
| Agente `acceso-cloud` | Cada panel (Raspberry Pi / Orange Pi) | Se registra, se vincula y sincroniza |

**Antes de empezar**, la aplicación todavía no está desplegada en remoto: el proyecto Access-Core-DEV es solo de desarrollo y la decisión de dónde alojar producción está pendiente. Todo lo que sigue se puede ensayar primero en local con `cloud/e2e/run_e2e.sh` (ver `cloud/e2e/README.md`).

Reglas que valen en todos los pasos: **nunca** subas secretos al repositorio (es público); genera cada secreto con `openssl rand -hex 32` o `openssl rand -base64 32` y guárdalos en un gestor de contraseñas; usa HTTPS/TLS en todo lo que sale a internet.

## 1. Proyecto Supabase

1. Crea el proyecto en [supabase.com](https://supabase.com) (región cercana a tus instalaciones) y guarda la contraseña de la base.
2. En *Database → Extensions* habilita **`pg_cron`** y **`pg_net`** (las migraciones las crean con `create extension if not exists`, pero en un proyecto nuevo conviene habilitarlas antes).
3. Aplica las migraciones **en orden** desde `cloud/`:

   ```bash
   cd cloud
   supabase login
   supabase link --project-ref <ref-del-proyecto>
   supabase db push
   ```

   Aplica los 7 archivos de `cloud/supabase/migrations/` por orden de nombre: `org`, `replicated`, `panels`, `sync`, `notify`, `tenant_admin_guard` y `conflicts_review`. `sync` programa con `pg_cron` el borrado de logs con más de 12 meses; `notify` crea el trigger que avisa los cambios de revisión. Comprueba con `supabase migration list` que las 7 están aplicadas en local y en remoto.
4. **Vault** (SQL Editor del proyecto). Sin estos dos secretos el trigger de avisos no hace nada (las escrituras siguen funcionando y los paneles sincronizan solo por el intervalo):

   ```sql
   select vault.create_secret('https://app.ejemplo.com', 'app_url');                 -- URL pública de la aplicación, sin barra final
   select vault.create_secret('<INTERNAL_WEBHOOK_SECRET>', 'internal_webhook_secret'); -- el mismo valor que en Vercel
   ```

   Los nombres son exactos. Para cambiarlos después: `select vault.update_secret(id, 'nuevo') from vault.secrets where name = '...'` (usa el `id` de `vault.secrets`).
5. **Auth** (*Authentication*):
   - *Sign In / Providers*: desactiva *Allow new users to sign up*. **No hay invitaciones**: las cuentas las crea el súper administrador (al dar de alta un tenant) o el `admin` del tenant (en *Usuarios*), con correo y contraseña, y la aplicación no envía ningún correo de invitación.
   - *Emails → Reset password*: es la **única plantilla** que se usa. Asunto «Restablece tu contraseña de Access Core» y el cuerpo de `cloud/supabase/templates/recovery.html`.
   - *Emails → SMTP Settings*: configura un SMTP propio. El de Supabase envía muy pocos correos por hora y solo a miembros del equipo del proyecto.
   - *URL Configuration*: *Site URL* = la URL de la aplicación; en *Redirect URLs* agrega `https://app.ejemplo.com/auth/confirm`.
6. **Llaves** (*Project Settings → API Keys*): copia la URL del proyecto, la llave publicable (`sb_publishable_…`) y la secreta (`sb_secret_…`). La secreta solo va en el servidor (Vercel), nunca con el prefijo `NEXT_PUBLIC_`. No se usan las llaves heredadas `anon` ni `service_role`.
7. **Primer súper administrador:** crea el usuario en *Authentication → Users → Add user* (con contraseña y *Auto Confirm User*) y, en el SQL Editor:

   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'tu-correo@ejemplo.com';
   ```

## 2. Aplicación en Vercel

1. Importa el repositorio y define **Root Directory = `cloud`** (Node 24; framework Next.js; `npm install` y `npm run build` por omisión).
2. Variables de entorno (*Settings → Environment Variables*, solo en Production y Preview según convenga):

   | Variable | Valor |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | llave publicable |
   | `SUPABASE_SECRET_KEY` | llave secreta (solo servidor) |
   | `PIN_ENC_KEY` | `openssl rand -base64 32` (cifra los PIN; **si la pierdes no se pueden descifrar**: respáldala) |
   | `PIN_LOOKUP_KEY` | `openssl rand -base64 32` (otra distinta) |
   | `APP_URL` | URL pública de la aplicación (`https://app.ejemplo.com`), sin barra final |
   | `EMQX_API_URL` | URL pública del API de EMQX (`https://mqtt.ejemplo.com`, ver la sección 3) |
   | `EMQX_API_KEY`, `EMQX_API_SECRET` | la API key de EMQX (sección 3) |
   | `EMQX_WEBHOOK_SECRET` | secreto compartido con EMQX (`openssl rand -hex 32`) |
   | `INTERNAL_WEBHOOK_SECRET` | el mismo valor que `internal_webhook_secret` de Vault |

3. Despliega y comprueba `https://app.ejemplo.com/api/health` y el inicio de sesión del súper administrador.
4. Seguridad de los receptores: `POST /api/mqtt/auth` y `/api/mqtt/events` **exigen el encabezado `x-emqx-secret`** igual a `EMQX_WEBHOOK_SECRET` (sin él, `/api/mqtt/auth` responde `deny` a todo y el broker rechaza a todos los paneles); `/api/internal/revision-changed` exige `x-internal-secret`. Los secretos se comparan en tiempo constante y nunca se registran.

## 3. Servidor del broker MQTT (EMQX)

Un servidor virtual pequeño (1 vCPU y 1–2 GB de RAM alcanzan para decenas de paneles) con Docker, un nombre DNS (`mqtt.ejemplo.com`) apuntando a su IP pública y estos puertos abiertos en el firewall: **8883** (MQTT sobre TLS, lo usan los paneles), **443** (HTTPS: la API REST de EMQX para que Vercel publique; lo atiende Caddy) y **80** (solo para que Caddy o certbot obtengan el certificado). El puerto del dashboard (18083) **no** se abre a internet.

EMQX se configura con `cloud/infra/emqx/`: `emqx.conf` es una plantilla que `render-entrypoint.sh` renderiza dentro del contenedor con `APP_URL` y `EMQX_WEBHOOK_SECRET` del `.env` (EMQX 5.8 no sustituye variables de entorno en HOCON). No hay que editar archivos a mano. Esta configuración es la que usa la prueba E2E.

1. Copia `cloud/infra/emqx/` al servidor (por ejemplo a `/opt/acceso-emqx/`).
2. **Certificado TLS.** EMQX necesita `fullchain.pem` y `privkey.pem` en la carpeta `EMQX_CERT_DIR`. Elige una de las dos opciones:
   - **Con Caddy (recomendada):** Caddy obtiene y renueva solo el certificado de `mqtt.ejemplo.com` al atender el sitio del paso 5. Copia su `.crt` y su `.key` (en su almacenamiento, normalmente `/var/lib/caddy/.local/share/caddy/certificates/…/mqtt.ejemplo.com/`; verifica la ruta en tu instalación) a `EMQX_CERT_DIR` como `fullchain.pem` y `privkey.pem`, y reinicia EMQX tras cada renovación (por ejemplo con un cron semanal que repita la copia de abajo).
   - **Con certbot:** `sudo certbot certonly --standalone -d mqtt.ejemplo.com` (necesita el puerto 80 libre, así que Caddy deberá atender otro nombre, p. ej. `mqtt-api.ejemplo.com`, que será el de `EMQX_API_URL`). Copia `fullchain.pem` y `privkey.pem` de `/etc/letsencrypt/live/mqtt.ejemplo.com/` a `EMQX_CERT_DIR` con los permisos de abajo y reinicia EMQX tras cada renovación (hook de despliegue de certbot, ejemplo abajo).
   **Permisos (importante):** EMQX corre dentro del contenedor como el usuario `emqx` (uid y gid 1000; compruébalo con `docker run --rm --entrypoint id emqx/emqx:5.8.6`), no como root. Los archivos de certbot y de Caddy son de root y la llave es `0600`, así que, montados solo lectura, EMQX no podría leerla y los listeners TLS no arrancarían. Copia con dueño 1000 y **no abras la llave a todos** (nada de `0644`):

   ```bash
   sudo mkdir -p "$EMQX_CERT_DIR" && sudo chmod 755 "$EMQX_CERT_DIR"
   sudo install -o 1000 -g 1000 -m 0644 <fullchain.pem de origen> "$EMQX_CERT_DIR/fullchain.pem"
   sudo install -o 1000 -g 1000 -m 0600 <privkey.pem de origen>  "$EMQX_CERT_DIR/privkey.pem"
   ```

   Repite exactamente esos dos `install` en el hook de renovación y reinicia EMQX después (`docker compose restart emqx`). Con certbot, un ejemplo de `/etc/letsencrypt/renewal-hooks/deploy/emqx.sh` (ejecutable):

   ```bash
   #!/bin/sh
   set -e
   D=/etc/letsencrypt/live/mqtt.ejemplo.com
   install -o 1000 -g 1000 -m 0644 "$D/fullchain.pem" /opt/acceso-emqx/certs/fullchain.pem
   install -o 1000 -g 1000 -m 0600 "$D/privkey.pem"  /opt/acceso-emqx/certs/privkey.pem
   cd /opt/acceso-emqx && docker compose restart emqx
   ```

   (`install` sigue los enlaces simbólicos de `live/` y copia el archivo real.)
3. **Variables** del compose: copia `.env.example` a `.env` y completa `APP_URL`, `EMQX_WEBHOOK_SECRET` (el mismo de Vercel), `EMQX_NODE_COOKIE` (aleatorio), `EMQX_DASHBOARD_USER`, `EMQX_DASHBOARD_PASSWORD` (aleatoria) y `EMQX_CERT_DIR`. Como Caddy usa el 443, agrega `EMQX_WSS_PORT=8084` al `.env` (el listener `wss` queda en el 8084 del servidor y no se abre en el firewall). Opcional: `EMQX_MQTT_PORT` (8883). El dashboard/API se publica solo en `127.0.0.1:18083`.
4. Arranca y revisa:

   ```bash
   docker compose --env-file .env up -d
   docker compose logs emqx --tail 50     # debe decir "EMQX 5.8.6 is running now!" y los listeners ssl:default y wss:default started, sin errores
   ```
5. **Caddy** (TLS y API REST pública). Instala Caddy y publica solo la ruta que la aplicación necesita, protegida por la API key de EMQX:

   ```caddyfile
   mqtt.ejemplo.com {
       @publish path /api/v5/publish
       handle @publish {
           reverse_proxy 127.0.0.1:18083
       }
       handle {
           respond 404
       }
   }
   ```

   Así `EMQX_API_URL=https://mqtt.ejemplo.com` y el dashboard completo sigue accesible solo por túnel SSH (`ssh -L 18083:127.0.0.1:18083 usuario@mqtt.ejemplo.com`).
6. **API key** (para que la aplicación publique): por túnel SSH entra a `http://127.0.0.1:18083` → *System → API Key → New*, nombre `acceso-cloud`, rol *Publisher* (o *Administrator*). Guarda el key y el secret como `EMQX_API_KEY` y `EMQX_API_SECRET` en Vercel (y vuelve a desplegar).
7. **Comprueba el enlace completo** con un panel de prueba (sección 4): en la página *Nube* del panel debe quedar «Vinculado», en la plataforma el panel debe verse **En línea**, y un cambio hecho en la nube debe llegar al panel en segundos. Si el aviso no llega pero la sincronización sí lo hace cada 5 minutos, revisa Vault (`app_url`, `internal_webhook_secret`), `EMQX_API_URL` y la API key.

Comprobaciones de seguridad del broker: otro usuario no puede suscribirse a `acc/<otro_panel>/cmd` (la ACL desconecta al cliente); un panel revocado no se conecta; el puerto 18083 no responde desde internet.

## 4. Cada panel

1. Instala el paquete del panel (`panel/README.md`) con las dos URL de la nube:

   ```bash
   sudo CLOUD_URL=https://app.ejemplo.com MQTT_URL=mqtts://mqtt.ejemplo.com:8883 ./deploy/install.sh
   ```

   `install.sh` las guarda en `/etc/acceso/cloud.env` (modo 600, dueño `acceso`) **solo si el archivo no existe**; en un panel ya instalado edítalo a mano y reinicia:

   ```bash
   sudo nano /etc/acceso/cloud.env        # CLOUD_URL=…  MQTT_URL=…  (no toques CLOUD_PANEL_CODE ni CLOUD_DEVICE_TOKEN)
   sudo systemctl restart acceso-cloud
   ```

   `MQTT_URL` siempre empieza con `mqtts://` (el agente no acepta conexiones sin TLS) y `CLOUD_URL` con `https://`. El certificado del broker debe ser de una autoridad que el sistema del panel conozca (Let's Encrypt lo es).
2. En la placa, el reloj debe estar sincronizado (`timedatectl`): si la hora del panel se adelanta más de 5 minutos, la nube ajusta esas marcas a su propia hora y lo registra como conflicto.
3. Abre la página **Nube** del panel (`http://<ip>:8080`): muestra el identificador `PNL-XXXX-XXXX` y el código de vinculación. En la plataforma, un `admin` del tenant: instalación → Paneles → **Vincular panel**, captura los dos datos y, si la instalación ya tenía datos, revisa y confirma la importación.
4. Diagnóstico: `journalctl -u acceso-cloud -f`.

## 5. Costos aproximados (a confirmar con precios vigentes)

Cifras de orden de magnitud para dimensionar; **confirma con los precios vigentes de cada proveedor** antes de decidir.

| Concepto | Aproximado |
|---|---|
| Supabase Pro (por organización; el plan gratuito pausa proyectos inactivos y no conviene para producción) | ~25 USD/mes |
| Vercel Pro (el plan Hobby es solo para uso personal no comercial) | ~20 USD/mes por usuario |
| Servidor virtual para EMQX (1 vCPU, 1–2 GB) | ~5–12 USD/mes |
| Dominio | ~10–15 USD/año |
| SMTP transaccional (solo recuperación de contraseña) | gratis o pocos USD/mes en volumen bajo |
| **Total** | **~50–60 USD/mes** más el dominio |

## 6. Referencia de rendimiento: lotes de 500 cambios

El agente sube y baja cambios en lotes de 500 (`CHANGES_PAGE`). Medición **local** (agente detenido; el mismo `SyncEngine` del panel contra la API de `next dev` y el Supabase local, en la Mac del desarrollo; 500 altas de tarjeta):

| Operación | Tiempos medidos (3 corridas) |
|---|---|
| `push` de 500 cambios (`POST /changes`) | 4.4 s, 3.3 s, 3.1 s |
| `pull` de 500 cambios (`GET /changes`) | 0.2 s, 0.9 s, 0.7 s |

Son una referencia: en producción habrá latencia de red y `next start` en lugar de `next dev`. **La medición contra el proyecto remoto sigue pendiente**; repítela con un panel real tras el primer despliegue y anótala aquí. Con el intervalo normal (300 s) y los avisos MQTT, una carga masiva (por ejemplo, la importación inicial de cientos de tarjetas) se completa en segundos por lote.
