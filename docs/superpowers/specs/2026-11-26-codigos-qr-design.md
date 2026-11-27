# Códigos QR dinámicos (accesos temporales)

**Fecha:** 2026-11-26. **Estado:** aprobado por el dueño (2026-11-26).
Las decisiones que no tomó el dueño se marcan **[decisión de Claude]**.

## Por qué
Los residentes necesitan dar accesos temporales a visitas, paquetería, etc. sin entregar tarjeta ni PIN. Se usa un lector **ZK-QR-500**, que lee el QR y lo envía por **Wiegand 34** como si fuera una tarjeta. El QR debe funcionar aunque el panel pierda la conexión.

## Decisiones del dueño
1. **Orígenes:** los QR se crean desde la **API pública** (otra aplicación, p. ej. WEADMI), desde la **web de la nube** y desde la **web local** del panel.
2. **Dígito de validación:** todo QR empieza con un dígito fijo, **configurable** (por omisión 9). Sirve para distinguir QR de tarjeta y, junto con el permiso por lector, impide que alguien convierta su número de tarjeta en QR y lo use en un lector que solo acepta QR.
3. **Métodos por lector en el permiso:** en cada lector se habilita por separado **Tarjeta**, **PIN** y **QR**. Si un lector solo acepta QR y llega un código que no tiene el formato de QR, se rechaza.
4. **Sin conexión:** los QR viajan al panel y se guardan localmente; el panel abre si el QR está dentro de su vigencia y le quedan usos, aunque no haya red.
5. **Usos por lector:** "N usos" significa **N lecturas válidas en cada lector** con QR habilitado. Un QR de 1 uso abre una vez en la entrada, una vez en la salida y una vez en la peatonal, y una segunda lectura en el mismo lector se rechaza. Así funciona igual si entrada y salida están en paneles distintos: cada panel cuenta solo sus lectores, sin depender de la red.
6. **Anfitrión:** cada QR pertenece **siempre a un titular** (el anfitrión) y respeta sus permisos: si el titular no tiene permiso en ese lector (salidas, horario, días y método QR), el QR no abre.

## Formato del código
- Wiegand 34 lleva 32 bits de datos: máximo **4294967295**. El firmware ya lo manda como tarjeta (`0x10`); **el protocolo UART no cambia**.
- El código del QR es un número decimal que empieza con el dígito de validación **D**:
  - D = 1, 2 o 3 → 10 dígitos (`D000000000`–`D999999999`);
  - D = 4 → 10 dígitos, `4000000000`–`4294967295`;
  - D = 5…9 → 9 dígitos (`D00000000`–`D99999999`).
- **[decisión de Claude]** El resto de los dígitos es **aleatorio** (generador criptográfico), no consecutivo, para que no se pueda adivinar el QR de otra persona. Único por instalación entre los QR vigentes.
- **[decisión de Claude]** D se configura **por instalación** en la nube (y en la web local si el panel no está vinculado); viaja al panel con la sincronización. Cambiar D no invalida los QR ya emitidos: el panel acepta como QR todo código que exista en su tabla de QR; D solo decide el rango de los nuevos y la regla de "no parece QR".
- **[decisión de Claude]** Una **tarjeta** cuyo código caiga en el rango de QR de la instalación no se puede dar de alta (nube, API y local): 422 "Ese código está reservado para QR."
- El contenido impreso en el QR es solo el número en decimal, como texto plano (verificado con el ZK-QR-500).

## Decisión en el panel (lectura en el lector L)
1. Si el código está en la tabla local de QR → se trata como **QR**:
   - si L no tiene QR habilitado en el permiso del anfitrión → niega;
   - fuera de vigencia (`valid_from`/`valid_until`) → niega;
   - usos en L ya iguales a `max_uses` → niega ("QR ya usado en este lector");
   - el anfitrión no existe, está deshabilitado o su permiso no cubre ese día y hora o esa salida → niega;
   - si no → abre y suma 1 al contador de (QR, L).
2. Si no está en la tabla de QR pero tiene el formato de QR (empieza con D y tiene la longitud correcta) → niega "QR desconocido".
3. Si no → se trata como **tarjeta**: si L no tiene Tarjeta habilitada → niega (así un QR hecho con un número de tarjeta no abre en un lector solo-QR); si no, sigue la lógica actual de tarjetas.
- **[decisión de Claude]** Motivos de log nuevos: 14 "QR desconocido", 15 "QR fuera de vigencia", 16 "QR ya usado en este lector", 17 "Método no permitido en este lector" (si ya existe un motivo equivalente, se reutiliza). Medio del log: "QR", con el código en decimal y la etiqueta del QR.

## Datos
- **QR:** `id/uuid`, `holder_id` (anfitrión), `code`, `label` (texto libre, p. ej. "Visita Juan"), `valid_from`, `valid_until`, `max_uses` (1–100, por omisión 1) **[decisión de Claude]**, `revoked`/borrado lógico, `created_at`, origen.
- **Usos:** tabla local `qr_uses(qr_id, reader, count)`, **solo en el panel**; no se sincroniza. La nube ve los usos por los logs.
- **Permisos:** nuevo `qr_reader_mask` junto a `card_reader_mask` y `pin_reader_mask` (local y nube, en `profile_panel_rules`). Migración: `qr_reader_mask = 0` (nadie abre por QR hasta habilitarlo) **[decisión de Claude]**.
- Esquema local **v9**; migración nueva en la nube; el agente manda `X-Acc-Schema: 9` y la nube solo envía QR, `qr_reader_mask` y el dígito a paneles v9 (mismo patrón que `phones` en v8).
- **Limpieza [decisión de Claude]:** un QR vencido hace más de 30 días se borra (nube y panel) junto con sus usos; sigue el borrado definitivo con lápidas como las demás tablas replicadas.

## Interfaz
- **Nube y web local:** página "QR" de la instalación: lista (anfitrión, etiqueta, vigencia, usos máximos, estado), alta (elegir anfitrión, etiqueta, desde/hasta, usos), revocar, y ver el QR como imagen con botón de descarga PNG y el número debajo. Ajuste "Dígito de QR" en la configuración de la instalación (solo admin).
- **Permisos:** en la tabla de permisos, los lectores muestran tres casillas por lector: Tarjeta, PIN y QR.
- **API pública:** `POST/GET/DELETE /api/v1/installations/{id}/qr-codes` (y `GET .../qr-codes/{qrId}`), la respuesta trae solo `code` (sin imagen; decisión del dueño): la app de residentes genera la imagen; `Idempotency-Key` como el resto; documentado en OpenAPI y `/docs/api`. Lote de QR: fuera de alcance por ahora.
- **Panel sin vincular / sin red:** un QR creado en la web local se guarda localmente y sube a la nube en la siguiente sincronización. **[decisión de Claude]** Si al subir su código choca con otro QR vigente de la nube (probabilidad mínima), la nube rechaza el del panel y queda como conflicto, como hoy.

## Aclaraciones tras la revisión [decisión de Claude]
- **Tarjetas existentes en el rango de QR:** el orden real de la decisión es tabla de QR → tabla de tarjetas → formato de QR ("QR desconocido") → tarjeta desconocida. Una tarjeta ya registrada en el rango sigue abriendo donde Tarjeta esté habilitada; en un lector solo-QR no abre. El alta nueva en el rango sigue bloqueada y cambiar D se rechaza si el nuevo rango contiene tarjetas vivas ("Hay tarjetas en ese rango").
- **Vigencia:** instantes absolutos (`timestamptz` en la nube, ISO 8601 con zona en la API; UTC en el panel). La interfaz los captura y muestra en hora de México (`America/Mexico_City`).
- **A qué paneles viaja:** a todos los paneles v9 de la instalación (activos, en revisión o importando), como `phones`. No hay vínculo por panel; los permisos del anfitrión deciden.
- **Roles:** admin y técnico crean, ven y revocan QR; solo el admin cambia D. Tope de QR vigentes **configurable por instalación** (decisión del dueño): `installations.qr_max_active`, de 1 a 100000, 1000 por omisión, lo edita solo el admin junto al dígito de QR; al exceder, 422 "Se alcanzó el máximo de QR vigentes de la instalación." La API cuenta en el límite por minuto de su llave.
- **Lecturas repetidas:** la misma lectura del mismo QR en el mismo lector dentro de 3 s se ignora (sin log ni uso), como RF. El uso se suma solo cuando se decide abrir, en la misma transacción que el log; una negación (incluida "sin salida") no consume uso.
- **Anfitrión:** "deshabilitado" significa borrado; no se agrega estado.
- **Lector real (verificado por el dueño, 2026-11-26):** el ZK-QR-500 lee un QR de texto plano con el número decimal y lo envía íntegro por Wiegand 34. No hace falta tarea de verificación.
- **Sin edición (decisión del dueño):** un QR no se edita; para cambiar vigencia, usos o etiqueta se revoca y se crea otro. La API no tiene PUT/PATCH de QR.

## No objetivos
- Envío del QR por WhatsApp/correo (lo hace la aplicación que llama a la API).
- QR sin anfitrión o con permisos propios.
- Contar usos entre paneles o emparejar entrada con salida.
- QR firmados/criptográficos que el panel valide sin tabla: el lector solo entrega 32 bits.

## Riesgos
- El QR se puede fotografiar y compartir: dentro de su vigencia y usos, abre para quien lo presente (como una tarjeta prestada).
- Se depende del reloj del panel (NTP) para la vigencia.

## Orden de despliegue
Primero la nube (migración y Vercel), después el paquete del panel v9. Un panel v8 con la nube nueva ignora los QR.

## Se deja al constructor
Nombres internos, librería para dibujar el QR (preferir una ya usada o pequeña y fijada), forma exacta de la página.
