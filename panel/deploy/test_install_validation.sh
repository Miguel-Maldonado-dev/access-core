#!/usr/bin/env bash
# Prueba (sin root) de la validación de install.sh:  bash deploy/test_install_validation.sh
set -u
source "$(dirname "${BASH_SOURCE[0]}")/lib_validate.sh"
fail=0
ok()  { if valor_valido "$1"; then echo "ok      aceptado: [$1]"; else echo "FALLO   debía aceptarse: [$1]"; fail=1; fi; }
bad() { if valor_valido "$1"; then echo "FALLO   debía rechazarse: [$1]"; fail=1; else echo "ok      rechazado: [$1]"; fi; }
ok 'secreto123'; ok 'Abc-123_xyz!#%&*'; ok 'a b'
bad 'p\ass'; bad '"x'; bad "x'"; bad ' x'; bad 'x '; bad 'a$b'; bad 'a`b'; bad ''; bad 'a
b'; bad 'x\'
tmp="$(mktemp)"; printf 'A=1' > "$tmp"; asegura_salto_final "$tmp"; printf 'B=2\n' >> "$tmp"
if [ "$(cat "$tmp")" = "$(printf 'A=1\nB=2')" ]; then echo "ok      salto final agregado"; else echo "FALLO   salto final"; fail=1; fi
printf 'A=1\n' > "$tmp"; asegura_salto_final "$tmp"; [ "$(wc -l < "$tmp")" -eq 1 ] && echo "ok      sin línea extra" || { echo "FALLO   línea extra"; fail=1; }
rm -f "$tmp"
inst="$(dirname "${BASH_SOURCE[0]}")/install.sh"
tz_line="$(grep -n 'set-timezone' "$inst" | head -n1 | cut -d: -f1)"
en_line="$(grep -n 'enable --now' "$inst" | head -n1 | cut -d: -f1)"
rs_line="$(grep -n 'systemctl restart acceso-daemon' "$inst" | head -n1 | cut -d: -f1)"
if [ -n "$tz_line" ] && [ "$tz_line" -lt "$en_line" ] && [ "$tz_line" -lt "$rs_line" ]; then echo "ok      zona horaria antes de arrancar servicios"; else echo "FALLO   zona horaria debe fijarse antes de enable/restart"; fail=1; fi
# --- agente de nube: cloud.env y unidad systemd ---
d="$(mktemp -d)"
crea_cloud_env_si_falta "$d/cloud.env" "https://nube.example.com" "mqtts://mqtt.example.com:8883"
if [ "$(cat "$d/cloud.env")" = "$(printf '# Agente de nube (acceso-cloud). Las credenciales del panel las guarda el propio agente.\nCLOUD_URL=https://nube.example.com\nMQTT_URL=mqtts://mqtt.example.com:8883')" ]; then echo "ok      cloud.env creado con CLOUD_URL y MQTT_URL"; else echo "FALLO   contenido de cloud.env"; fail=1; fi
[ "$(ls -ld "$d/cloud.env" | cut -c1-10)" = "-rw-------" ] && echo "ok      cloud.env con modo 600" || { echo "FALLO   modo de cloud.env"; fail=1; }
printf 'CLOUD_URL=otra\nCLOUD_PANEL_CODE=PNL-0123-4ABC\n' > "$d/existente.env"; chmod 640 "$d/existente.env"
crea_cloud_env_si_falta "$d/existente.env" "https://nube.example.com" "mqtts://mqtt.example.com:8883"
if [ "$(cat "$d/existente.env")" = "$(printf 'CLOUD_URL=otra\nCLOUD_PANEL_CODE=PNL-0123-4ABC')" ] && [ "$(ls -ld "$d/existente.env" | cut -c1-10)" = "-rw-r-----" ]; then echo "ok      un cloud.env existente no se toca"; else echo "FALLO   cloud.env existente modificado"; fail=1; fi
crea_cloud_env_si_falta "$d/vacio.env" "" ""
if [ "$(sed -n '2,3p' "$d/vacio.env")" = "$(printf 'CLOUD_URL=\nMQTT_URL=')" ]; then echo "ok      cloud.env vacío cuando no se indican URLs"; else echo "FALLO   cloud.env vacío"; fail=1; fi
rm -rf "$d"
unit="$(dirname "${BASH_SOURCE[0]}")/acceso-cloud.service"
for directive in 'User=acceso' 'UMask=0077' 'EnvironmentFile=/etc/acceso/acceso.env' 'EnvironmentFile=-/etc/acceso/cloud.env' \
                 'Restart=always' 'RestartSec=5' 'ExecStart=/opt/acceso/venv/bin/python -m acceso.cloud' 'WantedBy=multi-user.target'; do
  if grep -qxF "$directive" "$unit" 2>/dev/null; then echo "ok      acceso-cloud.service: $directive"; else echo "FALLO   acceso-cloud.service sin: $directive"; fail=1; fi
done
if grep -q 'install -m 644 "$PKG/deploy/acceso-cloud.service" /etc/systemd/system/acceso-cloud.service' "$inst" \
   && grep -q 'enable --now acceso-daemon acceso-web acceso-cloud' "$inst" \
   && grep -q 'systemctl restart acceso-daemon acceso-web acceso-cloud' "$inst"; then echo "ok      install.sh instala, habilita y reinicia acceso-cloud"; else echo "FALLO   install.sh no maneja acceso-cloud"; fail=1; fi
cl_line="$(grep -n 'crea_cloud_env_si_falta' "$inst" | tail -n1 | cut -d: -f1)"
if [ -n "$cl_line" ] && [ "$cl_line" -lt "$en_line" ]; then echo "ok      cloud.env se crea antes de arrancar servicios"; else echo "FALLO   cloud.env debe crearse antes de enable/restart"; fail=1; fi
# --- SIM808 por USB: validación, regla udev y GSM_PORT ---
if sim808_usb_valido 'zzzz:1'; then echo "FALLO   --sim808-usb zzzz:1 debía rechazarse"; fail=1; else echo "ok      --sim808-usb zzzz:1 rechazado"; fi
sim808_usb_valido '1a86:7523' && echo "ok      --sim808-usb 1a86:7523 aceptado" || { echo "FALLO   1a86:7523 debía aceptarse"; fail=1; }
d="$(mktemp -d)"
escribe_regla_sim808 "$(dirname "${BASH_SOURCE[0]}")/99-sim808.rules.in" "$d/99-sim808.rules" '1A86:7523'
if grep -qxF 'SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", SYMLINK+="sim808", GROUP="dialout", MODE="0660"' "$d/99-sim808.rules"; then echo "ok      regla udev del SIM808 generada"; else echo "FALLO   regla udev del SIM808"; fail=1; fi
if escribe_regla_sim808 "$(dirname "${BASH_SOURCE[0]}")/99-sim808.rules.in" "$d/mala.rules" 'zzzz:1'; then echo "FALLO   regla con VID:PID inválido"; fail=1; else echo "ok      regla rechazada con VID:PID inválido"; fi
printf 'UART_PORT=/dev/serial0\n# GSM_PORT=\n' > "$d/a.env"; fija_gsm_port_si_vacio "$d/a.env"
[ "$(sed -n 's/^GSM_PORT=//p' "$d/a.env")" = "/dev/sim808" ] && echo "ok      GSM_PORT fijado a /dev/sim808" || { echo "FALLO   GSM_PORT no fijado"; fail=1; }
printf 'GSM_PORT=\n' > "$d/b.env"; fija_gsm_port_si_vacio "$d/b.env"
[ "$(cat "$d/b.env")" = "GSM_PORT=/dev/sim808" ] && echo "ok      GSM_PORT vacío reemplazado" || { echo "FALLO   GSM_PORT vacío"; fail=1; }
printf 'GSM_PORT=/dev/ttyS1\n' > "$d/c.env"; fija_gsm_port_si_vacio "$d/c.env"
[ "$(cat "$d/c.env")" = "GSM_PORT=/dev/ttyS1" ] && echo "ok      GSM_PORT con valor no se toca" || { echo "FALLO   GSM_PORT con valor modificado"; fail=1; }
rm -rf "$d"
if grep -q -- '--sim808-usb' "$inst" && grep -q 'udevadm control --reload' "$inst"; then echo "ok      install.sh maneja --sim808-usb"; else echo "FALLO   install.sh sin --sim808-usb"; fail=1; fi
[ "$fail" -eq 0 ] && echo "TODO OK" || { echo "HAY FALLOS"; exit 1; }
