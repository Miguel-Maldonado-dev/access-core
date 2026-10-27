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
