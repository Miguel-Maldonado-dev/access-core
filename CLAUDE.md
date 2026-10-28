# CLAUDE.md — access-core

Contexto para Claude Code. Léelo antes de trabajar en este repositorio.

## El dueño y cómo trabajar con él

- Habla español: responde en español, y toda la interfaz y los mensajes de error van en español.
- Es el dueño del hardware y del proyecto. Prueba en la placa real y reporta lo que ve.
- Prefiere acción y respuestas concisas. Si repite una petición sin contestar preguntas, avanza con decisiones razonables y dilas en una línea.
- Proceso con skills de superpowers:
  1. brainstorming → diseño en `docs/superpowers/specs/`;
  2. writing-plans → plan en `docs/superpowers/plans/`;
  3. implementación con subagent-driven-development (revisor por tarea y revisión final).
- **Git:** las funcionalidades nuevas se desarrollan en la rama `develop`. Ni Claude ni sus subagentes hacen commits ni merges: dejan los cambios sin confirmar y el dueño los confirma y fusiona.
- En los diseños, las decisiones que no tomó el dueño se marcan **[decisión de Claude]**.
- Para la interfaz se usan las skills `frontend-design` y `vercel-react-best-practices`; para SQLite, `sqlite-database-expert`.

## Qué es

Control de acceso para fraccionamientos:
- una placa propia con **ATmega328P** (TQFP) lee 4 lectores Wiegand (tarjeta y teclado PIN), RF 433 MHz y 2 botones de salida, y acciona 4 relevadores;
- una **Raspberry Pi 3B** u **Orange Pi PC (H3)** recibe los eventos por UART, decide con su base SQLite y ordena abrir.

| Carpeta | Contenido |
|---|---|
| `firmware/Firmware-Control-Acceso/` | Firmware (Arduino Uno). Librería rc-switch 2.6.4; `Wiegand34` va junto al sketch |
| `panel/` | Software de la placa: daemon UART + web local. Ver `panel/README.md` |
| `tools/tkinter/` | Administrador y simulador Tkinter (anteriores al panel web) |
| `docs/protocolo/` | Protocolo UART v2.2 |
| `docs/superpowers/` | Diseños y planes |
| `cloud/` | (aún no existe) plataforma en la nube |

## Hardware (mapa de pines del ATmega)

- **D2 (INT0):** receptor RF 433 MHz (RCSwitch), con filtro de repetición de 3 s.
- **Lectores Wiegand 1–4 (D0/D1):** D3/D4, D5/D6, D7/D8 y D9/D10.
- **D11 y D12:** botones de salida con pull-up interno. Al leer LOW abren directamente el relevador 1 o 2 y avisan con `0x12`.
- **Relevadores 1–4:** A0–A3 (PC0–PC3) a través de un **ULN2803**, así que se activan en **HIGH**.
- **Libres:** D13, A4 y A5.
- **Teclado Hikvision DS-K1802EK:** envía cada tecla como una ráfaga Wiegand de 4 bits (`*` = 0x0A, `#` = 0x0B). Si se teclea rápido llegan ráfagas juntas de 8, 12 o 16 bits, que el firmware separa.
- **UART de la placa:**
  - Pi 3B: `/dev/serial0`, con `dtoverlay=disable-bt`;
  - Orange Pi PC: UART3, `/dev/ttyS3` (overlay `uart3`).
- Las soldaduras SMD del micro ya fallaron una vez. `firmware/Prueba_Relevadores` sirve para revisar los relevadores.

## Protocolo UART v2.2

Formato: `AA CMD … CS 55`, donde `CS` es el XOR de los bytes de CMD hasta el último dato. Documento completo: `docs/protocolo/protocolo_uart_panel_control_acceso_v2.md`.

| CMD | Sentido | Trama |
|---|---|---|
| `0x10` tarjeta | ATmega → controlador | `AA 10 RR C1..C4 CS 55` |
| `0x11` RF | ATmega → controlador | `AA 11 C1..C4 CS 55` |
| `0x12` botón | ATmega → controlador | `AA 12 BB CS 55` |
| `0x13` PIN | ATmega → controlador | `AA 13 RR LL D1..D6 CS 55` (`#` envía, `*` borra, máximo 6 dígitos, 10 s de inactividad) |
| `0x20` relevador | controlador → ATmega | `AA 20 RR T1 T2 CS 55` |

Un cambio al protocolo toca el firmware, el documento y el daemon (`panel/backend/acceso`) en el mismo cambio.

## Panel (`panel/`)

- **Backend (`panel/backend`, paquete `acceso`):**
  - Python ≥ 3.9, FastAPI, pyserial y SQLite en modo WAL;
  - tres servicios systemd: `acceso-daemon` (UART y autorización), `acceso-web` (API y web local en el puerto 8080) y `acceso-cloud` (agente de sincronización con la nube, paquete `acceso.cloud`);
  - configuración en `/etc/acceso/acceso.env`; credenciales de la nube en `/etc/acceso/cloud.env` (0600, `acceso:acceso`).
- **Esquema v6:** `holders` (persona o domicilio, PIN único de 4–6 dígitos), `cards`, `controls`, `control_buttons`, `permissions` (`output_mask`, `card_reader_mask`, `pin_reader_mask`, `allow_rf`, días y horario), `holder_permissions`, `outputs` (con `alias`) y `access_logs`. Las tablas replicadas llevan `uuid`, `updated_at` y `origin`; `sync_outbox` (con triggers y la guarda `sync_guard`) y `sync_state` sirven a la sincronización.
- **Migraciones:** `acceso/migrate.py`, con bloqueo de archivo, una transacción y respaldo atómico en modo 0600 (máximo 3 copias).
- **Frontend (`panel/frontend`):** Next.js con exportación estática que sirve el backend; pruebas con Vitest.
- **Pruebas:**
  - backend: `cd panel/backend && .venv/bin/pytest` (453 pruebas);
  - frontend: `cd panel/frontend && npm test` (69 pruebas), además de `npm run lint` y `npm run build`.
- **Paquete:** `panel/deploy/build_release.sh` genera `panel/dist/acceso-panel-AAAAMMDD.tar.gz`; se instala en la placa con `deploy/install.sh`. Último paquete: 20261021 (PIN, permisos v5 y abreviaturas).
- **Desarrollo en Mac:**
  - `panel/backend/.env` (ignorado por git), con `UART_PORT=/dev/cu.usbmodem…`;
  - base de prueba en `panel/backend/data/`;
  - el simulador Tkinter y el daemon no pueden compartir el puerto serie.

## Convenciones

- Los códigos de tarjeta y RF se muestran **en decimal**.
- **El PIN nunca aparece en logs ni en el journal:** los logs de PIN llevan `code = NULL`. Las listas exponen `has_pin`, no el PIN.
- **Bloqueo de PIN:** 5 fallos en 5 minutos bloquean ese lector durante 5 minutos (motivo 10).
- **Tabla de permisos:** abrevia `S1–S4` (salidas) y `L1–L4` (lectores).
- **Errores de la API:** `{"detail": "<texto en español>"}`.
- **Nunca subir** bases SQLite, respaldos ni `.env`: tienen nombres reales y PIN en texto plano. El repositorio es **público**.

## Estado (2026-10-28)

- **Panel local:** terminado y en uso (PIN, permisos por método y abreviaturas). En `develop`, sin confirmar: esquema v6, agente `acceso-cloud` y página "Nube".
- **Plataforma en la nube (`cloud/`):**
  - **etapa 1 implementada** en `develop` (sin confirmar), con revisión por tarea y revisión final: Next.js 16 + Supabase + EMQX. Diseño en `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md`, plan en `docs/superpowers/plans/2026-10-26-plataforma-nube-etapa1.md` y decisiones de Claude en `docs/superpowers/plans/2026-10-26-plataforma-nube-etapa1-decisiones.md`;
  - cuentas creadas con correo y contraseña (autoconfirmadas), sin invitaciones;
  - **pruebas:** `cd cloud && npm test` (392), `npx supabase test db` (295, contra el Supabase local) y el E2E local `bash cloud/e2e/run_e2e.sh`; despliegue en `cloud/docs/despliegue.md`;
  - **pendiente del dueño:** confirmar los commits; aplicar en Access-Core-DEV las migraciones que faltan (`sync`, `notify`, `tenant_admin_guard`, `conflicts_review` y `claim_panel_neutral_author`), alinear su historial y configurar Auth; Vercel y el servidor de EMQX.
  - Después vienen la etapa 2 (API pública y webhooks), la 3 (apertura remota) y la 4 (QR temporales).
- **Desarrollo de la nube en la Mac:** Supabase local (`cd cloud && npx supabase start`), `cloud/.env.local` (ignorado). Si la web del panel ocupa el puerto 3000, la nube arranca en el 3001. El agente del panel se prueba con `CLOUD_URL=http://localhost:3001 MQTT_URL= CLOUD_CREDENTIALS_PATH=data/cloud.env .venv/bin/python -m acceso.cloud` desde `panel/backend`.
- **Python en la placa:** `constraints.txt` fija `anyio` 4.15.1, que pide Python ≥ 3.10; confirmar la versión de la placa antes de instalar.
- **Pendientes del dueño en hardware:**
  - probar el teclado real;
  - instalar en la Orange Pi;
  - correr `PRAGMA foreign_key_check` en la base de la placa antes de instalar el esquema v5.
- **Opcional ofrecido:** que `build_release.sh` no meta metadatos de macOS en el `.tar.gz`, que causan avisos inofensivos de `tar` en la placa.
