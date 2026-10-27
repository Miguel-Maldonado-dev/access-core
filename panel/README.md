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
```

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

Es idempotente. Pide la contraseña dos veces y rechaza los caracteres que systemd no lee bien. Instala `python3-venv` y `sqlite3`, crea el usuario `acceso` (grupo `dialout`), copia el backend a `/opt/acceso/backend`, crea el venv `/opt/acceso/venv`, prepara `/var/lib/acceso`, configura zona horaria `America/Mexico_City` con NTP, instala los servicios systemd y los arranca. Si no existe `/etc/acceso/acceso.env`, lo crea: te pide usuario (por defecto `admin`) y contraseña, elige el `UART_PORT` según la placa, genera `SESSION_SECRET` y lo deja con modo 600 y dueño `acceso`. Al final imprime `Panel listo en http://<ip>:8080`.

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
- [ ] 9. Reiniciar la placa: los dos servicios arrancan solos.
