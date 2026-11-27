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
   supabase db push --remote
   ```

   Aplica los 21 archivos de `cloud/supabase/migrations/` por orden de nombre: `org`, `replicated`, `panels`, `sync`, `notify`, `tenant_admin_guard`, `conflicts_review`, `claim_panel_neutral_author`, `control_button_panels`, `panel_commands`, `api_keys`, `remote_open`, `logs_listen_retention`, `revoke_panel_cleanup`, `deleted_rows_purge`, `api_key_rate_limit`, `delete_installation`, `api_batch`, `orphan_panel_rows_cleanup`, `phones_calls` y `qr_codes`. `sync` programa con `pg_cron` el borrado de logs con más de 12 meses; `notify` crea el trigger que avisa los cambios de revisión. Comprueba con `supabase migration list` que las 21 están aplicadas en local y en remoto.

   **Ojo:** las versiones recientes de la CLI aplican al Supabase **local** por omisión (`Target: local stack`). Para el proyecto en la nube hay que pasar `--remote` en `db push` y en `migration list`.

   **Si el proyecto ya tenía las anteriores** (por ejemplo Access-Core-DEV), `npx supabase db push --remote` aplica solo las que faltan. Las más recientes son:

   - `control_button_panels` (controles por panel): crea `control_button_panels`, quita `output_index` de `control_buttons` y cambia el push, el feed de cambios y la importación para que cada panel reciba solo los botones vinculados a él. **Al aplicarse, vincula cada botón vivo a los paneles reclamados, importando, en revisión o activos de su instalación (no a los revocados ni a los pendientes), con su salida actual**, así que ningún control deja de funcionar. Un panel que se agregue después no recibe vínculos automáticos: se configuran en la ficha del control.
   - `panel_commands` (actualizar logs y prueba de salidas): crea `panel_commands` y las columnas `panels.logs_uploaded_at` e `installations.logs_requested_at`.

   - `api_keys` (API pública `/api/v1`, etapa 2A): archivo `20261102181107_api_keys.sql`. Crea las tablas `api_keys` (RLS: solo los admin del tenant leen las suyas), `api_requests` (límite de peticiones) y `api_idempotency` (respuestas idempotentes), estas dos solo para el servidor, y programa con `pg_cron` el trabajo `api-tables-cleanup` (cada hora borra las respuestas idempotentes de más de 24 h y los registros del límite de más de 10 min). **No hay variables de entorno nuevas**: usa las mismas de Vercel (la huella de `Idempotency-Key` se firma con una clave derivada de la `PIN_LOOKUP_KEY` que ya existe). Guía de uso en `cloud/docs/api.md`.

   - `remote_open` (apertura remota, etapa 3): archivo `20261102225408_remote_open.sql`. Agrega `profile_panel_rules.allow_remote` (`false` por omisión), y en `panel_commands` el tipo `remote_open` con las columnas `holder_id` (obligatorio en ese tipo) y `reason`; redefine `push_permission` e `import_rows` para que un panel v6, que no envía `allow_remote`, conserve el valor de la nube. **No hay variables de entorno nuevas.** Se activa a propósito, por perfil y por panel (casilla "Permitir apertura remota" en las reglas del perfil); el permiso por omisión la trae apagada. Uso en `cloud/docs/api.md` (`POST /api/v1/installations/{installationId}/outputs/{outputId}/open`).
   - `logs_listen_retention` (escucha de controles RF, "Borrar logs" y retención): archivo `20261109195504_logs_listen_retention.sql`. Agrega `panel_commands.rf_code` y el tipo `listen_rf`, `installations.logs_cleared_at`, la bitácora `log_purges`, la función `purge_installation_logs` (solo `service_role`) y un disparador que descarta los logs del motivo 5 (control RF desconocido), los anteriores a la última purga y los de más de 30 días; programa con `pg_cron` el trabajo `access-logs-retention` (diario, 09:00 UTC) que borra los logs de más de 30 días. **No hay variables de entorno nuevas.** Los paneles anteriores a este cambio no escuchan ni borran sus logs por orden de la nube (ignoran `listen_rf` y la marca de purga), y siguen registrando el motivo 5 en local (la nube lo descarta). Orden: primero la nube (`db push --remote` y Vercel), después el paquete del panel.
   - `revoke_panel_cleanup` (revocar un panel limpia sus datos): archivo `20261124040116_revoke_panel_cleanup.sql`. Agrega `public.revoke_panel` (solo `service_role`), que revoca el panel y, en la misma transacción, borra lógicamente sus salidas, vínculos de botones (`control_button_panels`) y reglas de perfil, y expira sus órdenes pendientes; los logs se conservan. Al aplicarse limpia los paneles que ya estaban revocados. **No hay variables de entorno nuevas** ni cambios en el panel. Aplicar junto con el despliegue de Vercel que la usa (la web nueva falla al revocar si la función no existe).
   - `deleted_rows_purge` (borrado definitivo): archivo `20261124041857_deleted_rows_purge.sql`. Al borrar (lógicamente) una fila replicada, un trigger vacía sus datos (nombre, departamento, dirección, notas y PIN del titular; código y etiqueta de la tarjeta; descripción del control; código RF del botón; alias de la salida; nombre del perfil; máscaras y horario de la regla) y, al aplicarse, vacía las filas ya borradas sin cambiar su revisión. Agrega `installations.purged_revision` y `private.purge_deleted_rows` (solo `service_role`), que programa con `pg_cron` el trabajo `deleted-rows-purge` (diario, 09:00 UTC): elimina las filas borradas hace más de 30 días y su `audit_log`, las órdenes terminadas y `log_purges` de más de 30 días y los paneles revocados sin actividad en 30 días. Guarda lápidas sin datos (`purged_rows`) para que el push de un panel atrasado no reviva lo eliminado (responde `superseded`); vacía las versiones de `sync_conflicts` de filas borradas y elimina los conflictos revisados de más de 30 días y las importaciones viejas de paneles que ya no esperan revisión. Un panel cuyo cursor es anterior a lo eliminado recibe de `GET /changes` una revisión menor que la suya y reconcilia por checksums en el mismo ciclo (el agente actual ya lo hace), con `confirm_deletions` activo en `/checksums` para no chocar con la guarda de borrados masivos. **No hay variables de entorno nuevas** ni cambios en el panel. Aplicar antes o junto con el despliegue de Vercel (la web nueva lee `purged_revision`).
   - `api_key_rate_limit` (límite de peticiones por minuto por llave): archivo `20261124043917_api_key_rate_limit.sql`. Agrega `api_keys.requests_per_minute` (entero de 1 a 5000, 120 por omisión, así que las llaves existentes no cambian de comportamiento) y reemplaza `create_api_key` (recibe el límite) y `rotate_api_key` (la llave nueva conserva el límite). `authenticated` solo lee la columna; la escribe el servidor. **No hay variables de entorno nuevas** ni cambios en el panel. **Va antes que Vercel:** la web nueva lee `requests_per_minute` y llama a `create_api_key` con el parámetro nuevo, así que sobre la base vieja fallaría; la web vieja sobre la base nueva sigue funcionando (el límite queda en 120).
   - `delete_installation` (eliminar una instalación): archivo `20261124045057_delete_installation.sql`. Agrega `public.delete_installation` (solo `service_role`), que en una transacción borra físicamente todos los datos de la instalación en la nube (titulares, tarjetas y PIN, controles, botones y sus vínculos, perfiles, reglas, salidas, logs, órdenes, conflictos, importaciones, `log_purges`, `purged_rows` y su `audit_log`), sus paneles y la fila de `installations`. Las filas viejas que un panel eliminado dejó en otra instalación (borradas al revocarlo allá) se eliminan con lápida en `purged_rows`. El agente de un panel eliminado recibe 401, borra su credencial, conserva su base local y se vuelve a registrar como pendiente; se reclama en otra instalación e importa sus datos locales como siempre. **No hay variables de entorno nuevas** ni cambios en el panel. **Va antes que Vercel:** la web nueva llama a la función.
   - `api_batch` (lotes de la API pública): archivo `20261124050849_api_batch.sql`. Agrega `private.installation_batches`, reemplaza `private.bump_revision` (modo lote: una escritura con el encabezado `x-acc-batch` de un lote abierto, hecha con la llave secreta, recibe la revisión pendiente sin subir `installations.revision`), agrega `public.api_batch_begin` y `public.api_batch_end` (solo `service_role`) y programa con `pg_cron` el trabajo `api-batches-expire` (cada minuto publica los lotes que una función caída no cerró; un lote caduca a los 70 s, más que los 60 s de `maxDuration`). **No hay variables de entorno nuevas** ni cambios en el paquete del panel (el agente acepta páginas de cambios de cualquier tamaño). **Va antes que Vercel:** la web nueva llama a las funciones de lote; la web vieja sobre la base nueva funciona igual (sin el encabezado, `bump_revision` se comporta como antes).
   - `orphan_panel_rows_cleanup` (filas huérfanas de paneles): archivo `20261124060833_orphan_panel_rows_cleanup.sql`. Corrige un error en producción: un panel revocado que se volvía a registrar (`revoked` a `pending`, sin instalación) conservaba sus salidas, reglas y vínculos vivos en la instalación anterior y `GET /api/v1/installations/{id}/outputs` los seguía devolviendo. Agrega `private.cleanup_orphan_panel_rows` (borrado lógico firmado `system:revocacion`, origen `cloud`, de las salidas, reglas y vínculos vivos cuyo panel tenga otra `installation_id`, y expiración de sus órdenes pendientes; no toca los paneles de la misma instalación) y `public.reregister_revoked_panel` (solo `service_role`), que `POST /api/device/v1/register` usa para pasar `revoked` a `pending` en una transacción, limpiando antes de quitar la instalación. Al aplicarse limpia los huérfanos que ya existen. Además, las listas de salidas, reglas y vínculos (API y web) solo devuelven filas de paneles vigentes de la instalación. **No hay variables de entorno nuevas** ni cambios en el panel. **Va antes que Vercel:** la web nueva llama a `reregister_revoked_panel`; con la web vieja sobre la base nueva todo sigue funcionando.
   - `phones_calls` (apertura por llamada, SIM808): archivo `20261125025657_phones_calls.sql`. Agrega `public.phones` (teléfonos de 10 dígitos de los titulares, número único entre los vivos de la instalación, replicada como `cards`), `public.panel_call_settings` (una fila por panel: `enabled`, `mode` `single`/`menu`, `output_index`, `menu_mask`, `default_output`, `call_limit_per_minute` 1–20, 3 por omisión; la leen los miembros y solo admin la edita) y `profile_panel_rules.allow_call`. Crea la configuración de cada panel con instalación (y `claim_panel`/`import_rows` la crean para los nuevos), y extiende `apply_panel_change` (`phones` y `call_settings`), la importación, el vaciado, la purga, la revocación, los huérfanos y `delete_installation`. **No hay variables de entorno nuevas.** **Orden:** primero la base y enseguida Vercel, después el paquete del panel v8; un panel v7 con la nube nueva ignora teléfonos y llamada. No se revierte la nube con paneles v8.
   - `qr_codes` (códigos QR): archivo `20261126224031_qr_codes.sql`. Agrega `public.qr_codes` (QR de los titulares, replicados como `phones`; el código es único entre los vivos de la instalación y no puede repetir una tarjeta viva; un QR no se edita), `installations.qr_digit` (1–9, 9 por omisión), `qr_max_active` (1–100000, 1000 por omisión) y `qr_settings_revision` (se cambian con `public.set_installation_qr_settings`, solo admin), y `profile_panel_rules.qr_reader_mask` (0 al crear). Un trigger limita los QR vigentes por instalación con candado por instalación, y otro impide tarjetas en el rango de QR. Redefine completas `scrub_deleted_row`, `sync_conflict_scrub`, `push_row_base`, `push_permission_base`, `import_rows`, `unique_conflict_version`, `apply_panel_change`, `purge_deleted_rows` y `delete_installation`. Programa con `pg_cron` el trabajo `qr-codes-expire` (diario, 08:50 UTC, 10 minutos antes de `deleted-rows-purge`): borra los QR vencidos hace más de 30 días y la purga los elimina 30 días después. Las reglas de negocio fallan con SQLSTATE `PT422`, que PostgREST traduce a 422. **No hay variables de entorno nuevas.** **Orden:** primero la base y enseguida Vercel, después el paquete del panel v9; un panel v8 con la nube nueva ignora los QR. No se revierte la nube con paneles v9.
     **Prueba de humo en Access-Core-DEV (obligatoria tras aplicarla):** el modo lote solo se activa si PostgREST pone `role = service_role` en `request.jwt.claims` con la llave secreta nueva (`sb_secret_…`); si no, se desactiva **en silencio** (cada elemento sube la revisión y avisa, como antes). Con una instalación de prueba `<INST>` y `URL`/`SECRET` del proyecto:
     ```bash
     T=$(uuidgen | tr A-Z a-z)
     H=(-H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json")
     # 1. Revisión inicial
     curl -s "$URL/rest/v1/installations?id=eq.<INST>&select=revision" "${H[@]}"
     # 2. Abrir el lote (debe responder true)
     curl -s -X POST "$URL/rest/v1/rpc/api_batch_begin" "${H[@]}" -d "{\"p_installation_id\":\"<INST>\",\"p_token\":\"$T\",\"p_ttl_seconds\":60}"
     # 3. Escribir dentro del lote (crea un titular de prueba)
     curl -s -X POST "$URL/rest/v1/holders" "${H[@]}" -H "x-acc-batch: $T" -H "Prefer: return=representation" \
       -d '{"installation_id":"<INST>","kind":"persona","name":"Prueba lote","updated_by":"prueba","origin":"cloud"}'
     # 4. La revisión NO debe haber cambiado; el titular trae revision = inicial + 1
     curl -s "$URL/rest/v1/installations?id=eq.<INST>&select=revision" "${H[@]}"
     # 5. Cerrar: responde inicial + 1, y ahora installations.revision también
     curl -s -X POST "$URL/rest/v1/rpc/api_batch_end" "${H[@]}" -d "{\"p_installation_id\":\"<INST>\",\"p_token\":\"$T\"}"
     ```
     Si en el paso 4 la revisión ya subió, el claim `role` no vale `service_role`: revisa con `select current_setting('request.jwt.claims', true)` dentro de una función RPC de prueba y no publiques la web nueva hasta corregirlo. Al final borra el titular de prueba (`delete from public.holders where name = 'Prueba lote' and installation_id = '<INST>'` en el SQL Editor).

   Todas van con pruebas pgTAP (`npm run test:db`).

   **Orden obligatorio de la etapa 3 (apertura remota): primero la nube y después los paneles.** (1) `cd cloud && npx supabase db push --remote`, (2) **enseguida** Vercel, y (3) el paquete del panel en cada placa (`bash panel/deploy/build_release.sh` y `sudo ./deploy/install.sh` en la placa). La nube nueva acepta paneles v6 y v7. **Un panel v7 con la nube vieja no puede subir cambios ni vincularse** hasta que se actualiza la nube (la nube vieja rechaza `allow_remote`), y su reconciliación devuelve `allow_remote` a 0. **Para revertir la nube, primero hay que regresar los paneles a v6.**

   **Aviso: un panel v6 con la nube nueva** sigue funcionando, pero en cada reconciliación diaria reemplaza sus permisos, porque la suma de verificación no cuadra (la nube siempre proyecta `allow_remote` y el panel v6 no lo conoce). Actualizarlo a v7 lo resuelve.

   **Aviso: volver a un paquete v6** después de migrar el panel a v7 exige restaurar `access_control_backup_v6.sqlite` (ver `panel/README.md`), porque el código v6 rechaza una base v7.

   **Orden obligatorio al actualizar un proyecto en uso: primero la base y después Vercel.** (1) `npx supabase db push --remote` de las migraciones nuevas y (2) **enseguida**, el despliegue en Vercel de la versión que las acompaña. Entre los dos pasos la aplicación vieja falla, porque ya no existe `control_buttons.output_index`; la aplicación nueva sobre la base vieja también fallaría, por eso no se invierte el orden. Mientras tanto los paneles reintentan solos y el agente viejo de los paneles sigue siendo compatible.
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
   También `https://app.ejemplo.com/docs/api`: la documentación pública de la API (guía `docs/api.md` + OpenAPI, con el visor Scalar), sin sesión y sin recursos externos; no necesita variables nuevas. La página lee `cloud/docs/api.md` al compilar, así que Root Directory debe seguir siendo `cloud`.
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
2. En la placa, el reloj debe estar sincronizado por NTP (`timedatectl` debe decir `System clock synchronized: yes`; `install.sh` habilita NTP). Dos cosas dependen de la hora: si la hora del panel se adelanta más de 5 minutos, la nube ajusta esas marcas a su propia hora y lo registra como conflicto; y la orden **Probar** de la nube (apertura remota de una salida) lleva un `expires_at` de 10 s que el panel compara con **su propio reloj**: con la hora mal, el panel descarta la orden como caducada o la ejecuta tarde. Además, la nube guarda los logs solo 30 días: un panel con la hora muy mal (años atrás o adelantada) sube logs que la nube acepta pero **descarta** por ese filtro de 30 días (no aparecen en la plataforma), así que la hora correcta por NTP también protege el historial.
   - **Actualizar un panel ya instalado:** reinstala el paquete nuevo (`sudo ./deploy/install.sh`), no basta con reiniciar. El daemon ahora crea el socket `/run/acceso/daemon.sock` por el que la web y el agente le piden probar una salida, y eso necesita `RuntimeDirectory=acceso` en `acceso-daemon.service`, que solo instala el paquete nuevo. Sin él, el daemon no puede crear el socket y "Probar" responde "El daemon no responde".
   - **EMQX no cambia.** Las órdenes nuevas (`upload_logs` y `test_output`) viajan por el mismo tema `acc/<código>/cmd`, y el resultado vuelve por HTTPS (`POST /api/device/v1/command-result`), no por MQTT. No hay que tocar las reglas ni el compose del servidor.
3. Abre la página **Nube** del panel (`http://<ip>:8080`): muestra el identificador `PNL-XXXX-XXXX` y el código de vinculación. En la plataforma, un `admin` del tenant: instalación → Paneles → **Vincular panel**, captura los dos datos y, si la instalación ya tenía datos, revisa y confirma la importación.
4. Diagnóstico: `journalctl -u acceso-cloud -f`.
5. **Apertura por llamada (paquete del panel v8, SIM808):**
   - **Orden:** primero la nube (`supabase db push --remote` con `phones_calls` y enseguida Vercel) y después el paquete del panel v8. Un panel v7 con la nube nueva ignora teléfonos y llamada (la nube no le envía `phones`, `call_settings` ni `allow_call` sin el encabezado `X-Acc-Schema: 8`). Un panel v8 con la nube vieja no puede subir cambios ni vincularse (la nube vieja rechaza `allow_call`, `phones` y `call_settings`), y su reconciliación devuelve `allow_call` a 0. Por eso primero se actualiza la nube y después los paneles. **No se revierte la nube con paneles v8** (primero se regresan los paneles a v7 restaurando `access_control_backup_v7.sqlite`).
   - En la placa: `GSM_PORT` en `/etc/acceso/acceso.env` (9600 baudios). Con adaptador USB en Raspberry Pi, `sudo ./deploy/install.sh --sim808-usb VID:PID` crea `/dev/sim808` con una regla udev y fija `GSM_PORT` si estaba vacío; en Orange Pi PC, `/dev/ttyS1` o `/dev/ttyS2` con su overlay, a mano. Hardware, configuración y la prueba manual (CLIP, `ATH`, `ATA`, DTMF): `panel/README.md`, "Apertura por llamada".
   - **Riesgos:** el identificador de llamada se puede falsificar (menor confianza que tarjeta o PIN; apagado por omisión, con límite por minuto y en el log); el modo "Varias salidas" contesta y la llamada puede costarle al que llama; probar DTMF (`AT+DDET`) con el operador real antes de ofrecer el menú.
   - **EMQX no cambia** y no hay variables de entorno nuevas en la nube.
6. **Códigos QR (paquete del panel v9, ZK-QR-500):**
   - **Orden:** primero la nube (`supabase db push --remote` con `qr_codes` y enseguida Vercel) y después el paquete del panel v9. Un panel v8 con la nube nueva ignora los QR (la nube no le envía `qr_codes`, `qr_settings` ni `qr_reader_mask` sin `X-Acc-Schema: 9`). **No se revierte la nube con paneles v9**: primero se regresan los paneles a v8 restaurando `access_control_backup_v8.sqlite`.
   - Lector, casillas por lector, dígito, usos por lector y prueba manual: `panel/README.md`, "Códigos QR".
   - **Riesgos:** el QR se puede fotografiar y compartir (usar vigencias cortas y pocos usos); la vigencia depende del reloj del panel, que debe estar sincronizado por NTP. EMQX no cambia.

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
