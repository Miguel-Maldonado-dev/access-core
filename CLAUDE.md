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
  - dos servicios systemd: `acceso-daemon` (UART y autorización) y `acceso-web` (API y web local en el puerto 8080);
  - configuración en `/etc/acceso/acceso.env`.
- **Esquema v5:** `holders` (persona o domicilio, PIN único de 4–6 dígitos), `cards`, `controls`, `control_buttons`, `permissions` (`output_mask`, `card_reader_mask`, `pin_reader_mask`, `allow_rf`, días y horario), `holder_permissions`, `outputs` y `access_logs`.
- **Migraciones:** `acceso/migrate.py`, con bloqueo de archivo, una transacción y respaldo atómico en modo 0600 (máximo 3 copias).
- **Frontend (`panel/frontend`):** Next.js con exportación estática que sirve el backend; pruebas con Vitest.
- **Pruebas:**
  - backend: `cd panel/backend && .venv/bin/pytest` (197 pruebas);
  - frontend: `cd panel/frontend && npm test` (56 pruebas), además de `npm run lint` y `npm run build`.
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

## Estado (2026-10-26)

- **Panel local:** terminado y en uso (PIN, permisos por método y abreviaturas).
- **Plataforma en la nube:**
  - **diseño aprobado** en `docs/superpowers/specs/2026-10-26-plataforma-nube-design.md`;
  - **plan de la etapa 1** (ver y sincronizar) en `docs/superpowers/plans/2026-10-26-plataforma-nube-etapa1.md`, con Next.js + Supabase + EMQX y el agente `acceso-cloud` en el panel;
  - **aún no se implementa**: el dueño pidió solo el plan. Falta que lo revise y elija cómo ejecutarlo; se recomendó subagent-driven.
  - Después vienen la etapa 2 (API pública y webhooks), la 3 (apertura remota) y la 4 (QR temporales).
- **Pendientes del dueño en hardware:**
  - probar el teclado real;
  - instalar en la Orange Pi;
  - correr `PRAGMA foreign_key_check` en la base de la placa antes de instalar el esquema v5.
- **Opcional ofrecido:** que `build_release.sh` no meta metadatos de macOS en el `.tar.gz`, que causan avisos inofensivos de `tar` en la placa.
