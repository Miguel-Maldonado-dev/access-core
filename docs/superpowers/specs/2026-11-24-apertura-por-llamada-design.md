# Apertura por llamada (módulo SIM808)

**Fecha:** 2026-11-24. **Estado:** diseño para aprobación del dueño.
Las decisiones que no tomó el dueño se marcan **[decisión de Claude]**.

## Por qué
El dueño quiere que un residente abra llamando a un número del fraccionamiento. Un módulo **SIM808** (comandos AT) recibe la llamada e identifica el número; access-core decide si ese número tiene acceso y abre.

## Decisiones del dueño
- El SIM808 se conecta a la **SBC**, no al ATmega:
  - Orange Pi: un UART libre;
  - Raspberry Pi 3B: un adaptador USB‑UART.
- **Varios números por titular.** En la nube hay una pestaña "Teléfonos", parecida a la de Tarjetas.
- La apertura depende de que el titular tenga **permiso para llamada**.
- **Dos modos**, configurables:
  - **Llamada directa:** no contesta, cuelga y abre una salida fija;
  - **Llamada con menú:** contesta y abre la salida de la tecla 1–4 que se presione.

## Hardware [decisión de Claude]
- **Puerto:** variable `GSM_PORT` en `/etc/acceso/acceso.env`, a 9600 baudios. Si está vacía, la función está apagada.
  - Orange Pi: `/dev/ttyS1` o `/dev/ttyS2`, con su overlay.
  - Raspberry Pi: `/dev/sim808`, un enlace fijo que crea una regla `udev` que instala `install.sh` (con el VID y PID del adaptador como parámetro). Sin esa regla, el nombre `/dev/ttyUSB0` puede cambiar entre arranques.
- **Alimentación:** el SIM808 lleva fuente propia (3.4–4.4 V, picos de 2 A, capacitor de 1000 µF o más). Comparte tierra con la SBC y usa conversión de nivel si su tarjeta no la trae.
- **El protocolo UART del ATmega no cambia.**

## Panel

### Daemon: módulo `gsm`
- **Hilo y reconexión:** un hilo propio es el único dueño de `GSM_PORT`. Si el puerto falla, reintenta igual que el UART del ATmega.
- **Al arrancar envía:**
  - `ATE0`;
  - `AT+CLIP=1` (identificar el número que llama);
  - `AT+DDET=1` (detectar tonos DTMF);
  - `AT+CMEE=2`.
- **Si no responde:** registra el problema en el journal y sigue intentando.
- **Llamada entrante:** al llegar `RING` y `+CLIP: "<número>",…`:
  1. Normaliza el número (ver abajo). Un número oculto o vacío se trata como **desconocido**.
  2. Autoriza: el titular del número, su permiso con método **llamada** y el modo.
  3. **No autorizado:** cuelga con `ATH` y registra el log.
  4. **Modo directo:** cuelga con `ATH` y abre la salida fija.
  5. **Modo con menú:**
     - contesta con `ATA` y espera una tecla `+DTMF: n` durante **8 s**;
     - la tecla `1`–`4` abre esa salida si el permiso la incluye; cualquier otra tecla no hace nada;
     - la primera tecla válida abre y cuelga;
     - sin tecla válida en 8 s, abre la **salida predeterminada** del permiso, si tiene, y cuelga.
- **Relevador:** la apertura usa el mismo `RelayLink` y la misma regla de salida ocupada que "Probar" y la apertura remota.
- **Una llamada a la vez:** una segunda llamada mientras se atiende otra se cuelga.
- **Límite por número:** máximo **3 aperturas por minuto** por número; las demás se cuelgan y se registran **[decisión de Claude]**.

### Normalización del número [decisión de Claude]
- Se guardan y se comparan los **últimos 10 dígitos** (México). Se quitan `+`, espacios y guiones; los prefijos `52` y `521` sobran.
- En la interfaz y la API se capturan 10 dígitos.

### Esquema local v8
- **Tabla nueva `phones`:**
  - `phone_id`, `holder_id` (FK con borrado en cascada), `number` (10 dígitos, **único**) y `description`;
  - se replica como las demás: `uuid`, `updated_at`, `origin`, triggers del outbox.
- **`permissions` agrega:**
  - `allow_call` (0/1, apagado por omisión);
  - `call_mode` (`direct` | `menu`, por omisión `direct`);
  - `call_output`: la salida de la llamada directa, y la predeterminada del menú; en el menú puede ser nula.
- **Salidas del menú:** la tecla `n` solo abre si `output_mask` del permiso incluye la salida `n`. **Llamada directa:** `call_output` también debe estar en `output_mask`.
- **Migración v7 → v8:** con `acceso/migrate.py`, con respaldo, igual que las anteriores.

### Logs
- **Origen nuevo:** 6 = "Llamada".
- **Número:** se registra **enmascarado** (`••••5678`), nunca completo.
- **Motivos:**
  - **0:** se permitió;
  - **3:** sin permiso;
  - **12 (nuevo):** "Teléfono desconocido". Sí se registra, a diferencia de los controles RF: una llamada siempre es para este panel;
  - **13 (nuevo):** "Límite de llamadas".
- **Tecla del menú:** se guarda en el log cuando aplica.

### Web local
- **Pestaña "Teléfonos":** alta, edición y baja, con el titular, el número y la descripción.
- **Editor de permisos:** casilla "Llamada", modo (Directa o Con menú) y salida.
- **Página de sistema:** estado del módulo (puerto, registrado en la red, intensidad de señal con `AT+CSQ`) **[decisión de Claude]**.

## Nube
- **Tabla replicada `phones`:** `installation_id`, `holder_id`, `number`, `description`. El número es único entre los teléfonos vivos de la instalación.
- **Vaciado y lápidas:** entra en las mismas reglas que las demás tablas replicadas: se vacía al borrar, se elimina definitivamente a los 30 días y deja lápida.
- **`profile_panel_rules` agrega:** `allow_call`, `call_mode` y `call_output`. El permiso local los recibe como ya pasa con `allow_remote`.
- **Pestaña "Teléfonos":** igual que Tarjetas (lista, buscador, alta y edición). Se puede llegar a ella también desde la ficha del titular.
- **Editor de reglas por panel:** la casilla "Llamada", el modo y la salida, con el alias de cada salida.
- **API pública:**
  - `/installations/{id}/phones`, con `GET`, `POST`, `PATCH` y `DELETE`;
  - `/phones/batch`, con las mismas reglas que los otros lotes;
  - búsqueda `GET .../phones?numbers=`;
  - los campos nuevos en las reglas de perfil;
  - OpenAPI y `/docs/api` actualizados.
- **Sincronización:** `phones` entra en el feed, en los checksums y en la importación del panel.
- **Logs de la nube:** el origen "Llamada" y los motivos 12 y 13.

## Compatibilidad y despliegue
- **Orden:** primero la nube (migración y Vercel) y después el paquete del panel con el esquema v8, igual que con la apertura remota.
- **Panel v7 con la nube nueva:** ignora `phones` y los campos de llamada.
- **Panel v8 con la nube vieja:** no puede subir sus teléfonos, así que no se revierte la nube con paneles v8.

## Riesgos
- **Identificador de llamada falsificado:** puede falsificarse. Por eso la llamada está **apagada por omisión**, tiene límite por minuto, solo abre las salidas del permiso y todo queda en el log. Hay que documentar que es un método de menor confianza que la tarjeta o el PIN.
- **Costo:** el modo con menú **contesta**, así que al que llama se le puede cobrar. El modo directo no contesta.
- **DTMF:** probar `AT+DDET` con el módulo y el operador reales antes de prometer el modo con menú.

## Fuera de alcance
- Mensajes de voz grabados.
- SMS.
- GPS del SIM808.
- Llamadas salientes.
- Números internacionales distintos de 10 dígitos.

## Pruebas
- **Daemon:** con un simulador del puerto AT para cada caso:
  - CLIP;
  - número oculto;
  - modo directo;
  - menú con tecla válida, tecla no permitida y sin tecla (salida predeterminada o ninguna);
  - dos llamadas a la vez;
  - límite por minuto;
  - el módulo desconectado.
- **Migración v8:** con datos v7.
- **Nube:** pgTAP de `phones` (único, RLS, vaciado) y Vitest de la API y de la pestaña.
- **Hardware:** prueba manual en la placa: CLIP, ATH, ATA y DTMF.

## Precisiones tras la revisión [decisión de Claude]
- **Varios permisos del mismo titular:** se consideran solo los permisos **vigentes** con `allow_call` (días y horario incluidos, como RF y remota).
  - Si alguno es **menú**, la llamada es con menú. Las teclas válidas son la **unión** de las salidas (`output_mask`) de esos permisos. La salida predeterminada es la `call_output` de un permiso **directo** vigente, si hay. Si no hay, es la `call_output` de un permiso de menú. Si hay varias, se usa la de número menor.
  - Si todos son **directos**, se abren sus `call_output` (normalmente una).
- **Número único:** un número solo puede estar en un titular vivo de la instalación (índice único parcial, sin contar borrados ni lápidas).
  - Alta duplicada: **409** "El número ya está registrado".
  - En la web local, el mismo mensaje con `{"detail"}`.
- **Límite por minuto:**
  - cuenta **aperturas**, no intentos;
  - vive en memoria del daemon (se reinicia con él), igual que el bloqueo de PIN.
- **No se puede abrir:**
  - salida ocupada: se cuelga y se registra con motivo 0 y "salida en uso", como la apertura remota;
  - `call_output` deshabilitada o inexistente: motivo 2;
  - menú sin tecla válida y sin salida predeterminada: se registra motivo 3 con "sin tecla";
  - una tecla inválida no se registra por separado: queda en el log final.
- **Varios paneles:** cada panel atiende **solo su propio SIM808**. `phones` se replica a todos los paneles de la instalación, y la nube no necesita saber a qué línea se llamó.

## Aclaraciones del dueño (2026-11-24). Reemplazan lo anterior donde choquen.
1. **Permiso:** solo lleva la casilla **"Permitir llamada"** (`allow_call`), igual que la de controles (`allow_rf`). Se **eliminan** `call_mode` y `call_output` del permiso local y de `profile_panel_rules`.
   - Al llegar una llamada de un número de un titular, se revisan sus permisos **vigentes** con `allow_call` (días y horario incluidos, como RF).
   - La salida que se abre debe estar en el `output_mask` de alguno de esos permisos.
2. **Menú "Llamadas":** configuración **por panel**, nueva, en la web local y en la nube (en la nube, por panel de la instalación).
   - **Activar módulo** (apagado por omisión). Si está apagado, el daemon no abre el puerto aunque exista `GSM_PORT`.
   - **Modo:**
     - **"Una salida":** no contesta, cuelga y abre la **salida configurada** (una de S1–S4);
     - **"Varias salidas":** contesta y espera la tecla 1–4 durante 8 s. Las salidas que se pueden elegir se marcan en esta configuración. **[decisión de Claude]** Opcionalmente tiene una salida predeterminada si no se presiona tecla; sin ella, no abre.
   - **Regla combinada:** la tecla `n` (o la salida configurada) abre solo si la salida `n` está activa en la configuración del módulo **y** en el `output_mask` de algún permiso vigente con `allow_call` del titular.
   - **Estado del módulo:** puerto, registro en la red y señal. Se ve aquí en la web local.
   - **Almacenamiento** **[decisión de Claude]**:
     - en el panel, tabla local `call_settings` (una fila) que se replica;
     - en la nube, `panel_call_settings` (una fila por panel, editable por admin), que viaja al panel en el feed como las salidas.
3. **Logs:** el número se registra **completo, sin enmascarar** (en `code` como texto o en un campo nuevo `phone`, a decidir en el plan). Los motivos 12 y 13 siguen igual.
4. Con esto la sección "Precisiones tras la revisión", en lo de varios permisos y menú contra directo, queda **sin efecto**: el modo ya no depende del permiso. Las demás precisiones siguen vigentes: número único, límite por minuto, salida ocupada y que cada panel atiende solo su propio SIM808.

## Teléfonos solo a paneles con el módulo activado (aprobado por el dueño)
- **Cuándo los recibe:** un panel recibe `phones` en el feed, en los checksums, en el snapshot y en la reconciliación **solo si su módulo de llamadas está activado** (`panel_call_settings.enabled`). Es una proyección por panel, como los botones de control por panel.
- **Al activar el módulo:** en el siguiente pull, adelantado por un aviso MQTT `sync`, el panel recibe todos los teléfonos vivos de la instalación. Después recibe los cambios normales.
- **Al desactivar el módulo:** el panel recibe el borrado de todos sus teléfonos y los quita de su base local. El número no queda guardado en una placa que no lo usa.
- **Nube:** la pestaña Teléfonos funciona siempre.
- **Web local:** la pestaña Teléfonos se muestra solo con el módulo activado.
- **Panel no vinculado:** los teléfonos se capturan en su web local, igual que hoy las tarjetas.
- **Activar el módulo localmente:** si el panel sí está vinculado y se activa el módulo desde su web local, el cambio sube a la nube y luego llegan los teléfonos. Mientras tanto, solo funcionan los números que se capturaron localmente.

## Límite configurable (pedido del dueño, 2026-11-24)
- El límite de aperturas por minuto por número es configurable por panel en el menú "Llamadas": campo **"Aperturas por minuto por número"**, entero **1–20**, **3 por omisión** [rango: decisión de Claude].
- Local: `call_settings.call_limit_per_minute` (CHECK 1–20, default 3). Nube: `panel_call_settings.call_limit_per_minute` (mismo CHECK) que viaja al panel con el resto de la configuración. El daemon usa ese valor (recarga de configuración) en vez de la constante; `CALL_LIMIT_PER_MINUTE` queda como valor por omisión.
