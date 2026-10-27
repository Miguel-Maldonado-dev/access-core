# Plataforma en la nube para paneles de control de acceso — Diseño

**Fecha:** 2026-10-26
**Estado:** borrador para revisión
**Base existente:** el panel local (`panel_web/`, esquema v5) y el protocolo UART v2.2 (`resources/protocolo_uart_panel_control_acceso_v2.md`)

Las decisiones marcadas **[decisión de Claude]** son propuestas que el dueño aceptó en conjunto, sin discutirlas una por una. Todo lo demás lo decidió el dueño durante la conversación.

## 1. Intención

La plataforma es un **middleware** entre:
- la **app de gestión de fraccionamientos** de cada instalador, que es externa y no forma parte de este proyecto; crea domicilios y residentes, asigna medios de acceso y maneja cuotas y reglas de negocio;
- los **paneles de control de acceso** instalados en sitio: una Raspberry Pi u Orange Pi con el ATmega y el software local actual.

La app externa decide **quién debe poder entrar** y usa la API de la plataforma para aplicarlo; por ejemplo, agregar una tarjeta a un domicilio. La plataforma guarda ese estado, lo sincroniza con los paneles en los dos sentidos, recibe sus logs y, en una etapa posterior, envía aperturas remotas. El panel sigue decidiendo localmente, aunque no haya internet.

Los residentes nunca entran a esta plataforma. La usan el dueño de la plataforma y el personal de los instaladores.

## 2. Objetivos, no objetivos y anti-objetivos

### Objetivos
1. Cada panel tiene un **identificador** que permite reconocerlo y controlarlo de forma remota.
2. Hay **tenants** (instaladores) con sus usuarios administrativos. Cada tenant crea **instalaciones**, por ejemplo "Fraccionamiento 1", y en cada instalación vincula **uno o más paneles**.
3. Los datos de los paneles se **ven y administran desde la nube**, y se **sincronizan en los dos sentidos**:
   - de forma inmediata cuando hay un cambio;
   - además, de forma periódica.
   - Un cambio hecho en el panel local también sube a la nube.
4. Se expone una **API pública**, autenticada con una llave por tenant, para que la app externa gestione todas las instalaciones de su instalador. La instalación funciona como filtro.
5. **Aperturas remotas** pedidas desde la app externa: por ejemplo, el residente presiona "Abrir" en su app móvil. El panel valida y abre.
6. Más adelante, **códigos QR temporales**, con vigencia por fechas y horario y una cantidad máxima de usos.

### Prioridad (lo que más importa en la primera versión)
**Poder ver los datos en la nube y que la sincronización funcione.**

### Etapas [decisión de Claude]
1. **Ver y sincronizar:**
   - identificador y vinculación de paneles;
   - tenants, usuarios, instalaciones y paneles;
   - sincronización en los dos sentidos de titulares, tarjetas, controles RF, PIN, permisos y salidas;
   - subida de logs;
   - pantallas en la nube para ver y editar esos datos, más el estado en línea de cada panel.
2. **API pública:** llaves por tenant y webhooks hacia la app externa.
3. **Apertura remota:** puertas, el permiso de apertura remota en el panel y el endpoint de apertura con confirmación.
4. **QR temporales.**

### No objetivos
- **Residentes y negocio:** gestionar residentes, cuotas, cobranza o reglas de negocio del fraccionamiento. Todo eso es de la app externa.
- **App móvil:** la app de los residentes es la app externa, no forma parte de esta plataforma.
- **Firmware:** actualizar el firmware del ATmega o el software del panel de forma remota (OTA). Queda para después.
- **Facturación:** cobrar a los tenants.

### Anti-objetivos (lo que lo haría fracasar aunque funcione)
- **Puertas sin servicio por falta de red:** que una caída de internet, de la nube o del broker deje las puertas sin funcionar. El panel siempre decide con sus datos locales.
- **Datos cruzados entre tenants:** que un tenant vea o modifique datos de otro.
- **Borrados masivos:** que un error de sincronización borre de golpe los datos de un panel.
- **Fuga de PIN:** que se filtren PIN, llaves de API o credenciales de los paneles.
- **Aperturas fraudulentas:** que una orden de apertura vieja o repetida abra una puerta.

## 3. Lo que existe hoy (panel)

- **Firmware ATmega328P:** maneja 4 lectores Wiegand (tarjeta y teclado), RF de 433 MHz, 2 botones de salida y 4 relevadores. El protocolo UART es v2.2, con los comandos `0x10`, `0x11`, `0x12` y `0x13` hacia el controlador y `0x20` hacia el ATmega.
- **Placa (`panel_web/`):** corre dos servicios systemd:
  - `acceso-daemon`: lee el UART, decide y escribe en la base SQLite;
  - `acceso-web`: FastAPI con el panel web local en Next.js estático e inicio de sesión del `.env`.
- **Esquema local v5:**
  - `holders` (titular persona/domicilio, con PIN único);
  - `cards`;
  - `controls` y `control_buttons`, donde cada botón tiene su salida;
  - `permissions`: salidas, `card_reader_mask`, `pin_reader_mask`, `allow_rf`, días y horario;
  - `holder_permissions`;
  - `outputs`, 4 por panel, con duración, lectores que la abren y si está habilitada;
  - `access_logs`, con copias del nombre del titular y de la etiqueta del medio.
  - Los identificadores locales son enteros.
- **Migraciones:** bajo bloqueo de archivo, con respaldo atómico. Ambos servicios migran al arrancar.

## 4. Arquitectura

```text
 App de gestión del fraccionamiento (externa, por instalador)
          │  HTTPS  (API pública /api/v1, llave del tenant)        ▲ webhooks (etapa 2)
          ▼                                                        │
 ┌──────────────────────── Plataforma en la nube ──────────────────┴───────────┐
 │  Next.js (Vercel)                                                           │
 │   · Interfaz web (súper admin, administradores y técnicos de cada tenant)   │
 │   · API pública /api/v1 · API de dispositivos /api/device/v1                │
 │   · Webhook del broker /api/mqtt/events                                     │
 │                                                                             │
 │  Supabase: Postgres (+ RLS por tenant) · Auth (usuarios de la plataforma)   │
 │                                                                             │
 │  Broker MQTT (EMQX en un servidor pequeño): avisos de sincronización,      │
 │  estado en línea (LWT), órdenes de apertura (etapa 3)                       │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  │ MQTT/TLS + HTTPS, conexiones abiertas por el panel
                                  ▼
 ┌──────────────────────────── Panel (Raspberry / Orange Pi) ──────────────────┐
 │ acceso-cloud (NUEVO): agente de sincronización (MQTT + HTTPS)               │
 │ acceso-daemon (igual; etapa 3: socket local para aperturas remotas)         │
 │ acceso-web (igual + página "Nube": ID, código de vinculación, estado)       │
 │ SQLite local (v6: UUID, marcas de cambio, bandeja de salida)                │
 └──────────────────────────────── UART ── ATmega328P ── lectores/relevadores ─┘
```

- **Tecnología (decidida por el dueño):** front en **Next.js** y **Supabase** para base de datos y autenticación. Se hace un backend propio solo si hace falta.
- **[decisión de Claude] Un solo proyecto Next.js** contiene la interfaz, la API pública, la API de dispositivos y el receptor de eventos del broker. No hay un backend separado, porque toda la comunicación con el broker se hace por su API HTTP y sus webhooks, sin conexiones persistentes en el servidor.
- **[decisión de Claude] Broker MQTT:** **EMQX de código abierto en un servidor virtual pequeño** (Docker), por la escala del primer año (sección 14). Los planes gratuitos o baratos de brokers administrados no traen todo lo necesario: credenciales por dispositivo, ACL por tópico, API HTTP para publicar y reenvío de eventos por webhook. Ese servidor solo corre el broker; la lógica sigue en Next.js. Se habilita también MQTT sobre WebSockets en el puerto 443, por si la red de un sitio bloquea el 8883. Se elige MQTT porque el panel inicia la conexión (no hay que abrir puertos en el router), tiene *last will* para saber si un panel está en línea, y sirve tanto para los avisos como para las aperturas.
- **[decisión de Claude] Hospedaje:** Next.js en Vercel y un proyecto en Supabase Cloud, con ambientes separados de desarrollo y producción.

## 5. Modelo de datos en la nube

### Organización
- **`platform_admins`:** usuarios súper administradores, que son el dueño de la plataforma. Crean tenants y su primer administrador.
- **`tenants`:** cada instalador.
- **`tenant_members`:** `user_id` (Supabase Auth), `tenant_id` y `role`. Los roles son **[decisión de Claude]**:
  - **`admin`:** crea instalaciones, vincula paneles, gestiona usuarios del tenant, llaves de API y webhooks, y edita datos;
  - **`tecnico`:** consulta y edita datos de instalaciones y paneles, pero no gestiona usuarios, llaves ni webhooks.
- **`installations`:** pertenecen a un tenant y tienen nombre.
- **`panels`:**
  - identidad y vinculación: `installation_id` (nulo hasta vincularse), `panel_code` (el identificador, único global), estado de vinculación y hash de la credencial del dispositivo;
  - estado y monitoreo: `online` y `last_seen_at`, versiones de software y esquema, revisión sincronizada y fecha de la última sincronización.

### Datos de acceso, replicados con los paneles
- **Nivel instalación:** se copian a **todos** los paneles de la instalación, para que un residente entre igual por la caseta que por el acceso peatonal. Son las mismas entidades que el esquema local v5:
  - `holders`;
  - `cards`, con código único dentro de la instalación;
  - `controls` y `control_buttons`, con código RF único dentro de la instalación;
  - **`access_profiles`** (perfiles de acceso, por ejemplo "Residente" o "Servicio") y **`holder_profiles`** (qué perfiles tiene cada titular).
- **Nivel panel:**
  - **`outputs`:** las 4 salidas de cada panel físico, cada una con un **alias** (por ejemplo "Pluma vehicular" o "Puerta peatonal"), además de su duración, sus lectores y si está habilitada. Lo pidió el dueño.
  - **`profile_panel_rules`:** la regla de cada perfil **en cada panel**: salidas, lectores de Tarjeta, lectores de PIN, control RF, días y horario (en la etapa 3 también la apertura remota). Si un perfil no tiene regla en un panel, en ese panel no da acceso.
- **Permisos en dos niveles (lo pidió el dueño):** el perfil se define y se asigna a nivel instalación; lo que permite se configura en cada panel. Por ejemplo, el perfil "Residente" puede permitir tarjetas y control RF en el panel vehicular, y solo PIN en el peatonal.
  - **Correspondencia con el panel local [decisión de Claude]:** cada panel recibe en su tabla local `permissions` una fila por perfil, con la regla de ese panel (una regla inexistente llega como fila con todas las máscaras en 0). `holder_permissions` es igual en todos los paneles. Así **la lógica de autorización del panel no cambia**. El número de perfil se traduce al `permission_id` local (0 a 31), lo que limita a **32 perfiles por instalación**.
  - **Control RF con varios paneles:** cada panel tiene su propio receptor RF, y el botón de un control indica una salida por número (S1 a S4). Si los dos paneles están al alcance del mismo control, los dos recibirían la señal. La regla por panel lo resuelve: basta con no permitir control RF en la regla del panel que no debe abrir.
  - **Permisos editados en el panel local [decisión de Claude]:** editar un permiso en la web local edita la regla de ese perfil **para ese panel**. Crear un permiso en la web local crea un perfil nuevo en la instalación, con regla solo en ese panel.
- **Columnas comunes de cada registro replicado:**
  - **`id`:** UUID global, el mismo en la nube y en todos los paneles;
  - **`installation_id`:** también va en `outputs` y `profile_panel_rules`, junto con su `panel_id`;
  - **`updated_at`:** momento del cambio en su origen, con hora sincronizada por NTP;
  - **`updated_by`:** usuario, llave de API o panel que hizo el cambio;
  - **`origin`:** `cloud` o `panel:<id>`;
  - **`deleted_at`:** borrado lógico **solo en la nube**, para que el borrado se sincronice. En el panel el borrado es real (ver sección 7);
  - **`revision`:** número creciente por instalación, que se asigna en cada cambio aceptado.
- **PIN:** se guarda de forma que la nube pueda enviarlo a los paneles, porque el panel compara el PIN escrito.
  - **[decisión de Claude]** Se cifra en reposo a nivel de columna (Supabase Vault o pgsodium). Solo se descifra en el servidor al sincronizar o cuando un administrador lo consulta.
  - Las listas y la API exponen `has_pin`, como hoy en el panel local.

### Logs y auditoría
- **`access_logs`:** llevan `panel_id` y el `log_id` local, y son idempotentes por `(panel_id, local_log_id)`.
  - Son de solo inserción y nunca guardan dígitos de PIN, igual que en el panel.
  - Se conservan **12 meses [decisión de Claude]**.
- **`audit_log`:** registra cada cambio hecho desde la nube: quién, qué y cuándo.
- **`sync_conflicts`:** registra los conflictos resueltos, para revisarlos.

### Seguridad de datos
- **RLS:** todas las tablas del tenant tienen RLS por `tenant_id`.
- **Llave de servicio:** la `service_role` de Supabase solo se usa en el servidor de Next.js. Nunca llega al navegador ni a los paneles.

## 6. Identificador y vinculación del panel

- **Identificador [decisión de Claude]:** al instalarse por primera vez, el panel genera:
  - un **`panel_code`** corto, aleatorio y legible, por ejemplo `PNL-7KQ2-9XHD` (base32, sin caracteres ambiguos);
  - un **código de vinculación** de un solo uso, de 8 caracteres, que se regenera si se desvincula.

  Los dos se ven en una página nueva **"Nube"** del panel web local, y el `panel_code` también en una etiqueta física.
- **Vinculación:**
  1. Un administrador del tenant, dentro de una instalación, captura el `panel_code` y el código de vinculación.
  2. La nube valida el par: sin el código no se puede reclamar un panel ajeno.
  3. La nube marca el panel como reclamado y prepara una **credencial de dispositivo**. Solo guarda su hash.
  4. El agente `acceso-cloud`, que consulta periódicamente `/api/device/v1/activation`, demuestra que conoce el código de vinculación y recibe la credencial.
  5. El panel guarda la credencial en `/etc/acceso/cloud.env`, con modo 600 y dueño `acceso`.
- **Uso de la credencial:** autentica el HTTPS de la API de dispositivos y el MQTT. Los ACL limitan a cada panel a sus propios tópicos.
- **Desvinculación y reemplazo:** desde la nube se revoca la credencial. El panel vuelve a modo local y genera un código de vinculación nuevo.
- **Primer panel de una instalación nueva [decisión de Claude]:** sus datos locales **suben** y se vuelven los datos de la instalación.
- **Panel que se agrega a una instalación con datos [decisión de Claude, por la revisión]:** antes de reemplazar nada, la plataforma muestra lo que **solo existe en ese panel**: titulares, tarjetas, controles y PIN que la nube no tiene.
  - El administrador puede **importarlos** a la instalación. La importación solo agrega: los choques de código de tarjeta, código RF o PIN con otro titular se listan y no se importan.
  - Los permisos locales de ese panel se importan como perfiles nuevos, con regla solo en ese panel.
  - Después el panel guarda un respaldo local y adopta los datos de la nube. Sus `outputs` propios se conservan.
  - Así nadie se queda afuera por vincular un segundo panel que tenía datos propios.

## 7. Sincronización

### Principios
- **El panel nunca deja de decidir con su base local.** La sincronización corre en segundo plano y no bloquea al daemon.
- **Ambos sentidos:** lo de la nube baja al panel y lo del panel local sube a la nube.

### De la nube al panel
1. Cada cambio aceptado en la nube aumenta la `revision` de la instalación.
2. La nube publica un aviso MQTT `sync` (QoS 1) en el tópico de cada panel de esa instalación.
3. El agente pide `GET /api/device/v1/changes?since=<revision>` y aplica los cambios en una transacción local, en orden: altas, cambios y borrados. **En el panel los borrados son reales (`DELETE`)**, porque el daemon no filtra registros marcados: una tarjeta marcada como borrada seguiría abriendo [decisión de Claude, por la revisión].
4. El agente guarda la nueva revisión.

### Del panel a la nube
- **Bandeja de salida local:** triggers de SQLite en el panel registran en `sync_outbox` cada alta, cambio o borrado hecho por la web local. Un borrado guarda el UUID del registro en la bandeja antes de eliminarlo. El daemon no cambia los datos de configuración; solo agrega logs.
- **Envío:** el agente envía la bandeja con `POST /api/device/v1/changes`, de forma idempotente por id de cambio.
- **Respuesta:** la nube responde con la revisión asignada o con la resolución de un conflicto.

### Conflictos
- **Regla:** si el mismo registro cambió en los dos lados desde la última sincronización, **gana el `updated_at` más reciente**. En empate, gana la nube.
- **Registro:** el conflicto se guarda en `sync_conflicts`, con ambas versiones.
- **Unicidad (código de tarjeta, código RF, PIN):** si el choque es con otro registro, el cambio del panel se rechaza, queda en `sync_conflicts` y se notifica. No se sobrescribe a otro titular.

### Respaldo y salud
- **Sincronización periódica:** cada **5 minutos [decisión de Claude]** se hace pull y push aunque no haya llegado ningún aviso.
- **Reconciliación diaria [decisión de Claude]:** se compara una huella (hash) por tabla. Si difiere, se hace una resincronización completa de esa tabla.
- **Protección contra borrados masivos [decisión de Claude]:** si un lote de cambios de bajada borraría más del 20 % de los titulares o tarjetas de un panel, el agente no lo aplica, lo reporta y espera confirmación desde la nube.

### Logs
- **Subida:** el agente sube los logs nuevos en lotes de 500, idempotentes.
- **Sin internet:** se acumulan localmente, dentro del límite `LOG_MAX_ENTRIES`, y se suben al reconectar.

### Estado en línea
- **Conexión:** el agente mantiene la conexión MQTT con *keepalive* y *last will* retenido en `acc/<panel_code>/status`.
- **Registro en la nube:** el broker reenvía conexión y desconexión por webhook a `/api/mqtt/events`, que actualiza `online` y `last_seen_at`.

### Tópicos MQTT [decisión de Claude]
| Tópico | Sentido | Uso |
|---|---|---|
| `acc/<panel_code>/cmd` | nube → panel | `sync`; `open` (etapa 3) |
| `acc/<panel_code>/evt` | panel → nube | confirmaciones de órdenes y eventos de estado |
| `acc/<panel_code>/status` | panel → nube (retenido, LWT) | `online` / `offline` |

El volumen de datos viaja por HTTPS. Por MQTT solo van avisos y órdenes pequeñas.

## 8. API pública (etapa 2)

- **Base:** REST en `/api/v1`, documentada con OpenAPI.
- **Autenticación:** con **llave de API del tenant**, que se envía en `Authorization: Bearer`. La nube solo guarda su hash. Un tenant puede tener varias llaves con nombre, revocarlas y rotarlas.
- **Alcance:** todas las instalaciones del tenant. `installation_id` funciona como filtro o como parte de la ruta.
- **Recursos:**
  - instalaciones y paneles, de solo lectura, con su estado;
  - titulares (domicilios y personas), tarjetas, controles con sus botones y PIN (escribir, o generar uno aleatorio);
  - perfiles de acceso, sus reglas por panel y su asignación a titulares;
  - salidas con su alias, de solo lectura;
  - logs, con filtros de fecha, titular, resultado y origen;
  - en la etapa 3, puertas y apertura.
- **Escrituras:** cada escritura aceptada dispara la sincronización inmediata de la instalación. La respuesta indica la revisión, y un endpoint de estado indica si cada panel ya la aplicó.
- **Robustez:** las escrituras admiten **`Idempotency-Key`**. Hay límite de peticiones por llave. Los errores van en JSON `{code, message}` con mensajes en español.
- **Webhooks hacia la app externa:**
  - eventos: cambios originados en un panel local (por ejemplo, una tarjeta dada de alta en sitio), conflictos, panel en línea o fuera de línea, y opcionalmente logs nuevos;
  - firmados con HMAC y con reintentos.

## 9. Apertura remota (etapa 3)

- **Puertas:** una puerta es una **salida con alias** de un panel (por ejemplo "Pluma vehicular"), así que no hace falta otra tabla [decisión de Claude]. La API lista las salidas con su alias, y la app externa abre por el identificador de la salida sin saber qué relevador es.
- **Flujo:**
  1. La app externa llama `POST /api/v1/outputs/{id}/open` con `holder_id` (el domicilio) y `requested_by` (texto, por ejemplo "Juan — CASA 123").
  2. La nube publica `open` en `acc/<panel_code>/cmd` con `command_id`, `expires_at` (ahora + 10 s), titular, salida y solicitante.
  3. El agente descarta la orden si ya caducó o si su `command_id` ya se usó.
  4. Si es válida, la pasa al daemon por un **socket Unix local** (`/run/acceso/daemon.sock`).
  5. El daemon valida como con cualquier credencial: el titular existe y algún permiso con **"Permitir apertura remota"** cubre la salida, el día y el horario. Si se cumple, envía `0x20`.
  6. El daemon registra el log con el origen nuevo **"Remota"**, la copia del titular y el solicitante, y responde al agente.
  7. El agente publica la confirmación en `acc/<panel_code>/evt`.
  8. La API espera la confirmación hasta **5 s [decisión de Claude]** y responde abierto, denegado (con motivo) o "panel sin conexión".
- **Cambios en el panel:** el permiso local suma la columna `allow_remote` y la cuadrícula del panel web local suma esa casilla, al lado de "Permitir control RF". El log local suma el origen `4` = "Remota".

## 10. Códigos QR temporales (etapa 4)

- **Lectura:** el lector QR envía el código por Wiegand, igual que una tarjeta.
- **Credencial temporal:** el QR es una credencial con:
  - vigencia: fecha de inicio y fin, y franja horaria;
  - `max_uses` y `uses`;
  - titular asociado (por ejemplo, el domicilio que invita);
  - salidas permitidas.

  La crea la app externa por la API, y es dinámica (se puede revocar o reemplazar).
- **Validación:** el panel la valida localmente y descuenta un uso. Los usos suben con los logs y la nube los consolida.
- **Riesgo aceptado:** con varios paneles desconectados, un QR de N usos podría usarse más de N veces. Se documenta y se decidirá al llegar a esta etapa.

## 11. Interfaz de la plataforma (Next.js)

- **Súper administrador:** tenants (alta, suspensión) y primer usuario de cada tenant.
- **Usuarios del tenant:**
  - **Instalaciones:** lista y alta.
  - **Detalle de una instalación:**
    - paneles: estado en línea, última sincronización, revisión y versión;
    - vincular y desvincular paneles;
    - titulares, tarjetas y controles, con las mismas pantallas y reglas que el panel local;
    - perfiles de acceso, con un editor de reglas por panel: una columna por panel, con salidas por alias, lectores de Tarjeta y PIN, RF, días y horario;
    - salidas por panel, con su alias;
    - logs con filtros;
    - conflictos de sincronización.
  - **Administración:** usuarios del tenant (solo `admin`); llaves de API y webhooks (etapa 2, solo `admin`).
- **Presentación:** todo en español. Los códigos se muestran en decimal, igual que en el panel local.

## 12. Cambios en el panel (resumen por etapa)

- **Etapa 1:**
  - esquema local **v6**, migrado con las mismas garantías de siempre: `uuid`, `updated_at` y `origin` en las tablas replicadas (sin `deleted_at`: el panel borra de verdad), `alias` en `outputs` (también visible en la web local), la tabla `sync_outbox` con sus triggers, y la tabla `sync_state` (revisión y vinculación);
  - servicio nuevo **`acceso-cloud`**, en Python, en el mismo paquete `acceso`, con su unidad systemd. Usa `paho-mqtt` y `httpx`;
  - página "Nube" en la web local;
  - **el daemon y las reglas de autorización no cambian.**
- **Etapa 3:** socket local del daemon, permiso `allow_remote` y origen de log "Remota".
- **Etapa 4:** credenciales temporales (QR) en el esquema y en la autorización.

## 13. Seguridad

- **Cifrado en tránsito:** todo viaja con TLS (HTTPS y MQTT con TLS).
- **Secretos:** las credenciales de dispositivo y las llaves de API se guardan como hash, se pueden revocar y nunca se registran en logs.
- **Aislamiento:** RLS por tenant, con pruebas que intenten leer o escribir datos de otro tenant.
- **Órdenes de apertura:** caducan en 10 s, se usan una sola vez y solo las acepta el panel destino (ACL por tópico).
- **PIN:** cifrado en reposo en la nube. Nunca va en listas, logs, webhooks ni auditoría.

## 14. Escala del primer año

Lo dio el dueño:
- de 1 a 2 instaladores;
- como máximo 20 instalaciones;
- unos 150 titulares por instalación;
- unas 4 aperturas por titular al día;
- todos los sitios tienen internet.

Cálculos y decisiones derivadas [decisión de Claude]:
- **Volumen:** unos 3,000 titulares en total y unas 12,000 aperturas al día, es decir, unos 4.4 millones de logs al año.
- **Logs:** una sola tabla con índices por instalación, panel y fecha, y una tarea mensual que borra lo que tenga más de 12 meses. No hace falta particionar todavía.
- **Sincronización:** con unos 40 paneles como máximo, la de respaldo cada 5 minutos son unas 350 mil llamadas al mes. Está dentro de lo que maneja Next.js en Vercel, y el endpoint responde "sin cambios" sin consultar los datos completos.
- **Costo mensual aproximado, a confirmar con los precios vigentes:** Supabase Pro, Vercel Pro (requerido para uso comercial) y un servidor virtual pequeño para el broker.

## 15. Lo que queda al constructor

- La estructura del repositorio de la plataforma, la librería de componentes, el ORM o cliente SQL y el esquema SQL exacto, siempre que respeten las columnas comunes y la RLS.
- El proveedor MQTT exacto, siempre que tenga autenticación por dispositivo, ACL, API HTTP para publicar y webhooks.
- La forma exacta de los endpoints, el paginado y los nombres de los eventos de webhook.
- Los detalles de la página "Nube" del panel local.
