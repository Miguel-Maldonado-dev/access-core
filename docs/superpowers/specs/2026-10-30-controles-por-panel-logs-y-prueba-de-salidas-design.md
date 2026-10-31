# Controles por panel, actualizar logs y prueba de salidas — Diseño

**Fecha:** 2026-10-30
**Rama:** `develop` (sin commits de Claude; el dueño confirma y fusiona)
**Base:** etapa 1 de la plataforma en la nube (`docs/superpowers/specs/2026-10-26-plataforma-nube-design.md`), ya desplegada: Vercel + Supabase + EMQX, con el panel en esquema v6 y el agente `acceso-cloud`.

Las decisiones que no tomó el dueño van marcadas **[decisión de Claude]**. Lo demás lo pidió o lo aprobó el dueño en la conversación.

## 1. Por qué

1. **Controles con varios paneles.** Hoy cada botón de un control tiene un código RF y una sola salida (S1–S4) **sin panel**, y la nube envía ese botón a todos los paneles de la instalación. Si dos paneles alcanzan la señal del mismo control, los dos abren la misma salida. El dueño tiene instalaciones con dos paneles en el mismo lugar, donde un control debe abrir, por ejemplo, S1 y S2 del Panel 1, y S3 y S4 del Panel 2. Eso debe poder configurarse por panel, igual que las salidas.
2. **Logs al momento.** Hoy los logs suben a la nube en el ciclo periódico del agente, cada 5 minutos. El dueño quiere un botón en la página de logs de la nube para traer los recientes en ese momento.
3. **Probar salidas.** El dueño quiere un botón para activar una salida con sus parámetros, en la web local y en la nube. En la nube funciona como apertura remota.

## 2. Objetivos, no objetivos y antiobjetivos

**Objetivos**
- En la nube, cada botón de un control se vincula **por panel**: para cada panel de la instalación se elige la salida que activa o "ninguna".
- Cada panel recibe solo los botones vinculados a él, cada uno con su salida.
- La página de logs de la nube tiene el botón **"Actualizar logs"**, que pide a los paneles conectados subir sus logs ya.
- Cada salida tiene un botón **"Probar"**, en la web local y en la nube.

**No objetivos**
- Cambiar la administración de controles del panel local. Se queda igual, con un botón y una salida.
- La apertura remota por titular y con permisos (etapa 3). De la etapa 3 solo se adelanta el canal de órdenes nube → panel → daemon, con confirmación.
- Que un botón active dos salidas del mismo panel.
- Cambiar el firmware o el protocolo UART.

**Antiobjetivos** (fallaría aunque funcionara)
- Que un panel abra con un botón que la nube no le asignó.
- Que, después de la migración, deje de funcionar un control que hoy funciona.
- Que una prueba quede sin registro, o que la orden de prueba de la nube se ejecute dos veces o tarde, cuando ya caducó.
- Que la sincronización mueva el vínculo de un panel a otro panel.

## 3. Controles por panel

### 3.1 Modelo en la nube

- **`control_buttons`** conserva `control_id`, `button` (0–3) y `rf_code`, que sigue siendo único entre los registros vivos de la instalación. **Deja de tener `output_index`.**
- **Unicidad del número de botón:** deja de ser única por control en toda la nube (`control_buttons_control_button_live_key`) y pasa a ser única **por panel**. Entre los botones vinculados a un mismo panel, `(control_id, button)` no se repite, porque el panel local lo exige. Dos botones vivos del mismo control pueden compartir número si se vinculan a paneles distintos (ver §3.3) **[decisión de Claude]**.
- **Tabla nueva `control_button_panels`**, replicada como las demás:
  - columnas: `id`, `tenant_id`, `installation_id`, `button_id`, `panel_id` y `output_index`;
  - `output_index` admite 0–3 o nulo. El nulo representa un botón que el panel local tiene sin salida, que hoy da el motivo 6;
  - columnas de sincronización: `updated_at`, `updated_by`, `origin`, `deleted_at` y `revision`;
  - un solo registro vivo por `(button_id, panel_id)`;
  - el panel pertenece a la misma instalación;
  - entra en la auditoría, en RLS, en la revisión, en el registro de cambios y en la revisión de conflictos, con las mismas reglas que las otras tablas replicadas.
- **"Ninguna"** en la interfaz equivale a **no tener vínculo** con ese panel.
- Un botón activa como máximo una salida por panel. Lo aprobó el dueño.

### 3.2 Qué recibe cada panel

- El panel P recibe un botón **solo si tiene vínculo vivo con P**, y la salida que llega en el campo `output` de su registro local es la del vínculo con P.
- P recibe un control **si tiene al menos un botón vinculado a P, o si no tiene ningún botón vivo** **[decisión de Claude]**:
  - el esquema local necesita el control como padre de sus botones;
  - un control vacío, creado en la nube o en un panel, llega a todos los paneles: no abre nada y se ve igual que hoy;
  - un control cuyos botones están vinculados solo a otros paneles no llega a P. Si P pierde su último botón vinculado (porque lo borró o porque se desvinculó en la nube), el control desaparece de P mientras siga vivo para otros paneles. Las sumas de verificación y la adopción usan este mismo filtro, para que la conciliación no lo marque como diferencia.
- Si se borra o se crea un vínculo con P, o cambia la salida del vínculo, P recibe el alta, el cambio o el borrado del botón (y del control, cuando corresponde) en su siguiente pull. Lo mismo pasa con el reclamo y la importación de un panel nuevo, con la adopción de los datos de la nube y con las sumas de verificación de la conciliación: todos se calculan **filtrando por P**.
- El esquema local no cambia: **sigue en v6**. El panel guarda lo mismo que hoy.
- La regla del perfil por panel (`allow_rf`) se sigue aplicando además del vínculo.

### 3.3 Cambios que suben desde el panel local

Lo que el panel P cambia afecta solo a P:
- **Alta de un control o de un botón en P:** se crea el botón en la nube con su vínculo solo a P.
- **Alta en P de un código RF que la nube ya tiene vivo** (por ejemplo, el técnico registra en el Panel 2 un control que ya está configurado para el Panel 1) **[decisión de Claude]**:
  - **Mismo titular:** se **fusiona**. P queda vinculado al botón que ya existe, con la salida que puso en el panel, y P adopta el registro de la nube con su uuid y su control. Si el control que P creó para ese alta queda vacío, se borra.
  - **Otro titular:** se rechaza como duplicado, igual que hoy.
  - **Importación de un panel nuevo** (revisión de lo que solo existe en el panel): aplica la misma regla. Un botón "ya existente" con el mismo titular se vincula a ese panel con su salida local, en lugar de perderse.
- **Cambio de la salida de un botón en P:** cambia solo el vínculo con P.
- **Cambio del código RF de un botón en P:** el panel local lo hace como borrar y crear (`store/controls.py::_set_buttons`), y la nube lo aplica igual, **solo para P** **[decisión de Claude]**:
  - el vínculo de P con el botón viejo se borra y se crea un botón nuevo, con el código nuevo, vinculado solo a P;
  - los otros paneles siguen con el código viejo hasta que se cambie en la nube;
  - en la nube, el control muestra los dos botones, cada uno con sus paneles.
- **Cambio de la descripción o del titular del control:** cambia el registro compartido, y lo ven todos los paneles que lo reciben.
- **Borrado de un botón en P:** borra solo el vínculo con P.
- **Borrado de un control en P:** borra los vínculos con P de todos sus botones.
- **Botón que se queda sin vínculos vivos:** la nube lo borra de forma lógica, así se libera el código RF **[decisión de Claude]**.
- **Control que se queda sin botones por un borrado de botón:** **no** se borra solo. El panel sube un cambio de código como borrar y luego crear; si el control se borrara entre las dos operaciones, el alta del botón nuevo fallaría. Ese control vacío llega a todos los paneles, sin efecto, hasta que alguien lo borre **[decisión de Claude, corregida al planear]**.
  - **Excepción:** sí se borra el control vacío que resulta de una fusión (§3.3, mismo titular), porque el panel lo acaba de crear solo para ese botón.
- **Borrado de un control en P:** la nube lo borra solo si después no le quedan botones vivos vinculados a otros paneles. Si le quedan, sigue vivo para esos paneles y P deja de recibirlo.

### 3.4 Migración de los datos actuales

- Cada botón vivo se vincula **a todos los paneles de la instalación** (reclamados, en revisión o activos) con su `output_index` actual. Así nada deja de funcionar. **[decisión de Claude]**, aprobada por el dueño.
- Un panel que se agregue después a la instalación **no recibe vínculos automáticos** **[decisión de Claude]**: se configuran en la nube. En cambio, los botones que ese panel ya tenía se vinculan a él: los que solo existían en el panel, y los que la nube ya tenía con el mismo titular (§3.3).
- Es una migración nueva de Supabase, que se aplica en local y en Access-Core-DEV. El panel local no se migra.

### 3.5 Interfaz en la nube

- En la ficha del control, cada botón muestra su código RF y **una columna por panel**, con un selector "Ninguna / S1–S4" que usa el alias de la salida cuando lo tiene.
- Se valida que al menos un panel tenga salida **[decisión de Claude]**: un botón sin vínculos no hace nada. Si el usuario elige "Ninguna" en todos los paneles, se le pide confirmar el borrado del botón.
- Con un solo panel, la columna única sigue siendo por panel. Por eso funciona igual que hoy.
- Pueden editar los mismos roles que hoy editan los controles.

## 4. Actualizar logs desde la nube

- **Botón "Actualizar logs"** en la página de logs de la instalación. Disponible para todos los miembros con acceso a la instalación **[decisión de Claude]**.
- **Al presionarlo**, la nube publica `{"type": "upload_logs"}` en `acc/<panel_code>/cmd` de cada panel **en línea** de la instalación (`panels.online`).
- **El agente**, al recibir el aviso, ejecuta la subida de logs pendientes enseguida, fuera del ciclo de 5 minutos. No dispara un push ni un pull. Si ya hay una subida en curso, no inicia otra.
- **La página** muestra "Sincronizando…" y se refresca cuando llegan los logs de todos los paneles avisados, o a los **15 s** como máximo. Para saber cuándo llegaron, la nube registra en cada panel la hora de su última subida de logs (por ejemplo, `panels.logs_uploaded_at`); la página compara esa hora con el momento en que se presionó el botón.
- **Paneles fuera de línea:** la página indica "Panel X sin conexión" y muestra lo último que se recibió de él.
- **Límite:** una petición por instalación cada **10 s** **[decisión de Claude]**. Si llega otra antes, el botón responde que se espere.

## 5. Prueba de salidas

### 5.1 Comportamiento común

- **Activación:** "Probar" activa el relevador de esa salida con su **duración configurada** (`duration_ms`), con la trama `0x20` de siempre.
- **Sin validar titulares ni permisos:** es una acción de administración. Lo aprobó el dueño.
- **Salidas deshabilitadas:** también se pueden probar, para revisar el cableado antes de habilitarlas. Lo aprobó el dueño.
- **Registro:** cada prueba queda en `access_logs` del panel y sube a la nube como cualquier log.
  - **Origen nuevo `5` = "Prueba"** **[decisión de Claude]**. El `4` queda reservado para "Remota" de la etapa 3, como dice el diseño de la nube.
  - Datos del log: `allowed = 1`, motivo `0`, `output_id` de la salida y titular nulo.
  - `credential_label` lleva quién la pidió: `"Prueba — web local"` o `"Prueba — <correo del usuario de la nube>"` **[decisión de Claude]**. Así no cambia el esquema local.
  - Si el envío por UART falla, se registra con el motivo `4` (error de UART) y se informa el error.
  - Las web local y de la nube muestran el origen 5 como "Prueba".
- **Pruebas seguidas:** si la salida ya está en prueba (dentro de su duración), una segunda prueba se rechaza con "La salida ya se está probando" **[decisión de Claude]**.

### 5.2 Canal local: web y agente → daemon

- **Quién manda:** el daemon es el único dueño del puerto serie. La web y el agente le piden la prueba por un **socket Unix local**, `/run/acceso/daemon.sock`, que es el mismo canal previsto en la etapa 3.
- **Socket:**
  - lo crea el daemon al arrancar;
  - pertenece al usuario `acceso` y tiene modo 0600. Los tres servicios corren como `acceso`;
  - el servicio del daemon suma `RuntimeDirectory=acceso`;
  - en la Mac, la ruta se configura en `.env`.
- **Mensajes:** una petición JSON por conexión, por ejemplo `{"op": "test_output", "output": 1, "requested_by": "web local"}`. La respuesta es `{"ok": true}` o `{"ok": false, "detail": "<texto en español>"}`. El formato exacto queda para el constructor.
- **Si el daemon no corre:** la web responde 503 con "El daemon no responde".

### 5.3 Web local

- **Botón "Probar"** en cada salida de la página de salidas, para cualquier usuario con sesión. La web local tiene un solo usuario administrador.
- **Endpoint:** `POST /api/outputs/{id}/test`. Llama al daemon y devuelve el resultado. Los errores van como `{"detail": "..."}` en español.
- **Aviso:** la página informa "Salida activada" o el error.

### 5.4 Nube: apertura remota de prueba

- **Botón "Probar"** en las salidas de cada panel. Pueden usarlo **admin y técnico** (lo aprobó el dueño), es decir, quien ya puede ver la página de salidas. El súper admin de la plataforma no entra a las páginas del tenant, así que no se le da un acceso aparte **[decisión de Claude, al planear]**.
- **Flujo:**
  1. Si el panel está fuera de línea, la nube responde enseguida "Panel sin conexión" y no publica nada.
  2. La nube guarda la orden en una tabla nueva de órdenes, por ejemplo `panel_commands`. Lleva `command_id`, el panel, `kind = 'test_output'`, la salida, quién la pidió, `created_at`, `expires_at` (ahora + 10 s), el estado (`pending`, `ok`, `error` o `expired`), el detalle y la hora del resultado.
  3. Publica en `acc/<panel_code>/cmd` `{"type": "test_output", "command_id", "output", "requested_by", "expires_at"}`.
  4. El agente descarta la orden si ya caducó según su reloj o si ya vio ese `command_id`. Recuerda los últimos `command_id` en memoria, con suficiente historia para cubrir la vigencia.
  5. Si es válida, el agente la pasa al daemon por el socket.
  6. El agente informa el resultado a la nube por la **API de dispositivos**, en `POST /api/device/v1/command-result` con `{command_id, ok, detail}`, autenticado con su credencial de dispositivo. La ruta es plana, como las demás de esa API.
     - Es **[decisión de Claude]**, distinta del diseño de la etapa 3, que confirmaba por `acc/<code>/evt`. Así no hay que cambiar las reglas de EMQX en el servidor y se reutiliza la autenticación del panel.
     - La nube acepta el resultado solo de **ese** panel y solo de una orden `pending`. Un resultado tardío deja la orden como `expired`.
  7. La página espera el resultado hasta **8 s** **[decisión de Claude]**. Después muestra "Salida activada", el error del panel o "El panel no respondió".
- **Requisito:** el panel necesita la hora correcta (NTP), porque compara `expires_at` con su reloj. Se documenta en la instalación.
- **Seguridad:**
  - la orden solo la crea el servidor, después de verificar el rol del usuario en el tenant de esa instalación;
  - RLS: los miembros pueden leer las órdenes de su tenant; nadie las escribe desde el cliente;
  - el ACL de EMQX ya restringe `cmd` a la nube.

## 6. Restricciones

- **Panel local:** Python ≥ 3.9 en el backend. Se mantienen sin cambio el protocolo UART v2.2 y el esquema v6.
- **El PIN nunca aparece** en logs, en el journal ni en los mensajes MQTT.
- **Errores:** la API local devuelve `{"detail": ...}` y la API de dispositivos de la nube conserva su formato actual. Interfaz y errores en español.
- **Nube:**
  - Next.js 16 con Cache Components, usando `connection()` antes de cookies u hora;
  - Supabase con RLS en todas las tablas nuevas y GRANT por columna, como el resto;
  - funciones privilegiadas en `private`.
- **Pruebas:** las migraciones de Supabase llevan pruebas pgTAP, como las existentes. El backend del panel y la nube llevan pruebas para cada parte.
- **Git:** los cambios quedan sin confirmar en `develop`.

## 7. Lo que queda para el constructor

- Los nombres exactos de columnas, rutas, funciones y mensajes, siempre que respeten lo de arriba.
- Cómo se calcula el feed de cambios por panel con la tabla de vínculos. Puede ser un `UNION` de los cambios de `control_buttons` y de `control_button_panels`, o materializar el registro por panel.
- El diseño visual de los selectores por panel y de los avisos, con las skills `frontend-design` y `vercel-react-best-practices`.
- Si la espera del resultado de la prueba se hace con sondeo desde el cliente o en el servidor.

## 8. Borrar logs desde la nube (agregado el 2026-10-30)

**Por qué:** el dueño quiere limpiar los logs de prueba antes de entregar una instalación. Aprobó esta descripción en la conversación.

- **Dónde y quién:** botón **"Borrar logs"** en la página de logs de la instalación, **solo para administradores** del tenant. Los técnicos no lo ven y el servidor se lo niega.
- **Qué borra:** **todos** los logs de la instalación, de todos sus paneles, sin filtros **[decisión de Claude]**.
- **Confirmación:** escribir el nombre de la instalación, porque la acción no se puede deshacer **[decisión de Claude]**.
- **En la nube:** se borran al momento y se guarda en la instalación la **hora del borrado** (`logs_cleared_at`).
- **En los paneles:**
  - la nube avisa por MQTT a los paneles en línea con un aviso `sync` (sin revisión), que adelanta su ciclo;
  - la respuesta del pull incluye `logs_cleared_at`. El agente borra los logs locales con `timestamp` igual o anterior a esa hora y la recuerda en `sync_state`, para no repetir el borrado;
  - un panel apagado lo hace en su siguiente sincronización, sin depender del aviso;
  - la web local del panel queda limpia, porque lee esa misma tabla.
- **Logs atrasados:** los logs que un panel suba después con `ts` igual o anterior a `logs_cleared_at` se aceptan, para que el panel avance su cursor, pero no se guardan **[decisión de Claude]**.
- **Lo que no toca:** los logs posteriores al borrado y la configuración (titulares, tarjetas, controles, permisos y salidas). El bloqueo de PIN vive en memoria y no depende de los logs.
- **Registro:** cada borrado queda en una tabla `log_purges`, con la instalación, la hora, quién lo hizo y cuántos logs se borraron en la nube. Los miembros la pueden leer y solo el servidor escribe **[decisión de Claude]**.
