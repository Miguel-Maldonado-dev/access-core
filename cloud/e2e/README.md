# Prueba de punta a punta (E2E) de la etapa 1

`run_e2e.sh` levanta la plataforma completa **en tu máquina** y comprueba que el agente `acceso-cloud` del panel y la nube se sincronizan en los dos sentidos. Todo es local: nunca toca el proyecto remoto (Access-Core-DEV) ni Vercel.

```bash
cd cloud
bash e2e/run_e2e.sh        # termina con la línea «E2E OK» y código 0
```

Dura alrededor de un minuto (la primera vez, más, por la descarga de la imagen de EMQX).

## Requisitos

- Docker en marcha y `supabase start` corriendo en `cloud/` (el script lee las llaves locales con `supabase status -o env`; no lee `cloud/.env.local`).
- `psql`, `sqlite3`, `openssl`, `curl`, `perl`, `python3` y `lsof` en el `PATH`.
- El entorno del panel creado en `panel/backend/.venv` (o apunta `PANEL_PYTHON` a otro Python con `acceso`, `httpx` y `paho-mqtt`).
- Los puertos `3100` (aplicación), `18883` (MQTT/TLS), `18084` (API de EMQX) y `18443` (wss de EMQX) libres. Si alguno está ocupado el script falla con un mensaje claro y no toca nada. Se cambian con `E2E_PORT`, `E2E_MQTT_PORT`, `E2E_EMQX_API_PORT` y `E2E_WSS_PORT`.

## Qué hace

1. Crea en un directorio temporal una CA y un certificado de `localhost` (EMQX con TLS), una base SQLite v6 del panel con 1 titular y 1 tarjeta, y los secretos de la prueba.
2. Arranca `next dev` de `cloud/` en el puerto 3100 (con un entorno propio: no usa el `.env.local`) y EMQX 5.8.6 con el `docker-compose.yml` real de `infra/emqx` (proyecto `acceso-e2e-<hex>`, puertos del E2E por variables del compose; `emqx.conf` lo renderiza `render-entrypoint.sh`, igual que en un servidor). Un override temporal solo agrega la API key de la prueba por archivo de arranque. EMQX autentica a los paneles llamando a la aplicación (`/api/mqtt/auth`, con `x-emqx-secret`) y la aplicación publica en EMQX por su API REST.
3. Configura en Vault local `app_url` (`http://host.docker.internal:3100`) y `internal_webhook_secret`, que usa el trigger de avisos (`pg_net`).
4. Crea por SQL y por la API de Auth local un tenant `E2E <hex>`, un administrador `e2e-<hex>@local.test` y una instalación.
5. Arranca `python -m acceso.cloud` con `CLOUD_URL`, `MQTT_URL=mqtts://localhost:18883`, `SSL_CERT_FILE=<CA de la prueba>` y `SYNC_INTERVAL_S=300` (se reinicia con 20 para la fase sin EMQX), sobre la base temporal y con `CLOUD_CREDENTIALS_PATH` temporal (nunca `/etc/acceso`).
6. Reclama el panel por SQL con la misma lógica que `claimPanel`: verifica `sha256(claim_code)` contra `claim_code_hash` (con el código leído de `sync_state` de la base temporal) y llama a `public.claim_panel`. No hay ningún endpoint solo para pruebas.

## Qué comprueba

| Comprobación | Criterio |
|---|---|
| El panel se registra y se reclama | `pending` → `active` |
| Los datos del panel están en la nube | 1 titular y 1 tarjeta, con los mismos UUID |
| Conexión MQTT | el agente registra «Conectado a MQTT» y `panels.online = true` (evento de EMQX hacia `/api/mqtt/events`) |
| Nube → panel | una tarjeta dada de alta con la sesión del administrador (RLS, como la interfaz) llega a la base del panel en menos de 10 s **por aviso MQTT**: en esta fase el agente corre con `SYNC_INTERVAL_S=300` (`E2E_NOTICE_INTERVAL_S`), así que su sincronización periódica no puede cubrir un aviso roto |
| Sin eco | tras aplicar ese cambio, `sync_outbox` del panel sigue vacía |
| Panel → nube | una tarjeta dada de alta con la capa `store` del panel (genera bandeja) llega a la nube en menos de 10 s |
| Logs | un log del panel (`append_log`) aparece en la nube con su titular |
| Respaldo sin MQTT | con EMQX detenido y el agente reiniciado con `SYNC_INTERVAL_S=20`, una tarjeta de la nube llega al panel por la sincronización periódica (≤ 2 × `SYNC_INTERVAL_S` + 15 s) y una del panel (con su log) llega a la nube |
| Lotes de 500 | con el agente detenido, mide un `push` y un `pull` de 500 cambios con el mismo `SyncEngine` contra la API local (referencia, no un criterio de paso) |

Al terminar imprime el resumen con los tiempos y `E2E OK`.

## Qué deja y cómo limpia

Todo lo que crea lleva el nombre `E2E <hex>` y se borra al terminar, **también si algo falla** (trap): detiene el agente y `next dev` (solo los procesos que lanzó) y borra el proyecto de compose y el contenedor `acceso-e2e-emqx-<hex>` (con su volumen); borra por id el tenant (con su cascada), el panel y el usuario de Auth; devuelve Vault a su estado anterior (borra los secretos si no existían; si existían, los restaura); restaura `cloud/next-env.d.ts`, que `next dev` reescribe, y borra el directorio temporal. Al final compara los conteos de las tablas de la base local con los de antes (solo avisa si difieren: otro proceso pudo escribir) y comprueba que no quedan los cuatro puertos del E2E ni el contenedor y que el tenant y el panel de la prueba ya no existen.

Nunca ejecuta `supabase db reset` ni `supabase stop`, y no toca `cloud/.env.local`, `panel/backend/.env` ni `panel/backend/data/`.

## Archivos

- `run_e2e.sh`: el flujo completo.
- `panel_tool.py`: ayudas del lado del panel (crear la base temporal, altas con la capa `store`, logs y las mediciones de lote). Solo opera sobre la base temporal que le da el script.

## Notas y hallazgos

- **`next dev`:** en desarrollo cada ruta compila en su primera petición; el script las «calienta» antes de arrancar el agente para que esa compilación no cuente en los plazos. Los tiempos de lote de 500 son de `next dev` contra el Supabase local: en producción serán distintos (la medición contra el proyecto remoto sigue pendiente).
- **Sincronización periódica:** `SYNC_INTERVAL_S` solo se puede cambiar por entorno para esta prueba (`acceso/cloud/runner.py`); en el panel real vale 300.
- **Configuración de EMQX:** la prueba comprueba además que EMQX no registre `cert_file_not_found` ni `failed_to_resolve` al arrancar y que su log no contenga el secreto del webhook. (En una corrida real el log de EMQX 5.8.6 no interpreta ni registra `EMQX_WEBHOOK_SECRET` a pesar del prefijo `EMQX_`: solo lista las sobrescrituras que reconoce, p. ej. `EMQX_NODE__COOKIE`.) (EMQX 5.8 no sustituye variables de entorno en HOCON; por eso `infra/emqx/emqx.conf` es una plantilla que renderiza `render-entrypoint.sh`.)
- La prueba valida la ACL de forma indirecta (el panel solo suscribe a su `cmd` y publica en su `evt`/`status`; si la ACL negara algo, el agente se desconectaría). No hay prueba negativa de ACL con un segundo cliente.
