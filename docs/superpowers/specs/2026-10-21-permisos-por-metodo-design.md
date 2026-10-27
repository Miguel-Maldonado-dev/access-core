# Permisos por método de acceso (Tarjeta, PIN y control RF) — Diseño

**Fecha:** 2026-10-21
**Base:** `2026-10-10-panel-web-design.md` y `2026-10-21-pin-design.md` (esquema v4)

Las decisiones marcadas **[decisión de Claude]** no las tomó el dueño.

## Lo que pidió el dueño

1. **Tarjeta y PIN por lector:** en cada permiso, los lectores se configuran por separado para Tarjeta y para PIN. Por ejemplo, un permiso puede no permitir Tarjeta en el Lector 1 y sí permitir PIN en ese mismo lector.
2. **Control RF:** hoy no hay manera de impedirlo desde los permisos; cualquier permiso que cubra la salida lo deja pasar. Se agrega un permiso **global** para el control RF, que solo activa o desactiva su uso.

## Modelo (esquema v5)

En la tabla `permissions`, `reader_mask` y `allow_pin` se sustituyen por:

| Columna | Tipo | Significado |
|---|---|---|
| `card_reader_mask` | INTEGER NOT NULL CHECK 0..15 | Lectores donde se permite **tarjeta** (bit 0 = Reader1) |
| `pin_reader_mask` | INTEGER NOT NULL CHECK 0..15 | Lectores donde se permite **PIN** |
| `allow_rf` | INTEGER NOT NULL DEFAULT 0 CHECK IN (0,1) | Permite el **control RF** |

`output_mask`, `weekday_mask`, `start_minute` y `end_minute` no cambian y aplican a los tres métodos. `outputs.reader_mask`, que define qué salida abre cada lector, tampoco cambia.

## Reglas de autorización

- **Tarjeta:** cuenta solo un permiso con el bit del lector en `card_reader_mask` que además cubra la salida, el día y el horario. Si ninguno, el motivo es `3` (`"Sin permiso"`).
- **PIN:** cuenta solo un permiso con el bit del lector en `pin_reader_mask` que además cubra la salida, el día y el horario. Si ninguno, el motivo es `9` (`"PIN no permitido"`). Los motivos `8` y `9` siguen alimentando el bloqueo por intentos, y el motivo `10` no cambia.
- **Control RF:** cuenta solo un permiso con `allow_rf = 1` que además cubra la salida del botón, el día y el horario **[decisión de Claude]**. El lector no aplica. Si ninguno, el motivo es `3` (`"Sin permiso"`).
- **Sin cambios:** el botón de salida, la salida elegida por lector y el bloqueo de PIN funcionan igual.

## Migración v4 → v5

- **Seguridad de la operación:** tiene las mismas garantías que las anteriores: bloqueo de archivo, una sola transacción, respaldo `<stem>_backup_v4.sqlite` escrito de forma atómica, con modo 600 y como máximo 3 copias fechadas. Una base v2 o v3 termina en v5.
- **Tabla `permissions`:** se reconstruye con `foreign_keys` desactivado, conservando `holder_permissions`.
- **Valores migrados [decisión de Claude]**, elegidos para que no deje de funcionar nada de lo que hoy funciona:
  - `card_reader_mask = reader_mask`;
  - `pin_reader_mask = reader_mask` si `allow_pin = 1`, y `0` si no;
  - `allow_rf = 1`, porque hoy el control RF ya pasa con cualquier permiso que cubra la salida.
- **Base nueva [decisión de Claude]:** el permiso por defecto "Acceso total" queda con `output_mask = 15`, `card_reader_mask = 15`, `pin_reader_mask = 0`, `allow_rf = 1`, todos los días y todo el día.
- **Prueba de esquema:** el esquema de una base migrada desde v4, v3 o v2 debe ser idéntico al de una v5 nueva.

## API de permisos

- **Campos:** el cuerpo y la respuesta sustituyen `reader_mask` y `allow_pin` por `card_reader_mask` (0..15), `pin_reader_mask` (0..15) y `allow_rf` (`StrictBool`).
- **`PUT`:** si no se envía alguno de esos tres campos, se conserva su valor, por seguridad ante una pestaña vieja del navegador. Los demás campos se comportan como hoy.
- **Mensajes:** siguen en español, y la API sigue respondiendo `{"detail": "<texto>"}`.

## Panel web

- **Formulario de permiso:**
  - En lugar de la casilla "Lectores" y de "Permitir PIN", aparece una cuadrícula con una fila por lector (Reader1 a Reader4) y dos columnas de casillas, **Tarjeta** y **PIN**.
  - Debajo, una casilla **"Permitir control RF"** con la nota: `"El control RF no depende del lector: usa las salidas, días y horario de este permiso."`
- **Tabla de permisos:** en lugar de la columna "Lectores", muestra columnas **Tarjeta**, **PIN** y **RF**. Las dos primeras listan sus lectores o "—"; la de RF muestra "Sí" o "—".
- **Otras pantallas:** Titulares y Logs no cambian.

## README

Agregar notas de actualización:
- la base pasa a v5 y el código anterior ya no la lee; para volver atrás hay que restaurar `<db>_backup_v4.sqlite` con los servicios detenidos;
- después de actualizar, revisar en cada permiso las columnas Tarjeta, PIN y RF.

## Fuera de alcance

El firmware, el protocolo UART y el simulador Tkinter no cambian.
