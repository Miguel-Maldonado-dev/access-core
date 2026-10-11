#!/usr/bin/env bash
# Instala o actualiza el panel en la placa. Ejecutar como root desde el paquete
# descomprimido:  sudo ./deploy/install.sh [--db RUTA_A_LA_BASE]
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script como root (sudo)." >&2
  exit 1
fi

DB_SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db)
      [ $# -ge 2 ] || { echo "Falta la ruta después de --db" >&2; exit 1; }
      DB_SRC="$2"; shift 2 ;;
    *)
      echo "Uso: install.sh [--db RUTA]" >&2; exit 1 ;;
  esac
done

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/acceso/acceso.env
DB_DEFAULT=/var/lib/acceso/access_control.sqlite
STATIC_LINE="STATIC_DIR=/opt/acceso/backend/acceso/web/static"

if [ -n "$DB_SRC" ]; then
  [ -f "$DB_SRC" ] || { echo "No existe la base: $DB_SRC" >&2; exit 1; }
  DB_SRC="$(cd "$(dirname "$DB_SRC")" && pwd)/$(basename "$DB_SRC")"
fi

echo "==> Paquetes del sistema"
apt-get update
apt-get install -y python3-venv sqlite3

echo "==> Usuario acceso"
if ! id acceso >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/acceso --shell /usr/sbin/nologin acceso
fi
usermod -aG dialout acceso

echo "==> Backend en /opt/acceso"
mkdir -p /opt/acceso
rm -rf /opt/acceso/backend
cp -R "$PKG/backend" /opt/acceso/backend
rm -rf /opt/acceso/backend/build /opt/acceso/backend/*.egg-info
[ -d /opt/acceso/venv ] || python3 -m venv /opt/acceso/venv
/opt/acceso/venv/bin/pip install --upgrade pip
/opt/acceso/venv/bin/pip install --upgrade --force-reinstall /opt/acceso/backend

echo "==> Datos en /var/lib/acceso"
mkdir -p /var/lib/acceso
chown acceso:acceso /var/lib/acceso

echo "==> Configuración"
mkdir -p /etc/acceso
if [ ! -f "$ENV_FILE" ]; then
  read -r -p "Usuario administrador [admin]: " ADMIN_USER
  ADMIN_USER="${ADMIN_USER:-admin}"
  ADMIN_PASSWORD=""
  while [ -z "$ADMIN_PASSWORD" ]; do
    read -r -s -p "Contraseña del administrador: " ADMIN_PASSWORD
    echo
  done
  MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
  if [[ "$MODEL" == *"Raspberry Pi"* ]]; then
    UART_PORT=/dev/serial0
  elif [[ "$MODEL" == *"Orange Pi PC"* || "$MODEL" == *"Xunlong"* ]]; then
    UART_PORT=/dev/ttyS3
  else
    UART_PORT=/dev/serial0
    echo "Placa no reconocida ('$MODEL'); usando $UART_PORT. Edita $ENV_FILE si es otro." >&2
  fi
  SESSION_SECRET="$(/opt/acceso/venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')"
  umask 077
  export ADMIN_USER ADMIN_PASSWORD UART_PORT SESSION_SECRET
  # Los valores se pasan por entorno para no interpretar caracteres especiales.
  /opt/acceso/venv/bin/python - "$PKG/deploy/env.example" "$ENV_FILE" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
values = {k: os.environ[k] for k in ("ADMIN_USER", "ADMIN_PASSWORD", "UART_PORT", "SESSION_SECRET")}
out = []
for line in open(src, encoding="utf-8").read().splitlines():
    key = line.split("=", 1)[0]
    if "=" in line and not line.startswith("#") and key in values:
        line = "%s=%s" % (key, values[key])
    out.append(line)
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
  unset ADMIN_PASSWORD SESSION_SECRET
fi
if ! grep -q '^STATIC_DIR=' "$ENV_FILE"; then
  printf '%s\n' "$STATIC_LINE" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
chown acceso:acceso "$ENV_FILE"

DB_PATH="$(sed -n 's/^DB_PATH=//p' "$ENV_FILE" | tail -n1)"
DB_PATH="${DB_PATH:-$DB_DEFAULT}"

if [ -n "$DB_SRC" ]; then
  if [ -e "$DB_PATH" ]; then
    echo "Ya existe una base en $DB_PATH; no se sobrescribe. Se ignora --db." >&2
  else
    install -o acceso -g acceso -m 640 "$DB_SRC" "$DB_PATH"
    echo "Base copiada a $DB_PATH (se migra sola al arrancar los servicios)."
  fi
fi

echo "==> Zona horaria y reloj"
timedatectl set-timezone America/Mexico_City && timedatectl set-ntp true

echo "==> Servicios"
install -m 644 "$PKG/deploy/acceso-daemon.service" /etc/systemd/system/acceso-daemon.service
install -m 644 "$PKG/deploy/acceso-web.service" /etc/systemd/system/acceso-web.service
systemctl daemon-reload && systemctl enable --now acceso-daemon acceso-web
systemctl restart acceso-daemon acceso-web

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(sed -n 's/^WEB_PORT=//p' "$ENV_FILE" | tail -n1)"
echo "Panel listo en http://${IP:-<ip>}:${PORT:-8080}"
