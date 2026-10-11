#!/usr/bin/env bash
# Se ejecuta en la Mac, desde cualquier carpeta: prueba, compila y empaqueta.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> pytest"
(cd backend && .venv/bin/pytest -q)

echo "==> npm test"
(cd frontend && env -u NEXT_PUBLIC_API_BASE npm test)

echo "==> npm run build"
(cd frontend && env -u NEXT_PUBLIC_API_BASE npm run build)

echo "==> copiando la interfaz a backend/acceso/web/static"
rm -rf backend/acceso/web/static
mkdir -p backend/acceso/web/static
cp -R frontend/out/. backend/acceso/web/static/

echo "==> fijando versiones en backend/constraints.txt"
backend/.venv/bin/pip freeze --exclude-editable | grep -vi '^acceso-panel' > backend/constraints.txt

echo "==> empaquetando"
mkdir -p dist
OUT="dist/acceso-panel-$(date +%Y%m%d).tar.gz"
# COPYFILE_DISABLE evita los archivos ._* de macOS dentro del tar.
COPYFILE_DISABLE=1 tar czf "$OUT" \
  --exclude='.venv' \
  --exclude='backend/.env' \
  --exclude='data' \
  --exclude='__pycache__' \
  --exclude='.pytest_cache' \
  --exclude='*.egg-info' \
  --exclude='.superpowers' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  backend deploy README.md

echo "Paquete listo: $ROOT/$OUT"
