# Funciones compartidas por install.sh y su prueba (se cargan con `source`).

# Devuelve 0 si el valor es seguro para el .env de systemd (EnvironmentFile).
# Rechaza: \  "  '  $  `  saltos de línea y espacios al inicio o al final.
valor_valido() {
  local v="$1"
  [ -n "$v" ] || return 1
  case "$v" in
    *\\*|*\"*|*\'*|*\$*|*\`*|*$'\n'*|*$'\r'*) return 1 ;;
    " "*|*" "|$'\t'*|*$'\t') return 1 ;;
  esac
  return 0
}

MSG_VALOR_INVALIDO='Valor no válido: no uses los caracteres \ " '"'"' $ ` ni espacios al inicio o al final, y no lo dejes vacío.'

# Agrega un salto de línea final al archivo si le falta.
asegura_salto_final() {
  local f="$1"
  [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && printf '\n' >> "$f"
  return 0
}

# Crea el archivo de configuración del agente de nube solo si no existe; si existe, no lo toca.
# Uso: crea_cloud_env_si_falta RUTA CLOUD_URL MQTT_URL [DUEÑO:GRUPO]
# El agente guarda aquí su credencial, así que el archivo es del usuario acceso y de modo 600.
crea_cloud_env_si_falta() {
  local f="$1" cloud_url="$2" mqtt_url="$3" owner="${4:-}"
  [ -e "$f" ] && return 0
  local old_umask
  old_umask="$(umask)"
  umask 077
  {
    printf '%s\n' '# Agente de nube (acceso-cloud). Las credenciales del panel las guarda el propio agente.'
    printf 'CLOUD_URL=%s\n' "$cloud_url"
    printf 'MQTT_URL=%s\n' "$mqtt_url"
  } > "$f"
  umask "$old_umask"
  chmod 600 "$f"
  if [ -n "$owner" ]; then chown "$owner" "$f"; fi
  return 0
}
