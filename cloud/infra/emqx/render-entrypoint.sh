#!/usr/bin/env bash
# Entrypoint del contenedor EMQX: genera /opt/emqx/etc/emqx.conf a partir de la plantilla montada
# (emqx.conf del repositorio) y arranca EMQX. EMQX 5.8 no sustituye variables de entorno en HOCON,
# así que aquí se reemplazan los marcadores sin comillas de APP_URL y del secreto del webhook por
# cadenas HOCON con el valor del entorno (con " y \ escapados). Los marcadores entre comillas del
# usuario, el clientid y la contraseña son de EMQX y no se tocan. Los valores con caracteres de
# control (saltos de línea incluidos) se rechazan: inyectarían configuración.
set -euo pipefail

TEMPLATE=/opt/emqx/etc/emqx.template.conf
OUT=/opt/emqx/etc/emqx.conf

for nombre in APP_URL EMQX_WEBHOOK_SECRET; do
  if [ -z "${!nombre:-}" ]; then
    echo "render-entrypoint: falta la variable $nombre" >&2
    exit 1
  fi
  if [[ "${!nombre}" =~ [[:cntrl:]] ]]; then
    echo "render-entrypoint: $nombre contiene caracteres de control (p. ej. un salto de línea); corrige el .env" >&2
    exit 1
  fi
done
# Sin barra final: emqx.conf agrega "/api/mqtt/auth" y "/api/mqtt/events".
APP_URL="${APP_URL%/}"
# EMQX exige TLS explícito en las conexiones https hacia la aplicación.
case "$APP_URL" in
  https://*) APP_TLS=true ;;
  http://*) APP_TLS=false ;;
  *) echo "render-entrypoint: APP_URL debe empezar con http:// o https://" >&2; exit 1 ;;
esac
export APP_URL EMQX_WEBHOOK_SECRET APP_TLS

# El archivo renderizado lleva el secreto: solo lo lee el usuario de EMQX (el mismo que lo escribe).
umask 077
perl -pe 's/\$\{(APP_URL|EMQX_WEBHOOK_SECRET)\}/my $v = $ENV{$1}; $v =~ s{(["\\])}{\\$1}g; qq("$v")/ge; s/\$\{APP_TLS\}/$ENV{APP_TLS}/g' \
  "$TEMPLATE" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
umask 022

exec /usr/bin/docker-entrypoint.sh /opt/emqx/bin/emqx foreground
