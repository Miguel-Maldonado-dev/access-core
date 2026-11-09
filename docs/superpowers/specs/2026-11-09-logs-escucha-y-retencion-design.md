# Logs sin controles desconocidos, "Escuchar" control, borrado de logs y tabla compacta

**Fecha:** 2026-11-09. **Estado:** aprobado por el dueño en la conversación, por partes.
Las decisiones que no tomó el dueño se marcan **[decisión de Claude]**.

## Por qué

- Varios paneles pueden estar en la misma instalación y leer el mismo control. Cada panel registra como "Control desconocido" (motivo 5) los controles que no le pertenecen, y eso llena los logs de ruido.
- Ese log era también la forma de ver el código de un control nuevo antes de darlo de alta. Al quitarlo hace falta otra: un botón **"Escuchar"**.
- El dueño quiere limpiar los logs de prueba antes de entregar una instalación. Además, los logs no deben crecer sin límite: se guardan **30 días**.
- En la nube, la tabla de logs tiene el texto muy grande y se ve empalmada.

## Partes

### 1. No registrar controles desconocidos

- **Panel:** cuando `authorize_rf` da el motivo 5 (`REASON_UNKNOWN_CONTROL`), el daemon **no** escribe el log. Así quedan fuera los controles de otro panel y los botones que en ese panel tienen "Ninguna" (un botón con "Ninguna" no tiene vínculo, así que el panel no lo recibe).
- **Nube:** el ingreso de logs del panel (push de logs del agente) **acepta y descarta** los logs con `reason = 5`, para que los paneles con el software anterior avancen su cursor sin llenar la nube **[decisión de Claude]**.
- **No cambia:** los logs con motivo 5 que ya existen se quedan hasta que se borren a mano o cumplan 30 días. Las etiquetas "Control desconocido" se conservan para mostrar esos logs viejos.
- **Sí se siguen registrando:** las tarjetas y los PIN desconocidos (motivos 1 y 8) y el botón sin salida (motivo 6), porque no vienen de otro panel.

### 2. Botón "Escuchar" para dar de alta controles

**Dónde y quién:**
- En la ficha del control, en cada botón, junto al campo del código RF. Está en la web local y en la nube.
- En la nube lo pueden usar el admin y el técnico, igual que "Probar" **[decisión de Claude]**.

**Cómo funciona:**
- **Duración:** el panel escucha **10 segundos** y termina en cuanto recibe el **primer** control (decisión del dueño).
- **Resultado:** el código recibido se escribe en ese campo, en decimal, y hay que guardar como siempre. No se guarda nada solo.
- **Si el código ya pertenece a un control de la instalación**, la interfaz avisa "Este código ya pertenece a <descripción del control>" y no lo escribe en el campo **[decisión de Claude]**.
- **Sin respuesta:** si en 10 s no llega nada, avisa "No se recibió ningún control."
- **Escucha simultánea:** el panel acepta una sola escucha a la vez. Si llega otra, responde "Ya hay una escucha en curso." **[decisión de Claude]**.

**Mientras escucha:**
- **Control desconocido:** no se registra en los logs, como en la parte 1.
- **Control que el panel ya tiene:** se procesa como siempre (abre si tiene permiso y se registra en el log) y además se informa a la escucha. `listen_rf` informa **cualquier** código recibido, conocido o desconocido, junto con el control local al que pertenece si existe **[decisión de Claude]**.

**Panel local:**
- El daemon atiende una operación nueva por su socket Unix, `listen_rf`, que espera hasta 10 s.
- La web la expone como `POST /api/controls/listen` y responde con el código recibido o con "sin respuesta". Si el código ya está registrado en el panel, agrega el control al que pertenece.
- El cliente del socket que use esta operación necesita un tiempo de espera mayor que 10 s **[decisión de Claude]**.

**Nube:**
- **Panel que escucha:** si la instalación tiene varios paneles, primero se elige cuál; si tiene uno solo, no se pregunta. Solo se ofrecen los paneles activos.
- **Orden:** la nube guarda la orden en `panel_commands` con `kind = 'listen_rf'` y la publica por MQTT, igual que `test_output`. El agente le pide la escucha al daemon y devuelve el resultado, con el código, por `POST /api/device/v1/command-result`. La tabla necesita guardar el código recibido.
- **Espera:** la página no espera dentro de una sola petición. Crea la orden y luego consulta su estado cada segundo, hasta 20 s **[decisión de Claude]**.
- **Vigencia:** la orden tiene que **llegar** al panel en 5 s (`expires_at` = creación + 5 s). La escucha de 10 s empieza cuando el panel la recibe. Un panel que la recibe vencida la descarta sin escuchar **[decisión de Claude]**.
- **"Ya pertenece":** la nube revisa el código contra todos los controles de la instalación, no solo contra los del panel que escuchó, porque `rf_code` es único en la instalación.
- **Errores:**
  - si el panel está desconectado, se dice;
  - si un panel con software anterior no contesta, la página dice "El panel no respondió." **[decisión de Claude]**.

**Fuera de alcance:** "Escuchar" no se agrega a la API pública `/api/v1` **[decisión de Claude]**.

### 3. Borrar logs

**Desde la nube.** Retoma la §8 de `docs/superpowers/specs/2026-10-30-controles-por-panel-logs-y-prueba-de-salidas-design.md`, que ya estaba aprobada:
- **Dónde y quién:** botón "Borrar logs" en la página de logs de la instalación, solo para administradores. El servidor se lo niega a los técnicos.
- **Qué borra:** todos los logs de la instalación, de todos sus paneles.
- **Confirmación:** hay que escribir el nombre de la instalación.
- **En la nube:** se borran al momento y se guarda `installations.logs_cleared_at`.
- **En los paneles:**
  - la respuesta del pull trae `logs_cleared_at`;
  - el agente borra sus logs locales con `timestamp` igual o anterior y recuerda esa hora en `sync_state`;
  - un aviso MQTT `sync` adelanta el pull de los paneles en línea, y un panel apagado lo hace en su siguiente sincronización.
- **Logs atrasados:** si un panel sube después logs con `ts` igual o anterior a `logs_cleared_at`, la nube los acepta pero no los guarda.
- **Registro:** cada borrado queda en `log_purges` con la instalación, la hora, quién lo hizo y cuántos logs se borraron en la nube.
- **No toca:** la configuración (titulares, tarjetas, controles, permisos y salidas).
- El plan anterior `docs/superpowers/plans/2026-10-30-borrar-logs.md` se escribió para el esquema v6. El plan nuevo lo reemplaza.

**Desde la web local:** el borrado que ya existe (`DELETE /api/logs`) no cambia. Solo borra ese panel y no avisa a la nube **[decisión de Claude]**.

**Borrado automático de logs con más de 30 días.** El plazo es fijo, no configurable **[decisión de Claude]**.

- **Nube:**
  - un trabajo diario de `pg_cron` borra los `access_logs` con `ts` anterior a 30 días, de madrugada en hora de México **[decisión de Claude]**;
  - el ingreso de logs acepta y descarta los que ya tienen más de 30 días.
- **Panel:**
  - lo hace el **daemon**, no el agente, para que funcione aunque el panel no esté vinculado **[decisión de Claude]**;
  - borra los `access_logs` locales con `timestamp` anterior a 30 días, al arrancar y luego una vez al día. Borra también los que aún no se subieron, porque la nube los descartaría de todos modos;
  - si el reloj de la placa marca un año anterior a 2026 (sin NTP), no borra nada **[decisión de Claude]**.
- **Reloj:** el borrado por `logs_cleared_at` y el de 30 días comparan contra el reloj de la placa, así que dependen de NTP, como "Probar" y la apertura remota.
- **Sigue igual:** el tope existente `LOG_MAX_ENTRIES`.

### 4. Tabla de logs de la nube más compacta (opción A, elegida por el dueño)

- Las mismas 8 columnas: Fecha, Panel, Resultado, Titular, Medio, Código, Salida y Motivo.
- Texto de 12 px, con menos relleno por celda (aproximadamente 6 px vertical y 10 px horizontal).
- Filas alternadas con un tono muy claro, dentro de la paleta existente de `cloud/src/app/globals.css`.
- Ninguna celda corta línea, salvo el titular, que puede ocupar dos líneas y tiene un ancho mínimo. La tabla conserva el desplazamiento horizontal en pantallas angostas.
- Fecha corta `dd/mm/aa hh:mm:ss` **[decisión de Claude]**.
- Es solo la nube; la web local no cambia.

## Restricciones

- **Proceso:** sin commits ni merges, todo queda en `develop` sin confirmar. Interfaz y errores en español.
- **Esquema local:** **sigue en v7**. Los estados nuevos van en `sync_state`, que ya existe.
- **Protocolo UART:** no cambia.
- **Nube:**
  - migraciones nuevas para `listen_rf`, `logs_cleared_at`, `log_purges` y el trabajo de retención;
  - RLS en todas las tablas y funciones privilegiadas en `private`;
  - se aplican solo en local; el dueño las sube con `db push --remote`.
- **Orden de despliegue:** primero la nube y después el paquete del panel. Un panel anterior con la nube nueva sigue funcionando: no escucha, no borra por orden de la nube, y la nube descarta sus logs de motivo 5.
- **PIN:** nunca en logs.
- **EMQX:** no cambia.

## Lo que se deja al constructor

- Nombres internos, forma exacta de los mensajes MQTT y de la respuesta del socket.
- Cómo se guarda el código recibido en `panel_commands`.
- Los lotes del borrado en la nube, si hacen falta.
