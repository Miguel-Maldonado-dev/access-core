#!/usr/bin/env bash
# Habilita el UART del GPIO para el ATmega. Ejecutar como root; es idempotente.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script como root (sudo)." >&2
  exit 1
fi

MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"

if [[ "$MODEL" == *"Raspberry Pi"* ]]; then
  echo "Placa: $MODEL"
  raspi-config nonint do_serial_cons 1   # sin consola de login en el UART
  raspi-config nonint do_serial_hw 0     # UART por hardware habilitado
  CONFIG=/boot/firmware/config.txt
  [ -f "$CONFIG" ] || CONFIG=/boot/config.txt
  if ! grep -qx 'dtoverlay=disable-bt' "$CONFIG"; then
    echo 'dtoverlay=disable-bt' >> "$CONFIG"
  fi
  systemctl disable --now hciuart || true
elif [[ "$MODEL" == *"Orange Pi PC"* || "$MODEL" == *"Xunlong"* ]]; then
  echo "Placa: $MODEL"
  ENVFILE=/boot/armbianEnv.txt
  touch "$ENVFILE"
  if grep -q '^overlays=' "$ENVFILE"; then
    if ! grep '^overlays=' "$ENVFILE" | head -n1 | cut -d= -f2- | tr ' ' '\n' | grep -qx 'uart3'; then
      sed -i '/^overlays=/ s/$/ uart3/' "$ENVFILE"
    fi
  else
    echo 'overlays=uart3' >> "$ENVFILE"
  fi
else
  echo "Placa no reconocida: '$MODEL'" >&2
  exit 1
fi

echo "Reinicia la placa para aplicar el UART."
