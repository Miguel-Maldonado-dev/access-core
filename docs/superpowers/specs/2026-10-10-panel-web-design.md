# Panel web de control de acceso — Diseño

**Fecha:** 2026-10-10
**Estado:** borrador para revisión
**Reemplaza a:** `sqlite_access_control/access_control_admin_gui.py` (administrador Tkinter) y `sqlite_access_control/access_control_simulator.py` (simulador Tkinter)

Las decisiones marcadas **[decisión de Claude]** no las tomó el dueño del proyecto; son propuestas razonables que se pueden cambiar. Todo lo demás lo decidió él durante la conversación.

## 1. Intención

Hoy el control de acceso se configura y se ejecuta con dos programas de escritorio en Python con Tkinter que comparten una base SQLite: un administrador y un simulador que habla con el ATmega por UART. Para instalarlo en sitio, el sistema tiene que correr solo en una Raspberry Pi o en una Orange Pi PC, sin pantalla. La configuración se hace desde el navegador de una laptop conectada a la misma red local.

Al mismo tiempo cambia el concepto central: lo que hoy es un "usuario" pasa a ser un **titular**, que puede ser una **persona** o un **domicilio**. Por ejemplo, en un fraccionamiento se da de alta la casa "Amadeo 1260" y a esa casa se le entregan varias tarjetas y controles.

## 2. Objetivos

1. Desde una laptop en la misma red, el administrador entra a una URL como `http://192.168.1.207:8080`, inicia sesión con el usuario y la contraseña definidos en el `.env` de la placa, y administra todo desde ahí.
2. Un proceso de fondo hace el control de acceso en tiempo real, aunque nadie tenga el panel abierto. Recibe los eventos del ATmega por UART, decide con la misma lógica del simulador actual, envía el comando de apertura y registra el log.
3. El titular puede ser persona o domicilio, con varias tarjetas y varios controles RF. Los permisos se asignan al titular.
4. La sección de logs permite averiguar por qué alguien no pudo entrar.
5. Funciona en Raspberry Pi y en Orange Pi PC, usando el UART de los pines GPIO. El puerto se configura en el `.env`.
6. Se sigue usando SQLite, y los datos actuales se conservan.

## 3. No objetivos de la versión 1

- Acceso desde internet, HTTPS o dominios. Solo red local y HTTP.
- Varias cuentas de administrador o roles. Hay un único administrador, el del `.env`.
- Saber qué persona de un domicilio entró. Basta con saber el domicilio; la descripción de cada tarjeta o control sirve como pista ("Tarjeta de Juan").
- Vista de eventos en vivo. El dueño eligió una tabla de logs con filtros.
- **[decisión de Claude]** Apertura manual de salidas desde el panel.
- **[decisión de Claude]** Indicador de estado de la conexión UART en el panel.
- Cambios al firmware o al protocolo UART. El protocolo vigente es la versión 2.1 de `resources/protocolo_uart_panel_control_acceso_v2.md`.
- Aplicación móvil.
- Reloj de tiempo real (RTC) en la placa. La primera versión de la PCB no lo tiene y la hora se toma de internet. Versiones futuras de la PCB sí lo tendrán, y el diseño no debe impedir agregarlo después.

## 4. Anti-objetivos: lo que lo haría fracasar aunque funcione

- Que reiniciar, actualizar o tumbar la parte web deje las puertas sin funcionar. El control de acceso tiene que seguir corriendo pase lo que pase con el panel.
- Perder los registros actuales: titulares, tarjetas, controles, permisos y logs.
- Que en la placa haga falta Node.js u otras herramientas difíciles de instalar en la Orange Pi PC, que tiene un procesador ARM de 32 bits.

## 5. Lo que existe hoy

### Firmware y protocolo

Un ATmega328P con 4 lectores Wiegand, receptor RF de 433 MHz, 2 botones de salida y 4 relevadores. Se comunica a 115200 8N1 con el protocolo v2.1:

| CMD | Dirección | Trama | Uso |
|---|---|---|---|
| `0x10` | ATmega → controlador | `AA 10 RR C1 C2 C3 C4 CS 55` | Tarjeta Wiegand. RR es el lector, de 0 a 3. |
| `0x11` | ATmega → controlador | `AA 11 C1 C2 C3 C4 CS 55` | Código RF. Mientras el botón siga presionado, el mismo código se reenvía cada 3 s. |
| `0x12` | ATmega → controlador | `AA 12 BB CS 55` | Botón de salida 0 o 1. El ATmega ya abrió Relay1 o Relay2; solo se informa para el log. |
| `0x20` | controlador → ATmega | `AA 20 RR T1 T2 CS 55` | Activar el relevador RR, de 0 a 3, durante T milisegundos (uint16, MSB primero). |

El checksum es el XOR desde CMD hasta el último byte del payload.

### Lógica del simulador actual (se conserva)

Está en `access_control_admin_gui.py` (clase `SQLiteStore`) y `access_control_simulator.py` (`FrameParser`, `handle_frame`):

- **Tarjeta (`0x10`):** se busca la tarjeta y su titular. Si no existe, el motivo es *Tarjeta desconocida*. Se toma la primera salida habilitada, la de menor id, cuya máscara de lectores incluye ese lector; si no hay, el motivo es *Sin salida*. Se acepta si algún permiso del titular cubre esa salida, ese lector, el día de la semana y el horario; si no, el motivo es *Sin permiso*. Si se acepta, se envía `0x20` con la duración de la salida.
- **Control RF (`0x11`):** se busca qué botón de qué control tiene ese código. Si no existe, el motivo es *Control desconocido*. Si el botón no tiene salida asignada, el motivo es *Botón sin salida*. Si la salida está deshabilitada, el motivo es *Sin salida*. Los permisos se revisan igual que con la tarjeta, salvo que **el lector no cuenta**. Si se acepta, se envía `0x20`.
- **Botón de salida (`0x12`):** solo se registra en el log como permitido, con motivo *Botón de salida*. El botón 0 corresponde a Relay1 y el 1 a Relay2. No se envía ningún comando.
- **Horario:** si el inicio y el fin son iguales, el permiso vale todo el día. Se admiten horarios que cruzan la medianoche.
- **Fallos de envío:** si el comando no se puede enviar, el motivo es *Error UART*.
- **Tramas inválidas:** una trama con checksum o EOF incorrectos se descarta.

### Base de datos actual

Es `sqlite_access_control/access_control.sqlite`, con el esquema que crea `access_control_admin_gui.py`. Tiene las tablas `users`, `user_permissions`, `permissions`, `outputs` (0 a 3), `cards`, `controls`, `control_buttons` y `access_logs`, con las columnas `source`, `code`, `device_id` y `control_id`.

Al 10/10/2026 contiene 1 usuario, 2 tarjetas, 1 control y unos 210 logs. Ya existe un respaldo del esquema anterior en `access_control_backup_v1.sqlite`.

## 6. Restricciones

- **Placas:** el dueño tiene las dos y puede usarlas para las pruebas.
  - **Raspberry Pi 3B** con Raspberry Pi OS Bookworm: el UART del GPIO es `/dev/serial0`, en los pines 8 y 10.
  - **Orange Pi PC** (Allwinner H3, ARMv7 de 32 bits, 1 GB de RAM) con Armbian: el UART3 es `/dev/ttyS3`, en los pines 8 y 10.
- **Conexión:** el ATmega está en una PCB conectada a esos pines. La PCB resuelve los niveles de voltaje.
- **Internet:** la placa tendrá internet, tanto durante la instalación (para descargar paquetes) como en operación (para sincronizar la hora).
- **Hora:** la PCB v1 no tiene RTC. Los permisos dependen de la hora del sistema, que se sincroniza por NTP. La zona horaria es `America/Mexico_City` **[decisión de Claude]**.
- **Red local y base:** el panel solo se usa dentro de la red local. La base sigue siendo SQLite.
- **Node.js:** puede usarse en la máquina de desarrollo, pero en la placa solo debe correr Python.

## 7. Diseño

### 7.1 Arquitectura

```text
                       ┌───────────────────────── Placa (RPi / Orange Pi) ─────────────────────────┐
ATmega ◄── UART ──────►│ acceso-daemon (Python)        SQLite (WAL)        acceso-web (FastAPI)    │◄── HTTP :8080 ── laptop
                       │  · lee 0x10/0x11/0x12   ───►  titulares, etc. ◄───  · /api (JSON)          │
                       │  · decide y envía 0x20         logs                 · interfaz Next.js     │
                       │  · escribe logs                                       compilada (estática) │
                       └────────────────────────────────────────────────────────────────────────────┘
```

- **Dos procesos independientes**, cada uno como servicio de systemd que arranca con la placa y se reinicia solo si falla:
  - `acceso-daemon`: abre el UART, procesa las tramas, decide, envía `0x20` y escribe los logs. No depende de la web.
  - `acceso-web`: FastAPI con Uvicorn. Sirve la interfaz compilada y la API JSON, y maneja el inicio de sesión.
- **Un paquete de Python compartido** por ambos procesos, con el esquema, las migraciones, el acceso a datos, la lógica de autorización y el protocolo (parser y constructor de tramas). Se parte de `SQLiteStore`, `FrameParser` y `build_relay_command` actuales, adaptados al nuevo modelo.
- **SQLite en modo WAL** con `busy_timeout`, para que los dos procesos lean y escriban a la vez sin bloquearse.
- **Sin caché en el daemon:** consulta la base en cada evento, como el simulador actual. Así un cambio hecho en el panel aplica al siguiente evento, sin reiniciar nada.
- **[decisión de Claude] Reconexión del UART:** si el puerto no se puede abrir o se pierde, el daemon lo reintenta cada pocos segundos sin terminar. Sus mensajes, incluidas las tramas inválidas, van al journal de systemd.

### 7.2 Tecnología

- **Backend:** Python con FastAPI y Uvicorn, y pyserial para el UART. Python 3.9 o superior, porque Raspberry Pi OS y Armbian Bookworm traen la 3.11.
- **Interfaz:** Next.js con TypeScript, compilado como sitio estático (`output: 'export'`) y servido por FastAPI. Se compila en la máquina de desarrollo y los archivos ya compilados se copian a la placa, que no necesita Node.js.
- **Base:** SQLite, con el módulo `sqlite3` de Python o una capa delgada. La elección queda al constructor.

### 7.3 Configuración (`.env`)

Ambos servicios leen el mismo archivo. Debe tener permisos `600` y pertenecer al usuario del servicio.

| Variable | Ejemplo | Notas |
|---|---|---|
| `UART_PORT` | `/dev/serial0` o `/dev/ttyS3` | Obligatoria. |
| `UART_BAUD` | `115200` | Valor por defecto: 115200. |
| `ADMIN_USER` | `admin` | Obligatoria. |
| `ADMIN_PASSWORD` | `…` | Obligatoria. Se guarda en texto plano, como pidió el dueño. |
| `SESSION_SECRET` | cadena aleatoria | **[decisión de Claude]** La genera el instalador. Sirve para firmar la cookie de sesión. |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `8080` | |
| `DB_PATH` | `/var/lib/acceso/access_control.sqlite` | **[decisión de Claude]** La ruta exacta queda al constructor. |
| `LOG_MAX_ENTRIES` | `100000` | **[decisión de Claude]** Hoy son 1000, que es poco para usar los logs como herramienta de diagnóstico. |
| `SESSION_HOURS` | `12` | **[decisión de Claude]** Duración de la sesión. |

Para cambiar la contraseña se edita el `.env` y se reinicia `acceso-web`.

### 7.4 Inicio de sesión

- **Acceso:** sin sesión, cualquier página lleva a la pantalla de inicio de sesión. Toda la API excepto `/api/login` responde 401 sin una sesión válida.
- **[decisión de Claude] Sesión:** se guarda en una cookie firmada, `HttpOnly` y `SameSite=Strict`, que vence a las `SESSION_HOURS` horas. Hay un botón de "Cerrar sesión".
- **[decisión de Claude] Protección de la contraseña:** se compara en tiempo constante, y cada intento fallido tiene un retraso de alrededor de 1 segundo.

### 7.5 Modelo de datos

Los nombres de tablas y columnas quedan al constructor. Estos son los conceptos:

- **Titular:**
  - tipo: `persona` o `domicilio`;
  - nombre, obligatorio (para un domicilio es la dirección, como "Amadeo 1260");
  - departamento o ubicación;
  - dirección;
  - notas.
- **Permisos del titular:** relación de muchos a muchos con los permisos.
- **Permiso:** igual que hoy. Tiene un id de 0 a 31, un nombre, una máscara de salidas (4 bits), una máscara de lectores (4 bits), una máscara de días y el minuto de inicio y de fin.
- **Salida:** de 0 a 3, igual que hoy. Tiene la duración en ms, la máscara de lectores y si está habilitada.
- **Tarjeta:** su código (uint32, único) es la clave. Pertenece a un titular y tiene una descripción. Si se borra el titular, se borran sus tarjetas.
- **Control RF:** tiene id, titular y descripción. Si se borra el titular, se borran sus controles.
- **Botón de control:** botón 0 a 3 de un control. Tiene un código RF (uint32, único entre todos los controles) y una salida opcional (si no tiene, está "sin asignar"). Por defecto, el botón N corresponde a la salida N.
- **Log:** fecha y hora, permitido o no, origen (tarjeta, control RF o botón de salida) y el titular (queda en nulo si se borra). Además, una **copia del nombre del titular y de la descripción del medio** al momento del evento **[decisión de Claude]**, para que el historial siga legible aunque después se borren o renombren. También guarda el código, el dispositivo (el lector, el botón del control o el botón de salida), el control, la salida y el motivo. Se conservan como máximo `LOG_MAX_ENTRIES` registros.

### 7.6 Panel web

Todo en español. Los códigos de tarjetas y controles se muestran **siempre en decimal**.

**[decisión de Claude] Hora de la placa:** el encabezado del panel muestra la fecha y hora actuales de la placa y si está sincronizada por NTP (por ejemplo, con lo que reporta `timedatectl`). Si no está sincronizada, se muestra un aviso visible. Como no hay RTC, una hora equivocada después de un corte de luz sin internet haría que los permisos se aplicaran mal sin que nadie lo notara.

- **Iniciar sesión.**
- **Titulares:** lista con búsqueda por nombre que muestra el tipo y cuántas tarjetas y controles tiene cada uno. Desde ahí se dan de alta, se editan y se borran, y se asignan los permisos. Antes de borrar se pide confirmación, porque también se borran sus tarjetas y controles.
- **Tarjetas:** lista con alta, edición y baja. Cada tarjeta tiene código, titular y descripción.
- **Controles:** cada control tiene titular, descripción y 4 botones. Cada botón tiene código RF y salida, con la opción "Sin asignar". Un código repetido se rechaza con un mensaje claro.
- **Permisos:** nombre, salidas, lectores, días y horario de inicio y fin. Hay una nota que aclara que los controles RF ignoran los lectores.
- **Salidas:** las 4 salidas, cada una con su duración en ms, los lectores que la activan y si está habilitada.
- **Logs:** tabla con filtros por **rango de fechas, titular, resultado y origen**, paginada y ordenada de la más reciente a la más antigua.
  - **Columnas:** fecha, resultado, titular (con su tipo), medio de acceso (descripción de la tarjeta, o control y botón), código, salida y motivo.
  - **Códigos desconocidos:** un código que no está registrado aparece con su número, para copiarlo al dar de alta la tarjeta o el control.
  - **Borrar logs:** hay un botón que pide confirmación.

**Cómo se da de alta un medio de acceso:** se presiona el botón del control o se pasa la tarjeta, el evento aparece en Logs como desconocido con su código, y ese código se copia en Tarjetas o en Controles.

### 7.7 Migración de los datos actuales

- **Cuándo corre:** en el primer arranque, sobre la base actual.
  - Es idempotente.
  - Antes de cambiar nada deja un respaldo junto a la base.
  - Corre una sola vez aunque arranquen los dos servicios a la vez, por ejemplo con un paso `migrate` que ejecute cada servicio antes de iniciar y que esté protegido por una transacción.
- **Cómo se convierten los datos:**
  - Cada `user` pasa a ser un titular de tipo `persona`, con su nombre, departamento y dirección.
  - Tarjetas, controles, botones, salidas, permisos y logs se conservan, con los logs ligados al titular nuevo.
  - En los logs migrados, la copia del nombre del titular y de la descripción del medio se llena con los datos actuales.
- **[decisión de Claude] PIN:** no pasa al panel. Ningún lector lo usa, porque no hay teclado. Los valores actuales se quedan en el respaldo.
- **Comprobación:** se prueba contra una copia de la base real.

### 7.8 Instalación en la placa

- **Preparación del UART:**
  - **Raspberry Pi 3B:**
    - desactivar la consola serie y activar el UART (`raspi-config` → Interface → Serial: login shell *no*, hardware *sí*);
    - **[decisión de Claude]** agregar `dtoverlay=disable-bt` en `/boot/firmware/config.txt` y deshabilitar `hciuart`. En la Pi 3B, `/dev/serial0` usa por defecto el mini-UART, cuya velocidad depende del reloj del procesador. Con este cambio usa el UART completo (PL011), que es estable a 115200. No se necesita Bluetooth.
  - **Orange Pi PC con Armbian:** activar el overlay `uart3` en `/boot/armbianEnv.txt`. El puerto es `/dev/ttyS3`.
  - **En ambas:** el usuario del servicio debe pertenecer al grupo `dialout`.
- **Hora:** el instalador fija la zona horaria `America/Mexico_City` y verifica que la sincronización NTP esté activa (por ejemplo, con `timedatectl set-ntp true`).
- **Script de instalación:** como la placa tiene internet, instala las dependencias desde PyPI con pip. En Raspberry Pi OS se usa piwheels de forma automática. El script:
  - crea el entorno virtual de Python e instala las dependencias;
  - copia el backend y la interfaz compilada;
  - crea el `.env` a partir de una plantilla y genera `SESSION_SECRET`;
  - instala y habilita los dos servicios de systemd, ambos con `Restart=always` y `EnvironmentFile`.
- **Documentación:** un README de instalación paso a paso para cada placa.
- **Dependencias en ARM:** el revisor comprobó que `pydantic-core`, la dependencia de FastAPI que se compila, publica paquetes binarios para ARMv7, así que se instala sin compilar en la Orange Pi PC y en la Pi 3B. Aun así, el primer paso del plan es instalar las dependencias en una de las placas para confirmarlo.
- **Pruebas en las placas:** las hace el dueño, siguiendo los pasos del README, porque las placas no están conectadas a la máquina de desarrollo.

### 7.9 Desarrollo y pruebas

- **En la Mac:**
  - el daemon corre con `UART_PORT=/dev/cu.usbmodem11401`, el Arduino conectado por USB;
  - la API corre en `localhost:8080`;
  - la interfaz corre con el servidor de desarrollo de Next.js, que redirige `/api` hacia FastAPI.
- **Pruebas automáticas:**
  - autorización: los casos que hoy cubre el simulador, más el modelo de titular;
  - parser de tramas;
  - migración contra una copia de la base real;
  - integración del daemon con un puerto serie virtual que simule al ATmega.
- **Prueba manual:** con el Arduino real antes de instalar en la placa.

## 8. Lo que queda al constructor

- Estructura de carpetas. Se propone una carpeta nueva `panel_web/` dentro del proyecto **[decisión de Claude]**.
- Nombres de tablas y columnas, forma exacta de la API y tamaño de página de los logs.
- Librería de componentes y estilos de la interfaz, siempre que sea una interfaz limpia y en español.
- Cómo empaquetar e instalar, siempre que se cumpla la sección 7.8.
- Qué hacer con los programas Tkinter. Se sugiere conservarlos como referencia hasta validar el panel.

## 9. Preguntas abiertas

Ninguna. Las respuestas del dueño sobre la hora, internet y los modelos de placa ya están en las secciones 3, 6 y 7.8.
