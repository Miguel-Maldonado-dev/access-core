# Panel web del control de acceso

Reemplaza los programas Tkinter por un servicio en la placa (Raspberry Pi 3B u Orange Pi PC) que:

- **daemon** (`acceso-daemon`): lee el UART del ATmega, decide si abre y registra los eventos. Sigue funcionando aunque la web esté apagada.
- **web** (`acceso-web`): panel en español, en `http://<ip>:8080`, para titulares, tarjetas, controles, permisos, salidas y logs.

En la placa solo corre Python; Node.js se usa únicamente en la Mac para compilar la interfaz.

## Desarrollo en la Mac

Backend (desde `panel/backend`):

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

Crea un `.env` en `panel/backend` (usa `deploy/env.example` como base) con valores locales, por ejemplo:

```
UART_PORT=/dev/cu.usbmodem11401
ADMIN_USER=admin
ADMIN_PASSWORD=cambia-esto
SESSION_SECRET=una-cadena-larga-y-aleatoria
DB_PATH=data/access_control.sqlite
CORS_ORIGINS=http://localhost:3000
DAEMON_SOCKET=data/daemon.sock
```

`DAEMON_SOCKET` es el socket Unix del daemon (ver "Probar una salida"). En la Mac `/run/acceso` no existe, así que apúntalo a una ruta que puedas escribir, como `data/daemon.sock`; el daemon y la web deben usar la misma.

Procesos (cada uno en su terminal, desde `panel/backend`):

```bash
.venv/bin/python -m acceso.daemon   # lee el UART (/dev/cu.usbmodem11401)
.venv/bin/python -m acceso.web      # API en http://localhost:8080
```

Interfaz (desde `panel/frontend`), apuntando a la API con `NEXT_PUBLIC_API_BASE`:

```bash
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8080 npm run dev   # http://localhost:3000
npm test
```

`CORS_ORIGINS` debe incluir el origen de la interfaz (`http://localhost:3000`); en la placa se deja vacía.

## Generar el paquete (en la Mac)

Desde `panel/`:

```bash
deploy/build_release.sh
```

Corre `pytest` y `npm test` (si algo falla se detiene), compila la interfaz, la copia a `backend/acceso/web/static` y crea `backend/constraints.txt` con las versiones del entorno de desarrollo y crea `dist/acceso-panel-AAAAMMDD.tar.gz`. La interfaz se compila sin `NEXT_PUBLIC_API_BASE`, aunque lo tengas exportado.

## Instalación en la placa

Copia el paquete y descomprímelo:

```bash
scp dist/acceso-panel-AAAAMMDD.tar.gz usuario@IP_DE_LA_PLACA:~
ssh usuario@IP_DE_LA_PLACA
tar xzf acceso-panel-AAAAMMDD.tar.gz
```

La PCB conecta el ATmega al UART del GPIO. `setup_uart.sh` lo habilita según la placa.

### Raspberry Pi 3B (Raspberry Pi OS Bookworm)

El ATmega queda en `/dev/serial0`.

1. `sudo ./deploy/setup_uart.sh` (desactiva la consola serie, agrega `dtoverlay=disable-bt` y apaga `hciuart`, para que el UART bueno quede en el GPIO).
2. `sudo reboot`
3. `sudo ./deploy/install.sh` (o con `--db`, ver más abajo).

### Orange Pi PC (Armbian)

El ATmega queda en UART3, `/dev/ttyS3`.

1. `sudo ./deploy/setup_uart.sh` (agrega `uart3` a `overlays=` en `/boot/armbianEnv.txt`).
2. `sudo reboot`
3. `sudo ./deploy/install.sh`

### Qué hace `install.sh`

Es idempotente. Pide la contraseña dos veces y rechaza los caracteres que systemd no lee bien. Instala `python3-venv` y `sqlite3`, crea el usuario `acceso` (grupo `dialout`), copia el backend a `/opt/acceso/backend`, crea el venv `/opt/acceso/venv`, prepara `/var/lib/acceso`, configura zona horaria `America/Mexico_City` con NTP, instala los servicios systemd y los arranca. Si no existe `/etc/acceso/acceso.env`, lo crea: te pide usuario (por defecto `admin`) y contraseña, elige el `UART_PORT` según la placa, genera `SESSION_SECRET` y lo deja con modo 600 y dueño `acceso`. Con `--sim808-usb VID:PID` instala además la regla udev del SIM808 (ver "Apertura por llamada"). Al final imprime `Panel listo en http://<ip>:8080`.

### Si `pip` no encuentra un paquete para la placa

`install.sh` instala con las versiones probadas de `backend/constraints.txt` (`pip install -c`). Si alguna no tiene paquete para tu placa, pip lo indicará. Como alternativa, instala sin restricciones (versiones más nuevas, sin probar):

```bash
sudo /opt/acceso/venv/bin/pip install --upgrade /opt/acceso/backend
sudo systemctl restart acceso-daemon acceso-web
```

## Copiar la base actual

La base de la Mac está en `../sqlite_access_control/access_control.sqlite`. Cópiala a la placa y pásala a `install.sh`:

```bash
scp ../sqlite_access_control/access_control.sqlite usuario@IP_DE_LA_PLACA:~
ssh usuario@IP_DE_LA_PLACA
sudo ./deploy/install.sh --db ~/access_control.sqlite
```

- Solo se copia si todavía no hay base en `/var/lib/acceso/access_control.sqlite`; si ya existe, `install.sh` se niega a sobrescribirla y avisa.
- **No migres el archivo de la Mac**: si aún necesitas los programas Tkinter, déjalo como está. La copia de la placa se migra sola al arrancar los servicios y conserva un respaldo de la base original.

## Actualizar

Descomprime el paquete nuevo y vuelve a correr `sudo ./deploy/install.sh`. Conserva `/etc/acceso/acceso.env` y la base; solo asegura que `STATIC_DIR` esté en el `.env` y reinicia los servicios.

Notas de la versión con PIN (esquema v4):

- Al arrancar, los servicios migran la base a v4 y dejan un respaldo `<base>_backup_v3.sqlite` (con copias con fecha, máximo 3). **El código anterior no puede leer una base v4.** Para volver atrás: detén los servicios (`sudo systemctl stop acceso-daemon acceso-web`), borra `<base>-wal` y `<base>-shm` (junto a la base), restaura `<base>_backup_v3.sqlite` sobre la base y reinstala el paquete anterior.
- Un PIN solo abre la puerta en los lectores marcados en la columna **PIN** del permiso del titular (ver las notas de v5 abajo).
- Tras 5 PIN incorrectos en un lector, ese lector rechaza PIN durante 5 minutos (motivo "PIN bloqueado"); las tarjetas y controles siguen funcionando.
- Los PIN se guardan en texto plano; `/var/lib/acceso` queda en modo 700 y los servicios usan `UMask=0077`.
- Recarga el navegador (Ctrl+F5) en las pestañas abiertas antes de la actualización, o un formulario viejo podría no mostrar el PIN.

Notas de la versión con permisos por método (esquema v5):

- La base pasa a v5 y el código anterior ya no la lee. Al arrancar, los servicios dejan un respaldo `<base>_backup_v4.sqlite` (con copias con fecha, máximo 3). Para volver atrás: detén los servicios (`sudo systemctl stop acceso-daemon acceso-web`), borra `<base>-wal` y `<base>-shm` (junto a la base), restaura `<base>_backup_v4.sqlite` sobre la base y reinstala el paquete anterior.
- Cada permiso define por separado los lectores donde vale la **Tarjeta** y donde vale el **PIN**, y una casilla global **"Permitir control RF"**. La migración conserva lo que hoy funciona: Tarjeta = los lectores que tenía el permiso, PIN = esos mismos lectores solo si tenía "Permitir PIN", RF activado.
- Después de actualizar, revisa en cada permiso las columnas Tarjeta, PIN y RF.
- Recarga las pestañas del panel abiertas antes de actualizar (Ctrl+F5): una pestaña vieja envía el formato anterior y el servidor la rechaza con el aviso "El panel está desactualizado".

Notas de la versión con preparación para la nube (esquema v6):

- La base pasa a v6 y el código anterior ya no la lee. Al arrancar, los servicios dejan un respaldo de la **versión de origen** (`<base>_backup_vN.sqlite`, con copias con fecha, máximo 3): `_backup_v5` en una placa que venía de v5, pero `_backup_v4` si venía de v4 (la migración encadenada v4 → v5 → v6 solo respalda la base original), y así con v3 y v2. Para volver atrás:
  1. **Primero** quita `acceso-cloud`, porque al arrancar migra la base a v6 y el paquete anterior no lo conoce: `sudo systemctl disable --now acceso-cloud && sudo rm /etc/systemd/system/acceso-cloud.service && sudo systemctl daemon-reload`. Si lo dejas, vuelve a migrar la base restaurada (por ejemplo al reiniciar la placa) y el daemon anterior no arranca con una base v6.
  2. Detén los servicios: `sudo systemctl stop acceso-daemon acceso-web`.
  3. Borra `<base>-wal` y `<base>-shm` (junto a la base) y restaura el respaldo de tu versión de origen sobre la base.
  4. Reinstala el paquete anterior.

  Se pierden los cambios hechos en el panel (o bajados de la nube) después de la migración.
- Cada titular, tarjeta, control, botón, permiso, asignación de permiso y salida recibe un identificador único (`uuid`), la marca de su último cambio (`updated_at`) y su origen (`origin`). Los cambios que se hacen en el panel se anotan en una bandeja de salida (`sync_outbox`) que usará la sincronización con la nube; la migración no la llena.
- Las salidas tienen un **alias** opcional (hasta 40 caracteres), por ejemplo "Pluma vehicular", que se edita en la página Salidas.
- Una pestaña del panel abierta antes de actualizar sigue funcionando: si no manda alias, la salida conserva el que tiene.

Notas de la versión con apertura remota (esquema v7):

- La base pasa a v7 (`permissions.allow_remote`, apagado por omisión) y el código anterior ya no la lee. Al arrancar, los servicios dejan un respaldo `<base>_backup_v6.sqlite` (con copias con fecha, máximo 3; si la placa venía de una versión anterior, el respaldo es de esa versión de origen). **Para volver a un paquete v6** hay que restaurarlo: quita `acceso-cloud` como en las notas de v6, detén `acceso-daemon` y `acceso-web`, borra `<base>-wal` y `<base>-shm`, restaura `<base>_backup_v6.sqlite` sobre la base y reinstala el paquete anterior. Se pierden los cambios posteriores a la migración.
- Cada permiso tiene la casilla **"Permitir apertura remota"**: un titular solo puede abrir a distancia las salidas de un permiso que la tenga marcada (además de su día y horario). Nace apagada: se activa a propósito, y una tarjeta o un control RF en esa salida no la habilitan.
- Los logs de una apertura remota llevan el origen **Remota** (4) y, en la credencial, el texto de `requested_by` que mandó la nube. Un titular que no existe se registra con el motivo **Titular desconocido** (11); una salida deshabilitada se rechaza (motivo 2) y un titular sin permiso remoto, fuera de horario o de salida, también (motivo 3).
- La orden llega desde la nube por MQTT al agente `acceso-cloud`, que la pasa al daemon por el socket Unix; caduca a los 10 s según el reloj del panel. Actualiza primero la nube y después la placa (ver `cloud/docs/despliegue.md`): un panel v6 con la nube nueva sigue funcionando, pero reemplaza sus permisos en cada reconciliación diaria hasta que pase a v7. Al revés no: un panel v7 con la nube vieja no puede subir cambios ni vincularse hasta que se actualiza la nube (la nube vieja rechaza `allow_remote`), y su reconciliación devuelve `allow_remote` a 0. Para revertir la nube, primero regresa los paneles a v6.

## Probar una salida

La página **Salidas** tiene un botón **Probar** en cada salida: activa ese relevador durante su duración configurada, sin validar titulares ni permisos. Sirve para revisar el cableado, y también funciona con salidas deshabilitadas. Avisa "Salida activada" o el error, y cada prueba queda en los logs con el origen **Prueba** (`credential_label` "Prueba — web local"). Una segunda prueba mientras la salida sigue activa se rechaza con "La salida ya está en uso".

- **Cómo funciona:** el daemon es el único dueño del puerto serie, así que la web (`POST /api/outputs/{id}/test`) y el agente `acceso-cloud` (cuando la prueba se pide desde la plataforma) le piden la prueba por un **socket Unix**, `DAEMON_SOCKET` (`/run/acceso/daemon.sock` por omisión; modo 0600, dueño `acceso`). Lo crea el daemon al arrancar, en el directorio que systemd prepara con `RuntimeDirectory=acceso` en `acceso-daemon.service`.
- **Si el daemon no corre**, la web responde 503 "El daemon no responde".
- **Al actualizar una placa ya instalada** hay que reinstalar el paquete (`sudo ./deploy/install.sh`): el `RuntimeDirectory` viene en el servicio nuevo. Reiniciar los servicios con el paquete anterior no basta.
- **Hora correcta:** las pruebas pedidas desde la nube caducan a los 10 s según el reloj del panel, así que debe estar sincronizado por NTP (`timedatectl`; `install.sh` lo habilita).

## Escuchar un control RF y retención de logs

- **Escuchar:** en el formulario de un control, el botón **Escuchar** de cada botón espera hasta 10 s la siguiente señal RF y rellena su código (si ya pertenece a otro control, lo avisa). La web llama a `POST /api/controls/listen` (responde `{code, control}`, o `{code: null, control: null}` si no llegó nada; 409 si ya hay otra escucha; 503 si el daemon no responde), que pide al daemon la operación `listen_rf` del socket Unix. Desde la nube, la orden `listen_rf` de `acc/<código>/cmd` hace lo mismo y el agente informa el código como `rf_code` en `/api/device/v1/command-result`. Solo hay una escucha a la vez.
- **Motivo 5 ya no se registra:** una señal RF que no pertenece a ningún control (vecino, ruido) se ignora y no entra a los logs; solo la ve la escucha activa.
- **Retención:** el panel borra los logs de más de 30 días (al arrancar y una vez al día). Si un admin usa "Borrar logs" en la nube, el panel borra en su siguiente sincronización los logs hasta esa marca (`sync_state.logs_cleared_at`).

## Apertura por llamada (SIM808)

Un titular abre llamando al número del SIM808 desde uno de sus teléfonos registrados. Esquema v8: `phones`, `call_settings` y la casilla **"Permitir llamada"** (`permissions.allow_call`) del permiso. Todo nace apagado.

- **Hardware:** el SIM808 va conectado a la placa (Raspberry u Orange), no al ATmega; el protocolo UART no cambia. Lleva fuente propia de 3.4–4.4 V capaz de dar picos de 2 A, con un capacitor de 1000 µF o más junto al módulo, tierra común con la placa y conversión de nivel lógico si su tarjeta no la trae.
- **Puerto:** `GSM_PORT` en `/etc/acceso/acceso.env`, a 9600 baudios. Vacía = función apagada. Aunque tenga valor, el daemon no abre el puerto mientras el módulo esté desactivado en **Llamadas**.
  - **Raspberry Pi (adaptador USB):** `sudo ./deploy/install.sh --sim808-usb VID:PID` (el `VID:PID` sale de `lsusb`, por ejemplo `1a86:7523`). Escribe `/etc/udev/rules.d/99-sim808.rules`, que crea el enlace fijo `/dev/sim808` (grupo `dialout`, modo 0660), recarga udev y, si `GSM_PORT` está vacío, lo fija a `/dev/sim808`. Sin la regla, `/dev/ttyUSB0` puede cambiar de nombre entre arranques.
  - **Orange Pi PC (UART del GPIO):** a mano, `GSM_PORT=/dev/ttyS1` o `/dev/ttyS2`, agregando `uart1` o `uart2` a `overlays=` en `/boot/armbianEnv.txt` y reiniciando.
  - Después de cambiar `GSM_PORT`: `sudo systemctl restart acceso-daemon`.
- **Llamadas** (menú de la web): activar el módulo; modo **"Una salida"** (no contesta: cuelga con `ATH` y abre la salida elegida) o **"Varias salidas"** (contesta con `ATA` y espera 8 s la tecla 1–4; las salidas del menú se marcan aquí y hay una salida predeterminada opcional; sin ella y sin tecla válida no abre); **"Aperturas por minuto por número"** (1–20, 3 por omisión); y el estado del módulo (puerto, registro en la red y señal). Al desactivar el módulo se pide confirmación y se borran los teléfonos de la placa (si está vinculada, la nube los vuelve a enviar al reactivarlo).
- **Teléfonos:** la página aparece solo con el módulo activado. Se capturan 10 dígitos (se aceptan espacios y guiones); el número es único. Con el módulo apagado, el alta responde 422 "Activa el módulo de llamadas para agregar teléfonos.".
- **Regla:** la salida abre solo si está activa en la configuración del módulo **y** en un permiso vigente (día y horario) del titular con "Permitir llamada". Una llamada a la vez.
- **Logs:** origen **Llamada** (6), con el número completo en la credencial y la tecla en el lector. Motivos nuevos: **Teléfono desconocido** (12, número no registrado u oculto) y **Límite de llamadas** (13).
- **Riesgos:**
  - el identificador de llamada (CLIP) **se puede falsificar**: es un método de menor confianza que la tarjeta o el PIN. Por eso está apagado por omisión, tiene límite por minuto, solo abre las salidas del permiso y todo queda en el log;
  - el modo **"Varias salidas" contesta**, así que al que llama se le puede cobrar la llamada; "Una salida" no contesta;
  - las teclas (DTMF, `AT+DDET`) dependen del módulo y del operador: pruébalas antes de ofrecer el menú.
- **Actualizar a v8:** al arrancar, los servicios dejan `<base>_backup_v7.sqlite`. **Para volver a un paquete v7** detén `acceso-daemon`, `acceso-web` y `acceso-cloud`, borra `<base>-wal` y `<base>-shm`, restaura `<base>_backup_v7.sqlite` y reinstala el paquete anterior (se pierden los cambios posteriores). Actualiza **primero la nube** (migración `phones_calls` y Vercel) y después la placa: un panel v8 con la nube vieja no puede subir cambios ni vincularse (la nube vieja rechaza `allow_call`, `phones` y `call_settings`), y su reconciliación devuelve `allow_call` a 0. Por eso primero se actualiza la nube y después los paneles. Un panel v7 con la nube nueva ignora teléfonos y llamada.

### Prueba manual en la placa

Con los servicios detenidos (`sudo systemctl stop acceso-daemon`; el daemon es dueño del puerto), abre el puerto con `sudo picocom -b 9600 --omap crcrlf /dev/sim808` (o `/dev/ttyS1`; `sudo apt-get install picocom` si falta) y escribe:

1. `AT` → `OK`; `AT+CREG?` → `+CREG: 0,1` (o `0,5` en roaming); `AT+CSQ` → señal entre 10 y 31.
2. `AT+CLIP=1` y llama desde un celular: deben llegar `RING` y `+CLIP: "<número>",129` (o con `+52`/`521`).
3. `ATH` durante el timbre: la llamada se corta (modo "Una salida").
4. Llama otra vez y contesta con `ATA`; con `AT+DDET=1` antes, cada tecla del celular debe dar `+DTMF: 1` … `+DTMF: 4` (modo "Varias salidas"). Si no llegan, el operador o el firmware del módulo no pasan DTMF: usa "Una salida".
5. Sal de picocom, `sudo systemctl start acceso-daemon`, activa el módulo en **Llamadas**, registra tu número en **Teléfonos** con un permiso con "Permitir llamada" y llama: el relevador abre y el log aparece con el origen "Llamada".

## Códigos QR

Accesos temporales para visitas y paquetería, con un lector **ZK-QR-500** conectado como cualquier lector Wiegand (D0/D1 de uno de los cuatro lectores). El lector lee un QR de texto plano con el número decimal y lo manda íntegro por Wiegand 34, igual que una tarjeta: el firmware y el protocolo UART no cambian. Esquema v9: `qr_codes`, `qr_uses` (solo local), `qr_settings` y `permissions.qr_reader_mask`.

- **Casillas por lector:** en **Permisos**, cada lector (L1–L4) tiene tres casillas: **Tarjeta**, **PIN** y **QR**. Un lector que solo marca QR rechaza tarjetas con el motivo 17 "Método no permitido en este lector" (un PIN sin permiso sigue registrando el motivo 9). Los permisos existentes nacen con QR apagado: hay que marcarlo a propósito.
- **Anfitrión:** cada QR pertenece a un titular y abre solo si el permiso del titular cubre el lector, la salida, el día y el horario.
- **Dígito de QR:** todo código empieza con un dígito D (1–9, 9 por omisión; se cambia en la página **QR**). Con D = 1, 2 o 3 tiene 10 dígitos; con D = 4, de `4000000000` a `4294967295`; con D = 5 a 9, 9 dígitos. Lo demás es aleatorio. Una tarjeta nueva no puede usar un código de ese rango.
- **Usos por lector:** `max_uses` (1–100) cuenta las lecturas válidas **en cada lector**: un QR de 1 uso abre una vez en la entrada y una vez en la salida. Los contadores están en `qr_uses` y no se sincronizan. La misma lectura en 3 s se ignora.
- **Página QR:** alta (anfitrión, etiqueta, vigencia en hora de México, usos), lista, revocar y ver/descargar la imagen. Un QR no se edita: se revoca y se crea otro. Los vencidos hace más de 30 días se borran. Si el panel está vinculado, los QR de la nube bajan con la sincronización y los creados aquí suben.
- **Logs:** origen **QR** (7), con el código en decimal. Motivos: **QR desconocido** (14), **QR fuera de vigencia** (15), **QR ya usado en este lector** (16) y **Método no permitido en este lector** (17; también lo registra una tarjeta en un lector sin la casilla Tarjeta; un PIN sin permiso sigue en 9).
- **Hora correcta:** la vigencia se compara con el reloj del panel, así que debe estar sincronizado por NTP (`timedatectl`; `install.sh` lo habilita).
- **Riesgo:** el QR se puede fotografiar y reenviar; dentro de su vigencia y usos abre para quien lo presente, como una tarjeta prestada. Usa vigencias cortas y pocos usos.
- **Actualizar a v9:** al arrancar, los servicios dejan `<base>_backup_v8.sqlite`. **Para volver a un paquete v8** detén `acceso-daemon`, `acceso-web` y `acceso-cloud`, borra `<base>-wal` y `<base>-shm`, restaura `<base>_backup_v8.sqlite` y reinstala el paquete anterior (se pierden los cambios posteriores). Actualiza **primero la nube** (migración `qr_codes` y Vercel) y después la placa. Un panel v8 con la nube nueva ignora los QR; no se revierte la nube con paneles v9.

### Prueba manual en la placa

1. Conecta el ZK-QR-500 a un lector Wiegand libre y alimenta el lector según su hoja de datos.
2. Confirma el reloj con `timedatectl`. En **Permisos**, marca **QR** en ese lector para un titular con permiso en una salida.
3. En **QR**, crea un QR de 1 uso para ese titular, muéstralo al lector: el relevador abre y el log sale con el origen "QR".
4. Muéstralo otra vez en el mismo lector: se rechaza con "QR ya usado en este lector" (16). Con un QR vencido: "QR fuera de vigencia" (15). Con un QR inventado del mismo formato: "QR desconocido" (14).
5. Quita **Tarjeta** de ese lector y pasa una tarjeta: se rechaza con el motivo 17.

## Servicio `acceso-cloud` (plataforma en la nube)

`acceso-cloud` es un servicio systemd aparte, que `install.sh` instala y arranca junto con `acceso-daemon` y `acceso-web`. Sincroniza la base del panel con la plataforma en la nube (`cloud/` del repositorio): se registra, se vincula a una instalación, sube los cambios que haces en el panel, baja los que se hacen en la nube y sube los logs de acceso. Escucha avisos por MQTT para sincronizar al instante y, si el broker no responde, sigue sincronizando por HTTPS cada 5 minutos. **El panel nunca depende de la nube para abrir**: el daemon y la autorización local no cambian, y con `acceso-cloud` detenido o sin internet todo funciona igual.

Configuración en `/etc/acceso/cloud.env` (modo 600, dueño `acceso`; el agente guarda ahí su credencial `CLOUD_PANEL_CODE` y `CLOUD_DEVICE_TOKEN`, que no se deben tocar a mano):

```bash
CLOUD_URL=https://app.ejemplo.com           # la aplicación (HTTPS)
MQTT_URL=mqtts://mqtt.ejemplo.com:8883      # el broker EMQX (siempre con TLS)
```

- En la primera instalación se pueden dar por entorno: `sudo CLOUD_URL=https://app.ejemplo.com MQTT_URL=mqtts://mqtt.ejemplo.com:8883 ./deploy/install.sh`. `install.sh` los guarda solo si `/etc/acceso/cloud.env` no existe; después se editan a mano (`sudo nano /etc/acceso/cloud.env`) y se reinicia: `sudo systemctl restart acceso-cloud`.
- Además de sincronizar, el agente atiende dos órdenes de la nube por MQTT (`acc/<código>/cmd`): `upload_logs` (el botón "Actualizar logs": sube los logs pendientes al momento) y `test_output` (la prueba de una salida, que pasa al daemon por el socket y cuyo resultado informa por HTTPS a `/api/device/v1/command-result`).
- Sin `CLOUD_URL` el agente queda inactivo y la página **Nube** lo indica en "Último error". Sin `MQTT_URL` sincroniza solo por el intervalo.
- Para pruebas existe la variable opcional `SYNC_INTERVAL_S` (segundos entre sincronizaciones periódicas; 300 por omisión). No hace falta en producción.

Cómo vincular un panel:

1. Abre la página **Nube** del panel (`http://<ip>:8080`, menú de la izquierda). Muestra el **identificador del panel** (`PNL-XXXX-XXXX`) y el **código de vinculación** (8 caracteres).
2. En la plataforma, un administrador del tenant entra a la instalación → Paneles → **Vincular panel** y captura los dos datos.
3. El panel pasa a "Importando datos a la plataforma" y sube su base. Si la instalación no tenía datos, queda **Vinculado** de inmediato; si ya tenía, queda "En revisión" hasta que un administrador elija qué importar. **Mientras está en revisión, los cambios que hagas en el panel se perderán al adoptar los datos de la nube.**
4. Ya vinculado, la página muestra la instalación, la última sincronización, los cambios pendientes y el último error.

Si desvinculan el panel desde la plataforma, el agente borra su credencial, genera un código de vinculación nuevo y vuelve a "Sin vincular" sin tocar los datos locales. Diagnóstico: `journalctl -u acceso-cloud -f` (nunca registra contraseñas, tokens ni PIN).

## Cambiar la contraseña

```bash
sudo nano /etc/acceso/acceso.env      # cambia ADMIN_PASSWORD
sudo systemctl restart acceso-web
```

Importante: systemd interpreta el `.env` con reglas propias. En `ADMIN_USER` y `ADMIN_PASSWORD` **no uses** los caracteres `\`, `"`, `'`, `$` ni el acento grave (`` ` ``), ni espacios al inicio o al final, ni comillas alrededor del valor. `install.sh` ya los rechaza al preguntar; al editar a mano debes evitarlos tú, o el servicio no arrancará o no podrás entrar.

## Respaldar

```bash
sudo -u acceso sqlite3 /var/lib/acceso/access_control.sqlite ".backup '/var/lib/acceso/respaldo.sqlite'"
```

`.backup` es seguro con los servicios en marcha. Luego copia el archivo con `scp`.

## Diagnóstico

```bash
journalctl -u acceso-daemon -f     # eventos del UART y reconexiones
journalctl -u acceso-web -f
systemctl status acceso-daemon acceso-web
timedatectl                        # zona America/Mexico_City y reloj sincronizado
```

## Lista de verificación en cada placa

- [ ] 1. Ejecutar `setup_uart.sh` y reiniciar.
- [ ] 2. Ejecutar `install.sh --db access_control.sqlite`.
- [ ] 3. Abrir `http://<ip>:8080`: debe pedir usuario y contraseña, y el reloj debe salir sincronizado.
- [ ] 4. Pasar una tarjeta: el relevador abre y el log aparece.
- [ ] 5. Presionar un botón del control: el relevador abre y el log aparece.
- [ ] 6. Presionar el botón de salida: el log aparece sin ningún comando.
- [ ] 7. Ejecutar `systemctl stop acceso-web`: las tarjetas siguen abriendo.
- [ ] 8. Desconectar y reconectar la PCB: el daemon se recupera solo.
- [ ] 9. Reiniciar la placa: los tres servicios (`acceso-daemon`, `acceso-web` y `acceso-cloud`) arrancan solos.
- [ ] 10. Salidas → **Probar**: el relevador abre y el log aparece con el origen "Prueba".
- [ ] 11. Si hay SIM808: la prueba manual de "Apertura por llamada" (CLIP, `ATH`, `ATA`, DTMF) y una llamada real que abre con el origen "Llamada".
- [ ] 12. Si hay ZK-QR-500: la prueba manual de "Códigos QR" (abre con el origen "QR", segunda lectura rechazada) con el reloj sincronizado.
