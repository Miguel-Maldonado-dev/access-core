# PIN por titular — Diseño

**Fecha:** 2026-10-21
**Estado:** en implementación (el dueño pidió avanzar sin más preguntas)
**Base:** `docs/superpowers/specs/2026-10-10-panel-web-design.md` y el protocolo `resources/protocolo_uart_panel_control_acceso_v2.md` (v2.1)

Las decisiones marcadas **[decisión de Claude]** no las tomó el dueño; las propuso Claude y el dueño pidió avanzar.

## Lo que pidió el dueño

1. **PIN por titular:** de hasta 6 dígitos y único entre titulares. Al dar de alta se puede escribir uno personalizado o generar uno aleatorio. Su uso se activa o desactiva desde los permisos.
2. **Firmware:** el lector y teclado Hikvision DS-K1802EK envía cada tecla como una ráfaga Wiegand de 4 bits:
   - `0000` a `1001` son los dígitos 0 a 9;
   - `1010` es `*`;
   - `1011` es `#`.

   El ATmega acumula los dígitos. Con `#` envía el PIN completo por UART (por ejemplo, `1,2,3,4,5,6,#` envía `123456`). Con `*` borra lo escrito para volver a capturar. Esto se agrega al protocolo.

## Comportamiento

- **El PIN por sí solo abre [decisión de Claude]:** funciona como una tarjeta más. La combinación tarjeta + PIN queda fuera de esta versión.
- **Puerta:** abre la salida del lector donde se escribió el PIN, con la misma regla que las tarjetas: la primera salida habilitada, de menor id, cuya máscara de lectores incluya ese lector.
- **Permisos:** cada permiso tiene una casilla **"Permitir PIN"** (`allow_pin`).
  - Un PIN se acepta solo si algún permiso del titular tiene `allow_pin = 1` **y** cubre esa salida, ese lector, el día y el horario, igual que una tarjeta.
  - Los permisos sin `allow_pin` no cuentan para el PIN.
  - Por defecto `allow_pin = 0`, también en los permisos existentes después de migrar. El dueño lo activa desde el panel **[decisión de Claude]**.
- **Formato del PIN [decisión de Claude]:** de **4 a 6 dígitos**, solo `0-9`. Se guarda como texto para conservar los ceros a la izquierda; `0123` y `123` son distintos.
- **Unicidad:** un PIN no puede repetirse entre titulares. Un duplicado responde 409 `"El PIN ya está asignado a otro titular."`.
- **Generar:** produce 6 dígitos aleatorios con `secrets`, que ningún titular tenga.
- **Visible para el administrador [decisión de Claude]:** se guarda en texto plano, para poder consultarlo y dárselo al residente. El panel solo se usa en la red local, y la base pertenece al usuario `acceso`.
- **Logs:**
  - origen nuevo `3` = `"PIN"`;
  - motivos nuevos `8` = `"PIN desconocido"` y `9` = `"PIN no permitido"`, cuando el titular existe pero ningún permiso con `allow_pin` cubre esa salida, día y horario;
  - si no hay salida habilitada para el lector, el motivo sigue siendo `2` (`"Sin salida"`);
  - **el log nunca guarda los dígitos del PIN [decisión de Claude]**, ni de los aceptados ni de los rechazados: `code = NULL`, `device_id = lector` y `credential_label = "PIN"`;
  - con un PIN aceptado se guarda la copia del titular, como con las tarjetas.
- **El simulador Tkinter no cambia [decisión de Claude].**
- **Límite de intentos [decisión de Claude, por la revisión]:** después de **5 PIN fallidos** (motivos 8 o 9) en un lector dentro de **5 minutos**, ese lector rechaza PIN durante **5 minutos**. El rechazo se registra con el motivo `10` = `"PIN bloqueado"` y no envía comando. Un PIN correcto reinicia el contador; tarjetas, RF y botones no se ven afectados.
- **Archivos [decisión de Claude, por la revisión]:** la base y sus respaldos solo los puede leer el usuario `acceso` (`UMask=0077` en los servicios y `/var/lib/acceso` en modo 700); como máximo se conservan 3 respaldos fechados por versión.

## Protocolo UART v2.2: CMD `0x13` — Lectura de PIN

Dirección: ATmega → controlador. Trama de longitud fija de 12 bytes:

```text
AA 13 RR LL D1 D2 D3 D4 D5 D6 CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x13` |
| 2 | ReaderID | `0..3` |
| 3 | Length | cantidad de dígitos, `1..6` |
| 4–9 | D1..D6 | valor de cada dígito (`0x00`–`0x09`), en el orden escrito; los bytes después de `Length` van en `0x00` |
| 10 | Checksum | XOR de los bytes 1 a 9 (de CMD a D6) |
| 11 | EOF | `0x55` |

- **Ejemplo:** el PIN `123456` en el lector 0 es `AA 13 00 06 01 02 03 04 05 06 CS 55`, con `CS = 0x13^0x00^0x06^0x01^0x02^0x03^0x04^0x05^0x06 = 0x12`.
- **Validación en el controlador:** una trama con `Length` fuera de `1..6`, un dígito mayor que 9, un lector mayor que 3 o un byte de relleno distinto de 0 es inválida y se descarta, como las demás tramas inválidas.
- **Reservas:** las extensiones futuras que el documento tenía en `0x13–0x15` se recorren a `0x14–0x16`.

## Firmware

- **Teclas contra tarjetas:** en cada lector, una ráfaga de **4, 8, 12 o 16 bits** contiene una tecla por cada 4 bits, la más antigua en los bits más significativos. Así se cubren las teclas presionadas con menos de 100 ms entre ellas, que la librería Wiegand junta en una sola ráfaga; lo encontró la revisión. Cualquier otra cantidad de bits es una tarjeta, como hasta ahora. Una tarjeta también vacía el buffer de ese lector.
- **Buffer por lector:** cada uno de los 4 lectores tiene el suyo, de hasta 6 dígitos.
  - **Dígito:** se agrega. Si ya hay 6, el buffer queda marcado como **desbordado**, y al presionar `#` se descarta sin enviar nada [decisión de Claude], para que `1234567#` no abra con `123456`.
  - **`*`:** borra el buffer y quita la marca de desbordado.
  - **`#`:** si el buffer tiene de 1 a 6 dígitos y no está desbordado, envía `0x13`. En cualquier caso, lo vacía.
  - **Teclas `1100` a `1111`:** se ignoran.
  - **Inactividad:** si pasan **10 s sin presionar dígitos** con dígitos pendientes, el buffer se vacía [decisión de Claude]. Las teclas ignoradas no reinician ese tiempo.

## Base de datos (esquema v4)

- **`holders`:** columna `pin TEXT` (nula = sin PIN), con `CHECK(pin IS NULL OR (length(pin) BETWEEN 4 AND 6 AND pin NOT GLOB '*[^0-9]*'))` y el índice único `holders_pin` sobre `holders(pin)`.
- **`permissions`:** columna `allow_pin INTEGER NOT NULL DEFAULT 0 CHECK(allow_pin IN (0,1))`.
- **`SCHEMA_VERSION = 4`.** Una base nueva se crea directamente en v4. Una v3 se migra a v4 con `ALTER TABLE … ADD COLUMN` más el índice, en la misma transacción y bajo el mismo bloqueo de archivo. Una v2 se convierte directamente al esquema v4, con respaldo `_backup_v2`. El resultado es idéntico; se verificó.
- **Respaldo:** la migración de v3 a v4 también deja uno antes de cambiar nada, como la de v2 a v3 (`<stem>_backup_v3.sqlite`, con escritura atómica y rotación si ya existe).

## Panel web

- **API de titulares:**
  - `HolderIn` y `HolderOut` agregan `pin: Optional[str]` (4–6 dígitos; vacío o `null` = sin PIN);
  - `POST /api/holders/generate-pin` → `{"pin": "######"}` (6 dígitos, no usado por nadie; no lo guarda);
  - la lista devuelve `has_pin` en lugar del PIN, que solo viene en `GET /api/holders/{id}` y en las respuestas de alta y edición. Así se expone menos [decisión de Claude, por la revisión];
  - en `PUT`, si no se envía `pin`, se conserva el que había; `null` o vacío lo borra. Lo mismo vale para `allow_pin` en permisos.
- **API de permisos:** agrega `allow_pin: bool`.
- **Formulario del titular:**
  - campo "PIN" que acepta solo dígitos, con validación de 4 a 6 en español: `"El PIN debe tener de 4 a 6 dígitos."`;
  - botón **"Generar"**, que llama al endpoint y llena el campo;
  - botón para mostrar u ocultar el PIN.
- **Tabla de titulares:** columna "PIN" con "Sí" o "—", sin mostrar los dígitos.
- **Formulario de permisos:** casilla "Permitir PIN". La tabla de permisos la muestra.
- **Logs:**
  - `sourceLabel(3) = "PIN"`;
  - `reasonLabel(8) = "PIN desconocido"` y `reasonLabel(9) = "PIN no permitido"`;
  - `mediumLabel` del origen 3 es `"PIN · ReaderN"`;
  - el filtro de origen agrega la opción "PIN".
