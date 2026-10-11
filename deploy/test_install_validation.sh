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
[ "$fail" -eq 0 ] && echo "TODO OK" || { echo "HAY FALLOS"; exit 1; }
